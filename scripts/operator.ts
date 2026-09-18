/**
 * A scripted operator for demos and CI. It watches the operator console's
 * JSON API and resolves interventions the way a person would: approving or
 * denying irreversible steps, and for takeovers, working the live session
 * through the remote-hands endpoint and handing control back.
 *
 * Playbooks are deliberately explicit. A real operator console would show a
 * person the same information and let them decide.
 *
 *   npx tsx scripts/operator.ts approve                      approve every approval request
 *   npx tsx scripts/operator.ts deny                         deny every approval request
 *   npx tsx scripts/operator.ts attest                       clear the Compliance Attestation dialog, hand back
 *   npx tsx scripts/operator.ts supervisor                   enter the supervisor PIN and apply the override, hand back
 *   npx tsx scripts/operator.ts abort                        take control and abort
 * Options: --console http://localhost:4700  --once (exit after one intervention)  --pin 2468  --initials AT
 */
import { parseArgs } from "node:util";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { console: { type: "string", default: "http://localhost:4700" }, once: { type: "boolean", default: false }, pin: { type: "string" }, initials: { type: "string", default: "AT" }, timeout: { type: "string", default: "600" } },
});
const playbook = positionals[0] ?? "approve";
const api = `${flags.console}/api/interventions`;
type Intervention = { id: string; kind: "approval" | "takeover"; state: string; reason: string; atStep?: string };

const post = (id: string, op: string, body: unknown = {}) =>
  fetch(`${api}/${id}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(`${op}: ${j.error}`);
    return j;
  });
const refOf = (tree: string, role: string, name: string): string => {
  const m = tree.match(new RegExp(`${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" \\[(e\\d+)\\]`));
  if (!m) throw new Error(`no ${role} "${name}" on the live screen`);
  return m[1]!;
};

async function handle(it: Intervention) {
  console.log(`${new Date().toISOString()}  ${it.id}  ${it.kind}  at ${it.atStep ?? "-"}: ${it.reason}`);
  if (it.kind === "approval") {
    const decision = playbook === "deny" ? "denied" : "approved";
    await post(it.id, "decide", { decision });
    console.log(`  ${decision}`);
    return;
  }
  await post(it.id, "take");
  console.log("  took control of the live session");
  if (playbook === "abort") { await post(it.id, "handback", { resolution: "abort" }); console.log("  handed back: abort"); return; }
  let screen = (await post(it.id, "observe")) as { tree: string };
  if (playbook === "attest") {
    await post(it.id, "act", { kind: "type", ref: refOf(screen.tree, "textbox", "Operator initials"), text: flags.initials });
    screen = await post(it.id, "observe");
    await post(it.id, "act", { kind: "click", ref: refOf(screen.tree, "button", "Attest") });
    console.log("  attested");
  } else if (playbook === "supervisor") {
    const pin = flags.pin ?? process.env.SUPERVISOR_PIN;
    if (!pin) throw new Error("supervisor playbook needs --pin or SUPERVISOR_PIN");
    await post(it.id, "act", { kind: "type", ref: refOf(screen.tree, "textbox", "Supervisor PIN"), text: pin });
    screen = await post(it.id, "observe");
    await post(it.id, "act", { kind: "click", ref: refOf(screen.tree, "button", "Apply Override") });
    console.log("  override applied");
  } else {
    throw new Error(`unknown playbook "${playbook}"`);
  }
  await post(it.id, "handback", { resolution: "retry_step" });
  console.log("  handed back: retry_step");
}

const seen = new Set<string>();
const deadline = Date.now() + Number(flags.timeout) * 1000;
console.log(`operator: playbook "${playbook}", watching ${api}`);
while (Date.now() < deadline) {
  let list: { interventions: Intervention[] } | undefined;
  try { list = await (await fetch(api)).json(); } catch { await new Promise((r) => setTimeout(r, 500)); continue; }
  const open = list!.interventions.find((i) => i.state === "open" && !seen.has(i.id));
  if (open) {
    seen.add(open.id);
    try { await handle(open); } catch (e) { console.error(`  failed: ${(e as Error).message}`); }
    if (flags.once) break;
  }
  await new Promise((r) => setTimeout(r, 300));
}

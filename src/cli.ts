#!/usr/bin/env node
/**
 * hands: discover a UI flow once with a model, save it as a capability,
 * replay it deterministically, escalate to a person when stuck.
 */
import { parseArgs } from "node:util";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadGoal } from "./discovery/goal.js";
import { Planner } from "./discovery/planner.js";
import { discover } from "./discovery/loop.js";
import { compile } from "./discovery/compile.js";
import { replay } from "./replay/engine.js";
import { bootstrap, findCapability, listCapabilities, saveCapability } from "./runtime.js";
import { catalogSummary, toolDefinition } from "./agent/catalog.js";
import type { Capability } from "./schema/capability.js";
import type { ReplayResult } from "./schema/result.js";

const USAGE = `usage:
  hands discover <goal.json> [--headed] [--model <id>] [--no-vision]
  hands replay <capability|name> --input k=v [--input k=v] [--headed] [--allow-draft] [--label <text>]
  hands invoke <name> --args '{"k":"v"}'            replay by name; prints the result contract as JSON
  hands verify <capability|name> [--headed]         replay with the discovery inputs; a pass marks it verified
  hands approve <capability|name>                   mark a verified capability approved for unattended replay
  hands stability <capability|name> --n 5 --input k=v
  hands catalog [--tools]                           list capabilities; --tools prints tool definitions for an agent
  hands agent "<request>"                           let a model pick and invoke a capability from the catalog

The target app: npm run target   (Meridian CoreSuite on http://localhost:4100)
Operator console: printed at the start of every run (default http://localhost:4700)`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    headed: { type: "boolean", default: false },
    model: { type: "string" },
    "no-vision": { type: "boolean", default: false },
    input: { type: "string", multiple: true, default: [] },
    args: { type: "string" },
    "allow-draft": { type: "boolean", default: false },
    label: { type: "string" },
    n: { type: "string", default: "5" },
    tools: { type: "boolean", default: false },
    port: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, ...rest] = positionals;
const inputsFromFlags = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const kv of flags.input) { const i = kv.indexOf("="); if (i < 0) throw new Error(`--input expects k=v, got "${kv}"`); out[kv.slice(0, i)] = kv.slice(i + 1); }
  if (flags.args) Object.assign(out, JSON.parse(flags.args));
  return out;
};
const consolePort = flags.port ? Number(flags.port) : undefined;

async function main() {
  if (flags.help || !command) { console.log(USAGE); return; }
  switch (command) {
    case "discover": return cmdDiscover(rest[0]!);
    case "replay": return void (await cmdReplay(rest[0]!, inputsFromFlags(), { allowDraft: flags["allow-draft"], label: flags.label }));
    case "invoke": { const r = await cmdReplay(rest[0]!, inputsFromFlags(), { quiet: true, label: "invoke" }); console.log(JSON.stringify(r, null, 2)); return; }
    case "verify": return cmdVerify(rest[0]!);
    case "approve": return cmdApprove(rest[0]!);
    case "stability": return cmdStability(rest[0]!, inputsFromFlags(), Number(flags.n));
    case "catalog": return cmdCatalog();
    case "agent": return cmdAgent(rest.join(" "));
    default: console.error(`unknown command "${command}"\n\n${USAGE}`); process.exitCode = 2;
  }
}

// ---------- discover ----------

async function cmdDiscover(goalPath: string) {
  if (!goalPath) throw new Error("discover needs a goal file");
  const spec = loadGoal(goalPath);
  const rt = await bootstrap({ policyPath: spec.policy, kind: "discovery", name: spec.name, headed: flags.headed, goal: spec.goal, consolePort });
  const planner = new Planner(spec, rt.redactor, { model: flags.model, vision: !flags["no-vision"] });
  banner(`discovery · ${spec.name}`, [`goal      ${spec.goal}`, `model     ${planner.model}`, `evidence  ${rt.log.dir}`, `console   ${rt.console.url}`]);
  rt.log.event("run.started", { goal: spec.goal, entry: spec.entry, model: planner.model, inputs: spec.discoveryInputs, policy: rt.policy.id });
  watchInterventions(rt);

  try {
    const trace = await discover({ spec, surface: rt.surface, guard: rt.guard, redactor: rt.redactor, log: rt.log, control: rt.control, planner, secrets: process.env });
    rt.log.write("transcript.json", planner.transcript);
    if (trace.status !== "completed") {
      rt.log.finish({ status: trace.status, failure: trace.failure, steps: trace.steps, usage: trace.usage });
      console.error(`\ndiscovery ${trace.status}: ${trace.failure}`);
      process.exitCode = 1;
      return;
    }
    const cap = compile(spec, trace, { runId: rt.log.id, model: planner.model, surfaceDriver: rt.surface.driver, evidence: rt.log.dir });
    const file = saveCapability(cap);
    rt.log.write("capability.json", cap);
    rt.log.finish({ status: "compiled", capability: file, steps: cap.steps.length, recoveries: cap.recoveries.length, outcomes: Object.keys(cap.outcomes).length, modelSteps: trace.steps, usage: trace.usage, escalations: trace.escalations.length });
    console.log(`\ncompiled ${cap.name} v${cap.version}: ${cap.steps.length} steps, ${cap.recoveries.length} recoveries, ${Object.keys(cap.outcomes).length} outcomes, ${cap.escalations.length} escalations`);
    console.log(`saved     ${file}`);
    console.log(`tokens    in ${trace.usage.input + trace.usage.cacheRead + trace.usage.cacheWrite} (cache read ${trace.usage.cacheRead}) · out ${trace.usage.output}`);
    console.log(`next      bin/hands verify ${cap.name}`);
  } finally {
    await rt.close();
  }
}

// ---------- replay ----------

async function cmdReplay(ref: string, inputs: Record<string, unknown>, opts: { allowDraft?: boolean; quiet?: boolean; label?: string } = {}): Promise<ReplayResult> {
  if (!ref) throw new Error("replay needs a capability file or name");
  const { file, cap } = findCapability(ref);
  const name = opts.label ? `${cap.name}-${opts.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : cap.name;
  const rt = await bootstrap({ policyPath: policyFor(cap), kind: "replay", name, headed: flags.headed, capability: `${cap.name} v${cap.version}`, consolePort });
  if (!opts.quiet) banner(`replay · ${cap.name} v${cap.version} (${cap.status})`, [`inputs    ${JSON.stringify(inputs)}`, `evidence  ${rt.log.dir}`, `console   ${rt.console.url}`]);
  watchInterventions(rt, opts.quiet);
  try {
    const result = await replay({ capability: cap, inputs, surface: rt.surface, guard: rt.guard, redactor: rt.redactor, log: rt.log, control: rt.control, secrets: process.env, allowDraft: opts.allowDraft });
    cap.stats = { replays: cap.stats.replays + 1, succeeded: cap.stats.succeeded + (result.status === "succeeded" || result.status === "outcome" ? 1 : 0), lastReplayAt: result.finishedAt };
    saveCapability(cap, path.dirname(file));
    if (!opts.quiet) printResult(result);
    if (result.status === "failed") process.exitCode = 1;
    return result;
  } finally {
    await rt.close();
  }
}

function printResult(r: ReplayResult) {
  const lines = [`status    ${r.status}`];
  if (r.outputs) lines.push(`outputs   ${JSON.stringify(r.outputs)}`);
  if (r.outcome) lines.push(`outcome   ${r.outcome.code}: ${r.outcome.description}`);
  if (r.failure) lines.push(`failure   ${r.failure.class} at ${r.failure.atStep ?? "-"}: ${r.failure.message}`, `expected  ${r.failure.expected ?? "-"}`, `observed  ${r.failure.observed ?? "-"}`, `evidence  ${r.failure.evidence?.screenshot ?? "-"}`);
  if (r.recoveries.length) lines.push(`recovered ${r.recoveries.map((x) => `${x.id}@${x.atStep}`).join(", ")}`);
  if (r.drift.length) lines.push(`drift     ${r.drift.map((d) => `${d.step}: ${d.primary} -> ${d.used}`).join("; ")}`);
  if (r.escalations.length) lines.push(`escalated ${r.escalations.map((e) => `${e.id} (${e.kind}, ${e.resolution}, ${e.humanActions} human actions)`).join("; ")}`);
  lines.push(`steps     ${r.stepsCompleted} completed in ${(r.durationMs / 1000).toFixed(1)}s`);
  console.log("\n" + lines.join("\n"));
}

async function cmdVerify(ref: string) {
  const { file, cap } = findCapability(ref);
  const inputs = discoveryInputsFor(cap);
  const r = await cmdReplay(file, inputs, { allowDraft: true, label: "verify" });
  if (r.status === "succeeded" && cap.status === "draft") {
    const fresh = findCapability(file).cap;
    fresh.status = "verified";
    saveCapability(fresh, path.dirname(file));
    console.log(`\n${cap.name} v${cap.version} is now verified. Review it, then: bin/hands approve ${cap.name}`);
  }
}

async function cmdApprove(ref: string) {
  const { file, cap } = findCapability(ref);
  if (cap.status === "draft") throw new Error(`${cap.name} v${cap.version} has not been verified; run bin/hands verify first`);
  cap.status = "approved";
  saveCapability(cap, path.dirname(file));
  console.log(`${cap.name} v${cap.version} approved for unattended replay (${file})`);
}

async function cmdStability(ref: string, inputs: Record<string, unknown>, n: number) {
  const { cap } = findCapability(ref);
  const runs: ReplayResult[] = [];
  for (let i = 1; i <= n; i++) {
    console.log(`\nrun ${i}/${n}`);
    runs.push(await cmdReplay(ref, Object.keys(inputs).length ? inputs : discoveryInputsFor(cap), { allowDraft: true, quiet: true, label: `stability-${i}` }));
    console.log(`  ${runs[i - 1]!.status}${runs[i - 1]!.failure ? ` (${runs[i - 1]!.failure!.class})` : ""} · ${runs[i - 1]!.durationMs}ms · drift ${runs[i - 1]!.drift.length} · recoveries ${runs[i - 1]!.recoveries.length}`);
  }
  const ok = runs.filter((r) => r.status === "succeeded" || r.status === "outcome").length;
  const ms = runs.map((r) => r.durationMs).sort((a, b) => a - b);
  console.log(`\nstability ${ok}/${n} (${Math.round((100 * ok) / n)}%) · p50 ${ms[Math.floor(ms.length / 2)]}ms · max ${ms.at(-1)}ms · drift events ${runs.reduce((a, r) => a + r.drift.length, 0)}`);
  process.exitCode = ok === n ? 0 : 1;
}

// ---------- catalog and agent ----------

function cmdCatalog() {
  const caps = listCapabilities().map((c) => c.cap);
  if (!caps.length) { console.log("no capabilities yet; run discover"); return; }
  if (flags.tools) { console.log(JSON.stringify(caps.map(toolDefinition), null, 2)); return; }
  console.log(catalogSummary(caps));
}

/**
 * Stretch: an agent that only knows the catalog. The model chooses a capability
 * and its arguments; the capability runs as a deterministic replay; the model
 * summarises the structured result. No model in the replay itself.
 */
async function cmdAgent(request: string) {
  if (!request) throw new Error('agent needs a request, e.g. hands agent "What is the savings balance for member 10042?"');
  const caps = listCapabilities().map((c) => c.cap).filter((c) => c.status === "approved" || c.status === "verified");
  if (!caps.length) throw new Error("no verified or approved capabilities in the catalog");
  const client = new Anthropic();
  const model = flags.model ?? process.env.HANDS_MODEL ?? "claude-opus-5";
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: request }];
  console.log(`agent     ${model} · catalog: ${caps.map((c) => c.name).join(", ")}`);
  for (let turn = 0; turn < 4; turn++) {
    const res = await client.messages.create({
      model, max_tokens: 2000,
      system: "You are a back-office assistant for a credit union. You can only act through the tools provided, each of which drives a legacy application deterministically. Call a tool when the request needs one; report the structured result plainly, including business outcomes like not-found. Never invent balances.",
      tools: caps.map(toolDefinition), messages,
    });
    messages.push({ role: "assistant", content: res.content });
    const use = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!use) { console.log("\n" + res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n")); return; }
    console.log(`\ncalls     ${use.name}(${JSON.stringify(use.input)})`);
    const result = await cmdReplay(use.name, use.input as Record<string, unknown>, { quiet: true, label: "agent" });
    const summary = { status: result.status, outputs: result.outputs, outcome: result.outcome, failure: result.failure && { class: result.failure.class, message: result.failure.message }, evidence: result.evidenceDir };
    console.log(`returns   ${JSON.stringify(summary)}`);
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(summary) }] });
  }
}

// ---------- helpers ----------

function policyFor(cap: Capability): string {
  const p = process.env.HANDS_POLICY ?? path.join("policies", `${cap.app.id}.json`);
  return p;
}
function discoveryInputsFor(cap: Capability): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cap.inputs)) if (v.example) out[k] = v.example;
  return out;
}
function banner(title: string, lines: string[]) {
  console.log(`\n${title}\n${"-".repeat(title.length)}\n${lines.join("\n")}\n`);
}
function watchInterventions(rt: Awaited<ReturnType<typeof bootstrap>>, quiet = false) {
  const seen = new Set<string>();
  const timer = setInterval(() => {
    for (const it of rt.control.list()) {
      if (seen.has(it.id) || it.state === "resolved") continue;
      seen.add(it.id);
      if (!quiet) console.log(`\n${it.kind === "approval" ? "approval needed" : "intervention"}  ${it.id}: ${it.reason}\n                open ${rt.console.url}/i/${it.id}\n`);
    }
  }, 300);
  timer.unref();
}

main().catch((e) => { console.error(`error: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });

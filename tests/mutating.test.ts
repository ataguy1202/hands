/**
 * The mutating flow: an irreversible step behind an approval, a native
 * confirm answered as part of the step, a validation outcome, a supervisor
 * takeover, and the two ways policy can stop the action.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { startMeridian } from "../target/server.js";
import { GoalSpec, type GoalSpec as Goal } from "../src/discovery/goal.js";
import { discover, type PlannerLike } from "../src/discovery/loop.js";
import { compile } from "../src/discovery/compile.js";
import { replay } from "../src/replay/engine.js";
import { bootstrap, type Runtime } from "../src/runtime.js";
import type { Capability } from "../src/schema/capability.js";
import type { Observation } from "../src/surface/types.js";
import type { PlannerTurn } from "../src/discovery/planner.js";

const PORT = 4198;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.resolve(".scratch/test-mutating");
const secrets = { MERIDIAN_USER: "operator", MERIDIAN_PASSWORD: "meridian1" };
let server: http.Server;
let goal: Goal;
let policyPath: string;
let blockPolicyPath: string;
let consolePort = 4850;

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  server = await startMeridian(PORT);
  const policy = JSON.parse(fs.readFileSync("policies/meridian-coresuite.json", "utf8"));
  policy.allowedOrigins = [BASE];
  policy.escalation.timeoutMs = 30_000;
  policyPath = path.join(ROOT, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy));
  blockPolicyPath = path.join(ROOT, "policy-block.json");
  fs.writeFileSync(blockPolicyPath, JSON.stringify({ ...policy, irreversible: { ...policy.irreversible, mode: "block" } }));
  const raw = JSON.parse(fs.readFileSync("goals/open_holiday_club_sub_account.json", "utf8"));
  goal = GoalSpec.parse({ ...raw, entry: `${BASE}/login`, policy: policyPath });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function scriptedPlanner(): PlannerLike {
  const extracted = new Set<string>();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let n = 0;
  const turn = (decision: PlannerTurn["decision"]): PlannerTurn => ({ decision, toolUseId: `scripted_${++n}`, usage });
  return {
    model: "scripted-planner", transcript: [],
    async next(obs: Observation) {
      const find = (role: string, name: string) => obs.nodes.find((x) => x.role === role && x.name === name);
      const has = (text: string) => obs.nodes.some((x) => x.text === text);
      if (obs.dialog) return turn({ tool: "dialog", respond: "accept", note: "confirm opening the account" });
      const uid = find("textbox", "Operator ID"), pwd = find("textbox", "Password");
      if (uid && !uid.value) return turn({ tool: "type", ref: uid.ref, secret: "MERIDIAN_USER", note: "enter operator id" });
      if (pwd && !pwd.value) return turn({ tool: "type", ref: pwd.ref, secret: "MERIDIAN_PASSWORD", note: "enter password" });
      if (find("button", "Sign On")) return turn({ tool: "click", ref: find("button", "Sign On")!.ref, note: "sign on" });
      if (find("dialog", "System Notice")) return turn({ tool: "click", ref: find("button", "Continue")!.ref, note: "acknowledge notice" });
      if (has("Sub-Account Opened")) {
        if (!extracted.has("confirmationNumber")) { extracted.add("confirmationNumber"); return turn({ tool: "extract", ref: obs.nodes.find((x) => x.role === "cell" && x.anchor === "Confirmation Number")!.ref, output: "confirmationNumber", parse: "text", note: "read confirmation" }); }
        if (!extracted.has("shareId")) { extracted.add("shareId"); return turn({ tool: "extract", ref: obs.nodes.find((x) => x.role === "cell" && x.anchor === "Share ID")!.ref, output: "shareId", parse: "text", note: "read share id" }); }
        return turn({ tool: "done", checkpointText: "Sub-Account Opened", note: "confirmation reached" });
      }
      const type = find("combobox", "Share Type");
      if (type) {
        if (type.value !== "S20 Holiday Club") return turn({ tool: "select", ref: type.ref, option: "S20 Holiday Club", note: "choose holiday club" });
        const nick = find("textbox", "Nickname"), dep = find("textbox", "Initial Deposit");
        if (nick && !nick.value) return turn({ tool: "type", ref: nick.ref, param: "nickname", note: "enter nickname" });
        if (dep && !dep.value) return turn({ tool: "type", ref: dep.ref, param: "initialDeposit", note: "enter deposit" });
        return turn({ tool: "click", ref: find("button", "Open Account")!.ref, note: "open the account" });
      }
      if (find("link", "Open Sub-Account")) return turn({ tool: "click", ref: find("link", "Open Sub-Account")!.ref, note: "go to the sub-account form" });
      const mbr = find("textbox", "Member Number");
      if (mbr && !mbr.value) return turn({ tool: "type", ref: mbr.ref, param: "memberId", note: "enter member number" });
      if (mbr && mbr.value) return turn({ tool: "click", ref: find("button", "Search")!.ref, note: "search" });
      if (find("link", "Member Inquiry")) return turn({ tool: "click", ref: find("link", "Member Inquiry")!.ref, note: "open member inquiry" });
      return turn({ tool: "escalate", reason: "scripted planner is lost" });
    },
  };
}

type Op = { id: string; kind: string; state: string; reason: string };
/** A scripted operator that watches the console API and applies a decision. */
async function operator(port: number, decide: (it: Op, post: (op: string, body?: unknown) => Promise<any>) => Promise<void>) {
  const api = `http://localhost:${port}/api/interventions`;
  const seen = new Set<string>();
  for (let i = 0; i < 600; i++) {
    let list: { interventions: Op[] } | undefined;
    try { list = await (await fetch(api)).json(); } catch { break; }
    const open = list!.interventions.find((x) => x.state === "open" && !seen.has(x.id));
    if (open) {
      seen.add(open.id);
      await decide(open, (op, body = {}) => fetch(`${api}/${open.id}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()));
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runtime(kind: "discovery" | "replay", name: string, extra: Partial<Parameters<typeof bootstrap>[0]> = {}): Promise<Runtime> {
  return bootstrap({ policyPath, kind, name, evidenceRoot: path.join(ROOT, "evidence"), consolePort: consolePort++, ...extra });
}
async function run(cap: Capability, inputs: Record<string, unknown>, name: string, op: Parameters<typeof operator>[1], policy = policyPath) {
  const port = consolePort;
  const rt = await runtime("replay", name, { capability: cap.name, policyPath: policy });
  const watcher = operator(port, op);
  try {
    const result = await replay({ capability: cap, inputs, surface: rt.surface, guard: rt.guard, redactor: rt.redactor, log: rt.log, control: rt.control, secrets, allowDraft: true });
    return result;
  } finally { await rt.close(); await watcher; }
}
const approveAll: Parameters<typeof operator>[1] = async (it, post) => { if (it.kind === "approval") await post("decide", { decision: "approved" }); };

let cap: Capability;

describe("mutating capability", () => {
  it("is discovered behind a single approval and compiles as mutating with the dialog attached to the click", async () => {
    const port = consolePort;
    const rt = await runtime("discovery", goal.name, { goal: goal.goal });
    const watcher = operator(port, approveAll);
    try {
      const trace = await discover({ spec: goal, surface: rt.surface, guard: rt.guard, redactor: rt.redactor, log: rt.log, control: rt.control, planner: scriptedPlanner(), secrets });
      expect(trace.status, trace.failure).toBe("completed");
      cap = compile(goal, trace, { runId: rt.log.id, model: "scripted", surfaceDriver: rt.surface.driver, evidence: rt.log.dir });
      rt.log.write("capability.json", cap);
      rt.log.finish({ status: "compiled" });
      expect(rt.control.list().filter((i) => i.kind === "approval")).toHaveLength(1);
    } finally { await rt.close(); await watcher; }

    expect(cap.policy.effect).toBe("mutating");
    const open = cap.steps.find((s) => s.action === "click" && s.risk === "irreversible") as Extract<Capability["steps"][number], { action: "click" }>;
    expect(open.target.describe).toBe('button "Open Account"');
    expect(open.dialog).toMatchObject({ type: "confirm", respond: "accept" });
    expect(open.dialog!.pattern).toContain("cannot be undone");
    expect(open.dialog!.pattern).not.toContain("10077");
    expect(cap.policy.irreversibleSteps).toEqual([open.id]);
    const select = cap.steps.find((s) => s.action === "select") as Extract<Capability["steps"][number], { action: "select" }>;
    expect(select.value).toEqual({ kind: "literal", value: "S20 Holiday Club" });
    expect(JSON.stringify(cap.steps)).not.toContain("Vacation");
    const conf = cap.steps.find((s) => s.action === "extract" && s.output === "confirmationNumber") as Extract<Capability["steps"][number], { action: "extract" }>;
    expect(conf.target.strategies[0]).toMatchObject({ kind: "anchor", text: "Confirmation Number" });
  });

  it("replays with an approval, answers the confirm, and returns the confirmation", async () => {
    const result = await run(cap, { memberId: "10042", nickname: "Trip", initialDeposit: "40.00" }, "success", approveAll);
    expect(result.status, JSON.stringify(result.failure)).toBe("succeeded");
    expect(result.outputs?.confirmationNumber).toMatch(/^C[A-Z0-9]+$/);
    expect(result.outputs?.shareId).toMatch(/^S2\d$/);
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0]).toMatchObject({ kind: "approval", resolution: "approved" });
  });

  it("reports a rejected deposit as a business outcome", async () => {
    const result = await run(cap, { memberId: "10042", nickname: "Tiny", initialDeposit: "2.00" }, "below-min", approveAll);
    expect(result.status).toBe("outcome");
    expect(result.outcome?.code).toBe("DEPOSIT_BELOW_MINIMUM");
  });

  it("stops when the operator denies the irreversible step", async () => {
    const result = await run(cap, { memberId: "10042", nickname: "Nope", initialDeposit: "10.00" }, "denied", async (it, post) => { if (it.kind === "approval") await post("decide", { decision: "denied" }); });
    expect(result.status).toBe("failed");
    expect(result.failure?.class).toBe("policy_blocked");
    expect(result.failure?.message).toContain("denied");
  });

  it("never reaches the click when policy blocks irreversible actions", async () => {
    const result = await run(cap, { memberId: "10042", nickname: "Blocked", initialDeposit: "10.00" }, "blocked", approveAll, blockPolicyPath);
    expect(result.failure?.class).toBe("policy_blocked");
    expect(result.escalations).toHaveLength(0);
  });

  it("escalates a permission denial to a supervisor who overrides in the live session", async () => {
    const result = await run(cap, { memberId: "40001", nickname: "Override", initialDeposit: "15.00" }, "supervisor", async (it, post) => {
      if (it.kind === "approval") { await post("decide", { decision: "approved" }); return; }
      expect(it.reason).toMatch(/supervisor override/i);
      await post("take");
      const screen = (await post("observe")) as { tree: string };
      const pin = screen.tree.match(/textbox "Supervisor PIN" \[(e\d+)\]/)![1];
      await post("act", { kind: "type", ref: pin, text: "2468" });
      const after = (await post("observe")) as { tree: string };
      const apply = after.tree.match(/button "Apply Override" \[(e\d+)\]/)![1];
      await post("act", { kind: "click", ref: apply });
      await post("handback", { resolution: "retry_step" });
    });
    expect(result.status, JSON.stringify(result.failure)).toBe("succeeded");
    expect(result.escalations.map((e) => e.kind)).toEqual(["takeover", "approval"]);
    expect(result.escalations[0]!.humanActions).toBeGreaterThanOrEqual(2);
    expect(result.outputs?.shareId).toMatch(/^S2\d$/);
  });
});

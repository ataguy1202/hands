/**
 * End to end against the mock core, with a scripted planner standing in for
 * the model. Proves discovery recording, compilation, deterministic replay,
 * outcomes, recoveries, escalation with a scripted operator, and the input
 * and status gates, without spending a token.
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

const PORT = 4199;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.resolve(".scratch/test");
const secrets = { MERIDIAN_USER: "operator", MERIDIAN_PASSWORD: "meridian1" };
let server: http.Server;
let goal: Goal;
let policyPath: string;
let consolePort = 4790;

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  server = await startMeridian(PORT);
  const policy = JSON.parse(fs.readFileSync("policies/meridian-coresuite.json", "utf8"));
  policy.allowedOrigins = [BASE];
  policy.escalation.timeoutMs = 30_000;
  policyPath = path.join(ROOT, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy));
  const raw = JSON.parse(fs.readFileSync("goals/lookup_member_savings_balance.json", "utf8"));
  goal = GoalSpec.parse({ ...raw, entry: `${BASE}/login`, policy: policyPath });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const faults = (body: Record<string, unknown>) => fetch(`${BASE}/__faults`, { method: "POST", body: JSON.stringify(body) });
const clearFaults = () => fetch(`${BASE}/__faults`, { method: "DELETE" });

/** Plays the model's part for the lookup goal, deciding from the observation alone. */
function scriptedPlanner(): PlannerLike {
  const extracted = new Set<string>();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let n = 0;
  const turn = (decision: PlannerTurn["decision"]): PlannerTurn => ({ decision, toolUseId: `scripted_${++n}`, reasoning: "scripted", usage });
  return {
    model: "scripted-planner",
    transcript: [],
    async next(obs: Observation) {
      const find = (role: string, name: string) => obs.nodes.find((x) => x.role === role && x.name === name);
      if (obs.dialog) return turn({ tool: "dialog", respond: "accept", note: "answer the dialog" });
      const uid = find("textbox", "Operator ID"), pwd = find("textbox", "Password");
      if (uid && !uid.value) return turn({ tool: "type", ref: uid.ref, secret: "MERIDIAN_USER", note: "enter operator id" });
      if (pwd && !pwd.value) return turn({ tool: "type", ref: pwd.ref, secret: "MERIDIAN_PASSWORD", note: "enter password" });
      if (find("button", "Sign On")) return turn({ tool: "click", ref: find("button", "Sign On")!.ref, note: "sign on" });
      if (find("dialog", "System Notice")) return turn({ tool: "click", ref: find("button", "Continue")!.ref, note: "acknowledge the maintenance notice" });
      const mbr = find("textbox", "Member Number");
      if (mbr && !mbr.value) return turn({ tool: "type", ref: mbr.ref, param: "memberId", note: "enter the member number" });
      if (mbr && mbr.value) return turn({ tool: "click", ref: find("button", "Search")!.ref, note: "search" });
      if (find("link", "Member Inquiry") && !obs.nodes.some((x) => x.text === "Member Detail")) return turn({ tool: "click", ref: find("link", "Member Inquiry")!.ref, note: "open member inquiry" });
      if (obs.nodes.some((x) => x.text === "Member Detail")) {
        if (!extracted.has("memberName")) { extracted.add("memberName"); return turn({ tool: "extract", ref: obs.nodes.find((x) => x.role === "cell" && x.anchor === "Name")!.ref, output: "memberName", parse: "text", note: "read the name" }); }
        if (!extracted.has("savingsBalance")) { extracted.add("savingsBalance"); return turn({ tool: "extract", ref: obs.nodes.find((x) => x.cell?.column === "Current Balance" && x.cell.rowText.includes("Regular Savings"))!.ref, output: "savingsBalance", parse: "money", note: "read S01 balance" }); }
        return turn({ tool: "done", checkpointText: "Member Detail", note: "goal reached", outcomes: [{ code: "MEMBER_NOT_FOUND", description: "no such member", textPattern: "No member found" }] });
      }
      return turn({ tool: "escalate", reason: "scripted planner is lost" });
    },
  };
}

async function runtime(kind: "discovery" | "replay", name: string, extra: Partial<Parameters<typeof bootstrap>[0]> = {}): Promise<Runtime> {
  return bootstrap({ policyPath, kind, name, evidenceRoot: path.join(ROOT, "evidence"), consolePort: consolePort++, ...extra });
}

async function replayWith(cap: Capability, inputs: Record<string, unknown>, name: string, opts: { allowDraft?: boolean } = { allowDraft: true }) {
  const rt = await runtime("replay", name, { capability: cap.name });
  try { return { result: await replay({ capability: cap, inputs, surface: rt.surface, guard: rt.guard, redactor: rt.redactor, log: rt.log, control: rt.control, secrets, allowDraft: opts.allowDraft }), rt }; }
  finally { await rt.close(); }
}

let cap: Capability;

describe("discovery to capability", () => {
  it("records a scripted run and compiles a parameterized, secret-free artifact", async () => {
    const rt = await runtime("discovery", goal.name, { goal: goal.goal });
    try {
      const trace = await discover({ spec: goal, surface: rt.surface, guard: rt.guard, redactor: rt.redactor, log: rt.log, control: rt.control, planner: scriptedPlanner(), secrets });
      expect(trace.status, trace.failure).toBe("completed");
      cap = compile(goal, trace, { runId: rt.log.id, model: "scripted", surfaceDriver: rt.surface.driver, evidence: rt.log.dir });
      rt.log.write("capability.json", cap);
      rt.log.finish({ status: "compiled" });
    } finally { await rt.close(); }

    const json = JSON.stringify(cap);
    expect(json).not.toContain("meridian1");
    expect(json).not.toContain('"literal","value":"10042"');
    expect(cap.steps[0]).toMatchObject({ action: "navigate" });
    expect(cap.steps.map((s) => s.action)).toEqual(["navigate", "type", "type", "click", "click", "type", "click", "extract", "extract"]);
    expect(cap.steps.filter((s) => s.action === "type").map((s) => (s as { value: unknown }).value)).toEqual([
      { kind: "secret", name: "MERIDIAN_USER" }, { kind: "secret", name: "MERIDIAN_PASSWORD" }, { kind: "param", name: "memberId" },
    ]);
    expect(cap.recoveries.map((r) => r.id)).toContain("dismiss_system_notice");
    expect(cap.outcomes.MEMBER_NOT_FOUND).toBeDefined();
    expect(cap.success).toEqual({ kind: "text", pattern: "Member Detail" });
    expect(cap.policy.effect).toBe("read_only");
    expect(cap.status).toBe("draft");
    const balance = cap.steps.find((s) => s.action === "extract" && s.output === "savingsBalance") as Extract<Capability["steps"][number], { action: "extract" }>;
    expect(balance.target.strategies[0]).toMatchObject({ kind: "cell", column: "Current Balance" });
    const name = cap.steps.find((s) => s.action === "extract" && s.output === "memberName") as Extract<Capability["steps"][number], { action: "extract" }>;
    expect(name.target.strategies[0]).toMatchObject({ kind: "anchor", text: "Name" });
    const search = cap.steps.find((s) => s.action === "click" && s.note === "search")!;
    expect(search.expect).toMatchObject({ kind: "text", pattern: "Member Detail" });
  });
});

describe("deterministic replay", () => {
  it("replays for a different member, clearing the interstitial as a recovery", async () => {
    const { result } = await replayWith(cap, { memberId: "10077" }, "success");
    expect(result.status, JSON.stringify(result.failure)).toBe("succeeded");
    expect(result.outputs).toEqual({ memberName: "Reyes, Daniel", savingsBalance: 12930.55 });
    expect(result.recoveries.map((r) => r.id)).toEqual(["dismiss_system_notice"]);
    expect(result.drift).toEqual([]);
    expect(fs.existsSync(path.join(result.evidenceDir, "report.html"))).toBe(true);
  });

  it("reports an unknown member as a business outcome, not a failure", async () => {
    const { result } = await replayWith(cap, { memberId: "99999" }, "not-found");
    expect(result.status).toBe("outcome");
    expect(result.outcome?.code).toBe("MEMBER_NOT_FOUND");
    expect(result.outputs).toBeUndefined();
  });

  it("rejects bad input before touching the UI", async () => {
    const { result } = await replayWith(cap, { memberId: "abc" }, "bad-input");
    expect(result.status).toBe("failed");
    expect(result.failure?.class).toBe("invalid_input");
    expect(result.stepsCompleted).toBe(0);
  });

  it("refuses unattended replay of a draft", async () => {
    const { result } = await replayWith(cap, { memberId: "10042" }, "draft-gate", { allowDraft: false });
    expect(result.failure?.class).toBe("policy_blocked");
  });

  it("re-authenticates when the session expires mid-flow", async () => {
    await faults({ expireSession: true });
    try {
      const { result } = await replayWith(cap, { memberId: "20015" }, "session-expired");
      expect(result.status, JSON.stringify(result.failure)).toBe("succeeded");
      expect(result.recoveries.map((r) => r.id)).toContain("session_expired");
      expect(result.outputs?.savingsBalance).toBe(88.2);
    } finally { await clearFaults(); }
  });

  it("starts over after a transient application error", async () => {
    await faults({ appErrorOnce: true });
    try {
      const { result } = await replayWith(cap, { memberId: "10042" }, "app-error");
      expect(result.status, JSON.stringify(result.failure)).toBe("succeeded");
      expect(result.recoveries.map((r) => r.id)).toContain("app_error_retry");
    } finally { await clearFaults(); }
  });
});

describe("escalation and handoff", () => {
  it("hands an unknown dialog to an operator who works the live session and hands back", async () => {
    await faults({ complianceDialog: true });
    const port = consolePort;
    const rt = await runtime("replay", "escalation", { capability: cap.name });
    try {
      const run = replay({ capability: cap, inputs: { memberId: "10042" }, surface: rt.surface, guard: rt.guard, redactor: rt.redactor, log: rt.log, control: rt.control, secrets, allowDraft: true });

      // A scripted operator, talking only to the console's HTTP API.
      const api = `http://localhost:${port}/api/interventions`;
      let open: { id: string; reason: string } | undefined;
      for (let i = 0; i < 200 && !open; i++) {
        const list = (await (await fetch(api)).json()) as { interventions: { id: string; state: string; reason: string }[] };
        open = list.interventions.find((x) => x.state === "open");
        if (!open) await new Promise((r) => setTimeout(r, 100));
      }
      expect(open?.reason).toMatch(/Compliance Attestation/);
      const post = (op: string, body: unknown = {}) => fetch(`${api}/${open!.id}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      expect((await post("take")).state).toBe("human_in_control");
      const screen = (await post("observe")) as { tree: string };
      const initials = screen.tree.match(/textbox "Operator initials" \[(e\d+)\]/)![1];
      await post("act", { kind: "type", ref: initials, text: "AT" });
      const after = (await post("observe")) as { tree: string };
      const attest = after.tree.match(/button "Attest" \[(e\d+)\]/)![1];
      await post("act", { kind: "click", ref: attest });
      const handed = await post("handback", { resolution: "retry_step" });
      expect(handed.state).toBe("resolved");

      const result = await run;
      expect(result.status, JSON.stringify(result.failure)).toBe("succeeded");
      expect(result.escalations).toHaveLength(1);
      expect(result.escalations[0]).toMatchObject({ kind: "takeover", resolution: "retry_step" });
      expect(result.escalations[0]!.humanActions).toBeGreaterThanOrEqual(2);
      const stored = JSON.parse(fs.readFileSync(path.join(rt.log.dir, "interventions", `${open!.id}.json`), "utf8"));
      expect(stored.humanActions.map((a: { detail: string }) => a.detail).join(" ")).not.toContain("AT");
    } finally { await rt.close(); await clearFaults(); }
  });
});

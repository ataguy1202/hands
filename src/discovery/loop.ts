/**
 * The observe → decide → act loop. The model decides; this file checks the
 * decision against policy, dispatches it, records what happened, and knows
 * when to stop or hand off.
 */
import type { Decision, Planner, PlannerTurn } from "./planner.js";
import type { GoalSpec } from "./goal.js";
import type { Guard, Risk } from "../policy/policy.js";
import type { Redactor } from "../policy/redact.js";
import type { RunLog } from "../evidence/run.js";
import type { ControlPlane } from "../session/control.js";
import type { WebSurface } from "../surface/web.js";
import { StaleRefError } from "../surface/web.js";
import type { DialogInfo, NodeInfo, Observation, SurfaceAction } from "../surface/types.js";
import type { Target, Value } from "../schema/capability.js";
import { deriveTarget } from "../surface/targets.js";
import { visibleText } from "../replay/conditions.js";
import { parseValue } from "../replay/parse.js";

export type ActionRecord = {
  kind: "action";
  seq: number;
  decision: Exclude<Decision, { tool: "extract" | "done" | "escalate" | "wait" }>;
  node?: NodeInfo;
  target?: Target;
  value?: Value;
  risk: Risk;
  pre: Observation;
  post: Observation;
  dialog?: DialogInfo;
  dialogResponse?: "accept" | "dismiss";
  approved?: boolean;
};
export type ExtractRecord = {
  kind: "extract";
  seq: number;
  output: string;
  parse: "text" | "money" | "number";
  target: Target;
  node: NodeInfo;
  raw: string;
  value: unknown;
};
export type EscalationRecord = { seq: number; reason: string; landmark?: string; resolution: string; humanActions: number };

export type Trace = {
  records: (ActionRecord | ExtractRecord)[];
  done?: Extract<Decision, { tool: "done" }>;
  escalations: EscalationRecord[];
  status: "completed" | "aborted" | "failed";
  failure?: string;
  steps: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export type LoopDeps = {
  spec: GoalSpec;
  surface: WebSurface;
  guard: Guard;
  redactor: Redactor;
  log: RunLog;
  control: ControlPlane;
  planner: PlannerLike;
  secrets: NodeJS.ProcessEnv;
};

/** What the loop needs from a planner. The real one talks to a model; tests script one. */
export type PlannerLike = Pick<Planner, "model" | "transcript"> & {
  next(observation: Observation, lastResult?: { text: string; isError?: boolean }): Promise<PlannerTurn>;
};

export async function discover(deps: LoopDeps): Promise<Trace> {
  const { spec, surface, guard, log, control, planner } = deps;
  const trace: Trace = { records: [], escalations: [], status: "failed", steps: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const deadline = Date.now() + spec.limits.timeoutMs;
  let policyBlocks = 0;
  let lastResult: { text: string; isError?: boolean } | undefined;

  const nav = guard.check({ kind: "navigate", url: spec.entry }, { url: "about:blank" });
  if (!nav.allowed) { trace.failure = `entry point rejected by policy: ${nav.reason}`; return trace; }
  await surface.act({ kind: "navigate", url: spec.entry });
  log.event("navigate", { url: spec.entry, why: "entry point" });

  for (let step = 1; step <= spec.limits.maxSteps; step++) {
    if (Date.now() > deadline) { trace.failure = "discovery timed out"; return trace; }
    control.assertAutomation();
    trace.steps = step;

    const obs = await surface.observe({ screenshot: true });
    const shot = log.screenshot(`step-${step}`, obs.screenshot!);
    const snap = log.snapshot(`step-${step}`, obs.tree);
    log.event("observe", { step, url: obs.url, nodes: obs.nodes.length, dialog: obs.dialog?.message, screenshot: shot, snapshot: snap });

    let turn;
    try { turn = await planner.next(obs, lastResult); }
    catch (e) { trace.failure = `planner: ${(e as Error).message}`; return trace; }
    const { decision } = turn;
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) trace.usage[k] += turn.usage[k];
    log.event("decide", { step, tool: decision.tool, input: stripTool(decision), reasoning: turn.reasoning, usage: turn.usage });
    lastResult = undefined;

    // ---- terminal and non-surface decisions ----
    if (decision.tool === "done") {
      const corpus = visibleText(obs).toLowerCase();
      if (!corpus.includes(decision.checkpointText.toLowerCase())) {
        lastResult = { text: `The checkpoint text "${decision.checkpointText}" is not visible on the current screen. Choose text that is on screen now, or keep working.`, isError: true };
        continue;
      }
      const missing = Object.keys(spec.outputs).filter((o) => !trace.records.some((r) => r.kind === "extract" && r.output === o));
      if (missing.length) {
        lastResult = { text: `Outputs not yet extracted: ${missing.join(", ")}. Use extract for each before calling done.`, isError: true };
        continue;
      }
      trace.done = decision;
      trace.status = "completed";
      log.event("done", { step, checkpointText: decision.checkpointText, outcomes: decision.outcomes ?? [] });
      return trace;
    }
    if (decision.tool === "wait") { await surface.settle(6000); lastResult = { text: "Waited for the page to settle." }; continue; }
    if (decision.tool === "escalate") {
      const it = await control.raise("takeover", { reason: decision.reason, atStep: `discovery step ${step}`, observation: obs });
      const rec: EscalationRecord = { seq: step, reason: decision.reason, landmark: firstLandmark(obs), resolution: it.resolution!, humanActions: it.humanActions.length };
      trace.escalations.push(rec);
      if (it.resolution === "abort" || it.resolution === "timeout") { trace.status = "aborted"; trace.failure = `escalated at step ${step}: ${decision.reason} (${it.resolution})`; return trace; }
      lastResult = { text: `A human operator took control and handed the session back (${it.resolution}, ${it.humanActions.length} actions recorded). Look at the screen and continue.` };
      continue;
    }
    if (decision.tool === "extract") {
      const node = obs.nodes.find((n) => n.ref === decision.ref);
      if (!node) { lastResult = { text: `Ref ${decision.ref} is not in the current tree.`, isError: true }; continue; }
      if (!(decision.output in spec.outputs)) { lastResult = { text: `"${decision.output}" is not a declared output. Declared: ${Object.keys(spec.outputs).join(", ")}.`, isError: true }; continue; }
      const raw = node.text || node.name || node.value || "";
      const parsed = parseValue(raw, decision.parse);
      if (parsed === undefined) { lastResult = { text: `Could not parse "${raw}" as ${decision.parse}.`, isError: true }; continue; }
      trace.records.push({ kind: "extract", seq: step, output: decision.output, parse: decision.parse, target: deriveTarget(node, obs), node, raw, value: parsed });
      log.event("extract", { step, output: decision.output, parse: decision.parse, value: parsed, target: describeTargetShort(deriveTarget(node, obs)) });
      lastResult = { text: `Extracted ${decision.output} = ${JSON.stringify(parsed)}.` };
      continue;
    }

    // ---- surface actions ----
    const node = "ref" in decision && decision.ref ? obs.nodes.find((n) => n.ref === decision.ref) : undefined;
    if ("ref" in decision && decision.ref && !node) { lastResult = { text: `Ref ${decision.ref} is not in the current tree.`, isError: true }; continue; }

    let action: SurfaceAction;
    let value: Value | undefined;
    switch (decision.tool) {
      case "click": action = { kind: "click", ref: decision.ref }; break;
      case "type": {
        value = valueFromDecision(decision, spec);
        if (!value) { lastResult = { text: "Provide exactly one of param, literal, or secret.", isError: true }; continue; }
        const text = resolveValue(value, spec.discoveryInputs, deps.secrets);
        if (text === undefined) { lastResult = { text: `Unknown ${value.kind} "${(value as { name: string }).name}".`, isError: true }; continue; }
        if (value.kind === "secret" && node?.type !== "password" && !/(user|operator|login|id)/i.test(node?.name ?? "")) {
          lastResult = { text: "Secrets may only be typed into sign-on fields.", isError: true }; continue;
        }
        action = { kind: "type", ref: decision.ref, text };
        break;
      }
      case "select": {
        value = decision.param ? { kind: "param", name: decision.param } : decision.option ? { kind: "literal", value: decision.option } : undefined;
        if (!value) { lastResult = { text: "Provide option or param.", isError: true }; continue; }
        const text = resolveValue(value, spec.discoveryInputs, deps.secrets);
        if (text === undefined) { lastResult = { text: `Unknown param "${decision.param}".`, isError: true }; continue; }
        action = { kind: "select", ref: decision.ref, value: text };
        break;
      }
      case "press": action = { kind: "press", key: decision.key, ref: decision.ref }; break;
      case "navigate": action = { kind: "navigate", url: decision.url }; break;
      case "dialog": action = { kind: "dialog", respond: decision.respond }; break;
    }

    const verdict = guard.check(action, { url: obs.url, node, dialogMessage: obs.dialog?.message });
    log.event("policy", { step, action: action.kind, allowed: verdict.allowed, risk: verdict.risk, reason: verdict.allowed ? undefined : verdict.reason });
    if (!verdict.allowed) {
      if (++policyBlocks >= 3) { trace.failure = "three actions blocked by policy; stopping"; return trace; }
      lastResult = { text: `Blocked by policy: ${verdict.reason}. Choose a different action within the allowlist.`, isError: true };
      continue;
    }

    let approved: boolean | undefined;
    // Accepting the confirm dialog that an already-approved click raised is the same decision, not a second one.
    const lastRecord = trace.records.at(-1);
    const alreadyApproved = decision.tool === "dialog" && lastRecord?.kind === "action" && lastRecord.approved === true && !!lastRecord.dialog && !lastRecord.dialogResponse;
    if (verdict.risk === "irreversible" && guard.policy.irreversible.mode === "confirm" && !alreadyApproved) {
      const it = await control.raise("approval", { reason: `Irreversible action: ${describeAction(action, node, obs.dialog)}`, atStep: `discovery step ${step}`, observation: obs });
      approved = it.resolution === "approved";
      if (!approved) { trace.status = "aborted"; trace.failure = `irreversible action ${it.resolution} by operator at step ${step}`; return trace; }
    }

    try {
      await surface.act(action);
    } catch (e) {
      const msg = (e as Error).message;
      log.event("act.failed", { step, action: action.kind, ref: node?.ref, error: msg });
      lastResult = { text: e instanceof StaleRefError ? `The control is no longer available: ${msg}. Look at the current screen.` : `The action failed: ${msg.split("\n")[0]}`, isError: true };
      continue;
    }
    const post = await surface.observe();
    const pendingDialog = surface.pendingDialog();
    log.event("act", { step, action: action.kind, ref: node?.ref, control: node ? describeNodeShort(node) : undefined, value: value ? describeValue(value) : undefined, risk: verdict.risk, dialogOpened: pendingDialog?.message, url: post.url });

    if (decision.tool === "dialog") {
      const prev = [...trace.records].reverse().find((r): r is ActionRecord => r.kind === "action" && !!r.dialog && !r.dialogResponse);
      if (prev) { prev.dialogResponse = decision.respond; prev.post = post; if (approved !== undefined) prev.approved = approved; }
      lastResult = { text: `Dialog ${decision.respond === "accept" ? "accepted" : "dismissed"}.` };
      continue;
    }
    trace.records.push({
      kind: "action", seq: step, decision, node, target: node ? deriveTarget(node, obs) : undefined, value,
      risk: verdict.risk, pre: obs, post, dialog: pendingDialog, approved,
    });
    lastResult = { text: pendingDialog ? `Done. A native ${pendingDialog.type} dialog is now open and blocking the page.` : "Done." };
  }
  trace.failure = `reached the step limit (${spec.limits.maxSteps}) without completing the goal`;
  return trace;
}

// ---------- helpers ----------

function valueFromDecision(d: Extract<Decision, { tool: "type" }>, spec: GoalSpec): Value | undefined {
  const given = [d.param, d.literal, d.secret].filter((x) => x !== undefined).length;
  if (given !== 1) return undefined;
  if (d.param) return { kind: "param", name: d.param };
  if (d.secret) return { kind: "secret", name: d.secret };
  // A literal that equals an input value is an input the model forgot to name. Keep the flow parameterized.
  const param = Object.entries(spec.discoveryInputs).find(([, v]) => v === d.literal)?.[0];
  return param ? { kind: "param", name: param } : { kind: "literal", value: d.literal! };
}

export function resolveValue(v: Value, inputs: Record<string, unknown>, secrets: NodeJS.ProcessEnv): string | undefined {
  if (v.kind === "literal") return v.value;
  if (v.kind === "param") return v.name in inputs ? String(inputs[v.name]) : undefined;
  return secrets[v.name];
}

export function describeValue(v: Value): string {
  return v.kind === "literal" ? `"${v.value}"` : v.kind === "param" ? `{param ${v.name}}` : `{secret ${v.name}}`;
}
function describeNodeShort(n: NodeInfo): string { return `${n.role} "${(n.name || n.text).slice(0, 50)}"`; }
function describeTargetShort(t: Target): string { return `${t.describe} [${t.strategies.length} strategies]`; }
function describeAction(a: SurfaceAction, node?: NodeInfo, dialog?: DialogInfo): string {
  if (a.kind === "dialog") return `${a.respond} native dialog "${dialog?.message ?? ""}"`;
  return `${a.kind} ${node ? describeNodeShort(node) : ""}`.trim();
}
function stripTool<T extends { tool: string }>(d: T): Omit<T, "tool"> { const { tool: _t, ...rest } = d; return rest; }

/** A short, human-meaningful piece of text that names the current screen. */
export function firstLandmark(obs: Observation): string | undefined {
  const n = obs.nodes.find((x) => x.role === "dialog" && x.name)
    ?? obs.nodes.find((x) => x.role === "heading" && x.text)
    ?? obs.nodes.find((x) => (x.role === "cell" || x.role === "text") && x.depth === 0 && x.text.length >= 4 && x.frame.at(-1) !== "banner" && x.frame.at(-1) !== "nav");
  return n ? (n.name || n.text) : undefined;
}

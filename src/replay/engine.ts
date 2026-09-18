/**
 * Deterministic replay. No model anywhere in this file.
 *
 * For each step: resolve the control through the strategy chain, check policy,
 * act, then wait for the step's checkpoint. Before every step and after every
 * failure, the global detectors get a look at the screen: is this a business
 * outcome the caller needs, a condition we know how to clear, or something a
 * person has to see?
 */
import type { Capability, Condition, Recovery, Step } from "../schema/capability.js";
import { renderTemplate } from "../schema/capability.js";
import type { Failure, ReplayResult } from "../schema/result.js";
import type { Guard } from "../policy/policy.js";
import type { Redactor } from "../policy/redact.js";
import type { RunLog } from "../evidence/run.js";
import type { ControlPlane, Intervention } from "../session/control.js";
import type { WebSurface } from "../surface/web.js";
import type { DialogInfo, NodeInfo, Observation, SurfaceAction } from "../surface/types.js";
import { describeStrategy } from "../surface/targets.js";
import { describeCondition, evaluate, visibleText } from "./conditions.js";
import { parseValue } from "./parse.js";
import { describeValue, firstLandmark, resolveValue } from "../discovery/loop.js";

export type ReplayDeps = {
  capability: Capability;
  inputs: Record<string, unknown>;
  surface: WebSurface;
  guard: Guard;
  redactor: Redactor;
  log: RunLog;
  control: ControlPlane;
  secrets: NodeJS.ProcessEnv;
  allowDraft?: boolean;
};

type Flow =
  | { kind: "continue" }
  | { kind: "retry" }
  | { kind: "skip" }
  | { kind: "restart" }
  | { kind: "outcome"; code: string; description: string }
  | { kind: "aborted"; intervention: Intervention }
  | { kind: "failed"; failure: Failure };

export async function replay(deps: ReplayDeps): Promise<ReplayResult> {
  const { capability: cap, inputs, surface, guard, log, control } = deps;
  const startedAt = new Date();
  const result = {
    recoveries: [] as ReplayResult["recoveries"], drift: [] as ReplayResult["drift"], escalations: [] as ReplayResult["escalations"], stepsCompleted: 0,
  };
  const outputs: Record<string, unknown> = {};
  const recoveryAttempts = new Map<string, number>();   // keyed by recovery and step: budgets bound loops at one spot
  const stepAttempts = new Map<string, number>();
  let irreversibleDone = false;
  let grace: string | undefined;                          // a recovery just applied gets one step before it can fire again

  const finish = (partial: Partial<ReplayResult> & { status: ReplayResult["status"] }): ReplayResult => {
    const finishedAt = new Date();
    const r: ReplayResult = {
      runId: log.id, capability: { id: cap.id, name: cap.name, version: cap.version },
      ...result, ...partial,
      startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime(),
      evidenceDir: log.dir,
    };
    log.write("result.json", r);
    log.finish({ status: r.status, outcome: r.outcome?.code, failure: r.failure?.class, stepsCompleted: r.stepsCompleted, recoveries: r.recoveries.length, drift: r.drift.length, escalations: r.escalations.length });
    return r;
  };

  const fail = async (f: Omit<Failure, "evidence">, obs?: Observation): Promise<ReplayResult> => {
    const o = obs ?? (await surface.observe());
    const screenshot = log.screenshot(`failure-${f.class}`, await surface.screenshot());
    const snapshot = log.snapshot(`failure-${f.class}`, o.tree);
    const failure: Failure = { ...f, evidence: { screenshot, snapshot, url: o.url } };
    log.event("failure", { ...failure });
    return finish({ status: "failed", failure });
  };

  // ---- contract checks, before touching the UI ----
  const invalid = validateInputs(cap, inputs);
  if (invalid) return finish({ status: "failed", failure: { class: "invalid_input", message: invalid } });
  for (const [k, spec] of Object.entries(cap.inputs)) if (spec.sensitive) deps.redactor.addSensitiveValue(inputs[k]);
  if (cap.status === "draft" && !deps.allowDraft) {
    return finish({ status: "failed", failure: { class: "policy_blocked", message: `capability ${cap.name} v${cap.version} is a draft; unattended replay requires status verified or approved (or --allow-draft)` } });
  }
  log.event("run.started", { capability: cap.name, version: cap.version, status: cap.status, inputs, steps: cap.steps.length });

  // ---- global detectors ----
  const globals = async (obs: Observation, step: Step, after?: Failure): Promise<Flow> => {
    for (const [code, o] of Object.entries(cap.outcomes)) {
      const v = evaluate(o.detect, obs);
      if (v.ok) { log.event("outcome", { step: step.id, code, detail: v.detail }); return { kind: "outcome", code, description: o.description }; }
    }
    for (const e of cap.escalations) {
      const v = evaluate(e.detect, obs);
      if (v.ok) return escalate(obs, step, `${e.description} (${v.detail})`);
    }
    const strangeDialog = obs.nodes.find((n) => n.role === "dialog" && !cap.recoveries.some((r) => evaluate(r.detect, obs).ok));
    if (strangeDialog) return escalate(obs, step, `An unexpected dialog "${strangeDialog.name}" is blocking the flow and no recovery is defined for it`);
    if (after?.class === "unexpected_dialog") return escalate(obs, step, after.message);

    for (const rec of cap.recoveries) {
      if (grace === rec.id) continue;
      const v = evaluate(rec.detect, obs);
      if (!v.ok) continue;
      const attempts = (recoveryAttempts.get(`${rec.id}@${step.id}`) ?? 0) + 1;
      recoveryAttempts.set(`${rec.id}@${step.id}`, attempts);
      if (attempts > rec.maxAttempts) {
        return { kind: "failed", failure: { class: "recovery_exhausted", atStep: step.id, message: `recovery "${rec.id}" was applied ${rec.maxAttempts} times and the condition persists`, expected: `not (${describeCondition(rec.detect)})`, observed: v.detail } };
      }
      result.recoveries.push({ id: rec.id, atStep: step.id, attempt: attempts });
      log.event("recovery", { step: step.id, id: rec.id, attempt: attempts, detail: v.detail, action: rec.action.kind });
      grace = rec.id;
      const flow = await applyRecovery(rec, obs, step);
      if (flow) return flow;
      return { kind: "retry" };
    }
    if (after) return { kind: "failed", failure: after };
    return { kind: "continue" };
  };

  const applyRecovery = async (rec: Recovery, obs: Observation, step: Step): Promise<Flow | undefined> => {
    const action = rec.action;
    switch (action.kind) {
      case "click": {
        const r = surface.resolve(action.target, obs);
        if (!r.ok) return { kind: "failed", failure: { class: "target_not_found", atStep: step.id, message: `recovery "${rec.id}": ${r.detail}` } };
        await surface.act({ kind: "click", ref: r.ref });
        return undefined;
      }
      case "retry_step":
        await new Promise((r) => setTimeout(r, action.delayMs));
        return undefined;
      case "restart":
        if (irreversibleDone) return escalate(obs, step, `recovery "${rec.id}" would restart the flow, but an irreversible step has already run`);
        return { kind: "restart" };
    }
  };

  const escalate = async (obs: Observation, step: Step, reason: string): Promise<Flow> => {
    const it = await control.raise("takeover", { reason, atStep: step.id, observation: obs });
    result.escalations.push({ id: it.id, kind: it.kind, atStep: step.id, reason, raisedAt: it.raisedAt, resolvedAt: it.resolvedAt, resolution: it.resolution, humanActions: it.humanActions.length });
    switch (it.resolution) {
      case "retry_step": return { kind: "retry" };
      case "skip_step": return { kind: "skip" };
      case "abort": return { kind: "aborted", intervention: it };
      default: return { kind: "failed", failure: { class: "escalation_failed", atStep: step.id, message: `intervention ${it.id} ended with ${it.resolution}` } };
    }
  };

  // ---- one step ----
  const execute = async (step: Step, obs: Observation): Promise<Failure | undefined> => {
    const t0 = Date.now();
    const resolveNode = (target: NonNullable<Extract<Step, { action: "click" }>["target"]>): NodeInfo | Failure => {
      const r = surface.resolve(target, obs);
      if (!r.ok) {
        return { class: r.reason === "ambiguous" ? "target_ambiguous" : "target_not_found", atStep: step.id, message: `${target.describe}: ${r.detail}`, expected: target.describe, observed: firstLandmark(obs) ?? obs.url };
      }
      if (r.strategyIndex > 0) {
        const primary = describeStrategy(target.strategies[0]!);
        result.drift.push({ step: step.id, primary, used: r.strategy });
        log.event("drift", { step: step.id, control: target.describe, primary, used: r.strategy });
      }
      log.event("resolve", { step: step.id, control: target.describe, via: r.strategy, ref: r.ref });
      return r.node;
    };
    const isFailure = (x: NodeInfo | Failure): x is Failure => "class" in x;

    let action: SurfaceAction | undefined;
    let node: NodeInfo | undefined;
    switch (step.action) {
      case "navigate": action = { kind: "navigate", url: renderTemplate(step.url, inputs) }; break;
      case "click": { const r = resolveNode(step.target); if (isFailure(r)) return r; node = r; action = { kind: "click", ref: r.ref }; break; }
      case "type": case "select": {
        const r = resolveNode(step.target); if (isFailure(r)) return r; node = r;
        const text = resolveValue(step.value, inputs, deps.secrets);
        if (text === undefined) return { class: "invalid_input", atStep: step.id, message: `${describeValue(step.value)} is not available to the runtime` };
        action = step.action === "type" ? { kind: "type", ref: r.ref, text } : { kind: "select", ref: r.ref, value: text };
        break;
      }
      case "press": {
        if (step.target) { const r = resolveNode(step.target); if (isFailure(r)) return r; node = r; action = { kind: "press", key: step.key, ref: r.ref }; }
        else action = { kind: "press", key: step.key };
        break;
      }
      case "extract": {
        const r = resolveNode(step.target); if (isFailure(r)) return r;
        const raw = r.text || r.name || r.value || "";
        const value = parseValue(raw, step.parse);
        if (value === undefined) return { class: "checkpoint_failed", atStep: step.id, message: `could not parse "${raw}" as ${step.parse}`, expected: `${step.parse} in ${step.target.describe}`, observed: raw };
        outputs[step.output] = value;
        log.event("extract", { step: step.id, output: step.output, value, via: step.target.describe });
        return undefined;
      }
      case "assert": {
        const v = evaluate(step.condition, obs);
        if (!v.ok) return { class: "checkpoint_failed", atStep: step.id, message: v.detail, expected: describeCondition(step.condition), observed: firstLandmark(obs) ?? obs.url };
        return undefined;
      }
    }

    const verdict = guard.check(action, { url: obs.url, node });
    if (!verdict.allowed) return { class: "policy_blocked", atStep: step.id, message: verdict.reason };
    const risk = step.risk === "irreversible" || verdict.risk === "irreversible" ? "irreversible" : "safe";
    if (risk === "irreversible") {
      const mode = guard.policy.irreversible.mode;
      if (mode === "block") return { class: "policy_blocked", atStep: step.id, message: "irreversible step blocked by policy" };
      if (mode === "confirm") {
        const it = await control.raise("approval", { reason: `Irreversible step ${step.id}: ${step.note ?? step.action}${"target" in step && step.target ? ` on ${step.target.describe}` : ""}`, atStep: step.id, observation: obs });
        result.escalations.push({ id: it.id, kind: it.kind, atStep: step.id, reason: `approval for irreversible step`, raisedAt: it.raisedAt, resolvedAt: it.resolvedAt, resolution: it.resolution, humanActions: 0 });
        if (it.resolution !== "approved") return { class: "policy_blocked", atStep: step.id, message: `irreversible step ${it.resolution} by operator` };
      }
      log.event("irreversible", { step: step.id, mode });
    }

    // Native dialogs: answer the one the step expects, cancel anything else and report it.
    let unexpected: DialogInfo | undefined;
    let answered: DialogInfo | undefined;
    surface.dialogPolicy = (info) => {
      if (step.action === "click" && step.dialog && info.type === step.dialog.type && new RegExp(step.dialog.pattern, "i").test(info.message)) { answered = info; return step.dialog.respond; }
      unexpected = info;
      return "dismiss";
    };
    try {
      await surface.act(action);
    } catch (e) {
      return { class: "app_error", atStep: step.id, message: `action failed: ${(e as Error).message.split("\n")[0]}`, expected: `${action.kind} on ${node ? `${node.role} "${node.name || node.text}"` : action.kind === "navigate" ? action.url : ""}` };
    } finally {
      surface.dialogPolicy = () => "hold";
    }
    if (risk === "irreversible") irreversibleDone = true;
    if (answered) log.event("dialog", { step: step.id, type: answered.type, message: answered.message, respond: step.action === "click" ? step.dialog?.respond : undefined });
    log.event("act", { step: step.id, action: action.kind, control: node ? `${node.role} "${node.name || node.text}"` : undefined, value: "value" in step ? describeValue(step.value) : undefined, ms: Date.now() - t0 });
    if (unexpected) return { class: "unexpected_dialog", atStep: step.id, message: `unexpected native ${unexpected.type} dialog "${unexpected.message}" was cancelled`, observed: unexpected.message };
    if (step.action === "click" && step.dialog && !answered) return { class: "checkpoint_failed", atStep: step.id, message: "the expected native dialog did not appear", expected: `dialog /${step.dialog.pattern}/` };

    if (step.expect) {
      const v = await waitFor(step.expect, step.timeoutMs);
      log.event("checkpoint", { step: step.id, ok: v.ok, expected: describeCondition(step.expect), detail: v.detail, ms: Date.now() - t0 });
      if (!v.ok) return { class: "checkpoint_failed", atStep: step.id, message: v.detail, expected: describeCondition(step.expect), observed: firstLandmark(v.obs) ?? v.obs.url };
    }
    return undefined;
  };

  /** Something a detector would act on: no point waiting out a checkpoint once it is on screen. */
  const detectorFired = (obs: Observation): boolean =>
    Object.values(cap.outcomes).some((o) => evaluate(o.detect, obs).ok) ||
    cap.escalations.some((e) => evaluate(e.detect, obs).ok) ||
    cap.recoveries.some((r) => evaluate(r.detect, obs).ok) ||
    obs.nodes.some((n) => n.role === "dialog");

  const waitFor = async (cond: Condition, timeoutMs: number): Promise<{ ok: boolean; detail: string; obs: Observation }> => {
    const deadline = Date.now() + timeoutMs;
    let last!: { ok: boolean; detail: string; obs: Observation };
    do {
      const obs = await surface.observe();
      const v = evaluate(cond, obs);
      last = { ...v, obs };
      if (v.ok || detectorFired(obs)) return last;
      await new Promise((r) => setTimeout(r, 250));
    } while (Date.now() < deadline);
    return last;
  };

  // ---- main loop ----
  let i = 0;
  while (i < cap.steps.length) {
    const step = cap.steps[i]!;
    control.assertAutomation();
    const obs = await surface.observe();
    const pre = await globals(obs, step);
    const handled = await route(pre);
    if (handled) return handled;
    if (pre.kind === "retry" || pre.kind === "restart") continue;
    if (pre.kind === "skip") {
      const v = step.expect ? evaluate(step.expect, await surface.observe()) : { ok: true, detail: "no checkpoint" };
      log.event("step.skipped", { step: step.id, checkpoint: v.detail });
      if (!v.ok) return fail({ class: "checkpoint_failed", atStep: step.id, message: `step skipped by operator but its checkpoint does not hold: ${v.detail}`, expected: describeCondition(step.expect!) });
      i++; continue;
    }
    const attempt = (stepAttempts.get(step.id) ?? 0) + 1;
    stepAttempts.set(step.id, attempt);
    // On a retry, a step whose effect is already on screen must not run again. That is the
    // difference between re-clicking Search and re-posting a transaction.
    if (attempt > 1 && step.expect && evaluate(step.expect, obs).ok) {
      log.event("step.already_satisfied", { step: step.id, attempt });
      result.stepsCompleted++; i++; continue;
    }
    log.event("step.start", { step: step.id, action: step.action, note: step.note, attempt });
    const failure = await execute(step, obs);
    grace = undefined;
    if (!failure) { result.stepsCompleted++; i++; continue; }

    log.event("step.failed", { step: step.id, class: failure.class, message: failure.message, expected: failure.expected, observed: failure.observed });
    if (failure.class === "invalid_input" || failure.class === "policy_blocked") return fail(failure);
    if ((stepAttempts.get(step.id) ?? 0) >= 3) return fail({ ...failure, message: `${failure.message} (after 3 attempts)` });
    if (failure.class === "app_error") await surface.settle(3000);
    const post = await globals(await surface.observe(), step, failure);
    const handledPost = await route(post);
    if (handledPost) return handledPost;
    if (post.kind === "skip") { i++; continue; }
    // retry or restart: loop again
  }

  const final = await surface.observe();
  const ok = evaluate(cap.success, final);
  log.event("checkpoint", { step: "success", ok: ok.ok, expected: describeCondition(cap.success), detail: ok.detail });
  if (!ok.ok) return fail({ class: "checkpoint_failed", atStep: "success", message: ok.detail, expected: describeCondition(cap.success), observed: firstLandmark(final) ?? visibleText(final).slice(0, 200) }, final);
  log.write("outputs.json", outputs);
  return finish({ status: "succeeded", outputs });

  async function route(flow: Flow): Promise<ReplayResult | undefined> {
    if (flow.kind === "outcome") return finish({ status: "outcome", outcome: { code: flow.code, description: flow.description } });
    if (flow.kind === "aborted") return finish({ status: "aborted" });
    if (flow.kind === "failed") return fail(flow.failure);
    if (flow.kind === "restart") { i = 0; log.event("restart", {}); await surface.act({ kind: "navigate", url: cap.app.entry }); }
    return undefined;
  }
}

function validateInputs(cap: Capability, inputs: Record<string, unknown>): string | undefined {
  for (const [name, spec] of Object.entries(cap.inputs)) {
    const v = inputs[name];
    if (v === undefined || v === "") { if (spec.required) return `missing required input "${name}"`; continue; }
    if (spec.type === "number" && Number.isNaN(Number(v))) return `input "${name}" must be a number`;
    if (spec.type === "boolean" && typeof v !== "boolean") return `input "${name}" must be a boolean`;
    if (spec.pattern && !new RegExp(spec.pattern).test(String(v))) return `input "${name}" does not match ${spec.pattern}`;
  }
  const unknown = Object.keys(inputs).filter((k) => !(k in cap.inputs));
  if (unknown.length) return `unknown input(s): ${unknown.join(", ")}`;
  return undefined;
}

/**
 * Turn a discovery trace into a capability. This is where the model's
 * transcript stops mattering: what survives is the ordered steps, how each
 * control is found, what proves each step worked, and the contract.
 */
import type { Capability, Condition, Recovery, Step, Target } from "../schema/capability.js";
import { Capability as CapabilitySchema } from "../schema/capability.js";
import type { GoalSpec } from "./goal.js";
import type { ActionRecord, Trace } from "./loop.js";
import type { NodeInfo, Observation } from "../surface/types.js";
import { deriveTarget } from "../surface/targets.js";

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "").slice(0, 40);

export function compile(spec: GoalSpec, trace: Trace, provenance: { runId: string; model: string; surfaceDriver: string; evidence: string }): Capability {
  if (trace.status !== "completed" || !trace.done) throw new Error(`cannot compile an incomplete trace (${trace.status}: ${trace.failure ?? ""})`);
  const inputValues = spec.discoveryInputs;
  const steps: Step[] = [];
  const recoveries: Recovery[] = [...spec.recoveries];
  const irreversible: string[] = [];
  let n = 0;
  const nextId = () => `s${++n}`;

  const actions = trace.records.filter((r): r is ActionRecord => r.kind === "action");

  // The flow starts by opening the entry point. Recorded as a step so the artifact is
  // self-contained and a restart recovery has somewhere to go.
  const first = actions[0]?.pre;
  const entryLandmark = first ? landmarksOf(first, [], Object.values(inputValues))[0] : undefined;
  steps.push({ id: nextId(), action: "navigate", url: spec.entry, note: "open the application", risk: "safe", timeoutMs: 8000, expect: entryLandmark ? { kind: "text", pattern: escapeRx(entryLandmark.name || entryLandmark.text), frame: entryLandmark.frame } : undefined });

  for (let i = 0; i < trace.records.length; i++) {
    const rec = trace.records[i]!;
    if (rec.kind === "extract") {
      steps.push({ id: nextId(), action: "extract", target: rec.target, output: rec.output, parse: rec.parse, risk: "safe", timeoutMs: 8000, note: `read ${rec.output}` });
      continue;
    }
    const d = rec.decision;

    // A click inside a dialog container that the flow did not ask for is how the model cleared an
    // interstitial. It becomes a recovery keyed on the dialog, not a step the replay depends on.
    if (d.tool === "click" && rec.node?.dialog && rec.target) {
      const container = rec.pre.nodes.find((x) => x.role === "dialog" && x.name === rec.node!.dialog);
      const detect: Condition = container
        ? { kind: "visible", target: deriveTarget(container, rec.pre) }
        : { kind: "text", pattern: escapeRx(rec.node.dialog) };
      const id = `dismiss_${slug(rec.node.dialog)}`;
      if (!recoveries.some((r) => r.id === id)) {
        recoveries.push({ id, description: d.note, detect, action: { kind: "click", target: rec.target }, maxAttempts: 2 });
      }
      continue;
    }

    const base = { id: nextId(), note: d.note, risk: rec.risk, timeoutMs: 8000 } as const;
    const expect = expectationFor(rec, actions.slice(actions.indexOf(rec) + 1), inputValues);
    switch (d.tool) {
      case "navigate":
        steps.push({ ...base, action: "navigate", url: parameterize(d.url, inputValues), expect });
        break;
      case "click": {
        const step: Extract<Step, { action: "click" }> = { ...base, action: "click", target: rec.target!, expect };
        if (rec.dialog && rec.dialogResponse) {
          step.dialog = { type: rec.dialog.type === "beforeunload" ? "confirm" : rec.dialog.type, pattern: parameterizePattern(rec.dialog.message, inputValues), respond: rec.dialogResponse };
        }
        if (rec.risk === "irreversible") { step.risk = "irreversible"; irreversible.push(step.id); }
        steps.push(step);
        break;
      }
      case "type":
        steps.push({ ...base, action: "type", target: rec.target!, value: rec.value! });
        break;
      case "select":
        steps.push({ ...base, action: "select", target: rec.target!, value: rec.value!, expect });
        break;
      case "press":
        steps.push({ ...base, action: "press", target: rec.target, key: d.key, expect });
        break;
    }
  }

  const success: Condition = spec.success ?? { kind: "text", pattern: escapeRx(trace.done.checkpointText) };
  const outcomes = { ...spec.outcomes };
  for (const o of trace.done.outcomes ?? []) {
    if (!(o.code in outcomes)) outcomes[o.code] = { description: o.description, detect: { kind: "text", pattern: o.textPattern } };
  }
  const escalations = [...spec.escalations];
  for (const e of trace.escalations) {
    const id = `needs_human_${slug(e.landmark ?? e.reason)}`;
    if (e.landmark && !escalations.some((x) => x.id === id)) {
      escalations.push({ id, description: `${e.reason} (a person resolved this during discovery)`, detect: { kind: "text", pattern: escapeRx(e.landmark) } });
    }
  }

  const cap: Capability = {
    schemaVersion: "1.0",
    id: `cap_${spec.name}`,
    name: spec.name,
    version: 1,
    status: "draft",
    description: spec.description,
    app: { id: spec.app.id, surface: spec.app.surface, entry: spec.entry },
    inputs: spec.inputs,
    outputs: spec.outputs,
    steps,
    success,
    outcomes,
    recoveries,
    escalations,
    policy: { effect: irreversible.length ? "mutating" : "read_only", irreversibleSteps: irreversible },
    provenance: { discoveredAt: new Date().toISOString(), discoveryRunId: provenance.runId, model: provenance.model, surfaceDriver: provenance.surfaceDriver, evidence: provenance.evidence },
    stats: { replays: 0, succeeded: 0 },
  };
  return CapabilitySchema.parse(cap);
}

/** Replace occurrences of input values with {{name}} placeholders. */
export function parameterize(s: string, inputs: Record<string, string>): string {
  let out = s;
  for (const [k, v] of Object.entries(inputs)) if (v && v.length >= 2) out = out.split(v).join(`{{${k}}}`);
  return out;
}
/** A regex that matches the same message for any input values. */
function parameterizePattern(s: string, inputs: Record<string, string>): string {
  let out = escapeRx(s);
  for (const v of Object.values(inputs)) if (v && v.length >= 2) out = out.split(escapeRx(v)).join(".+?");
  return out;
}

/**
 * What proves this action took effect: the first landmark (dialog name, heading,
 * top-level cell or text) that was not on screen before it and is on screen
 * after it, taken from the first later observation that is not an interstitial.
 * Landmarks that contain an input value are skipped; a URL change is the fallback.
 */
function expectationFor(rec: ActionRecord, later: ActionRecord[], inputs: Record<string, string>): Condition | undefined {
  if (rec.decision.tool === "type") return undefined;
  const before = new Set(rec.pre.nodes.map(key));
  const observations = [rec.post, ...later.filter((r) => r.node?.dialog).map((r) => r.post)];
  const values = Object.values(inputs).filter((v) => v.length >= 2);
  for (const obs of observations) {
    if (obs.nodes.some((x) => x.role === "dialog")) continue;
    const pick = landmarksOf(obs, [...before], values)[0];
    if (pick) return { kind: "text", pattern: escapeRx(pick.name || pick.text), frame: pick.frame };
    const changed = urlChange(rec.pre, obs);
    if (changed) return { kind: "url", pattern: escapeRx(parameterize(changed, inputs)).replace(/\\\{\\\{(\w+)\\\}\\\}/g, "[^/?#]+") };
  }
  return undefined;
}

/**
 * Landmarks new in this observation, best first: headings, then top-level cells, then
 * longer text, within the frame that changed the most. Text containing an input value
 * is never a landmark; it would only hold for the recorded input.
 */
function landmarksOf(obs: Observation, beforeKeys: string[], values: string[]): NodeInfo[] {
  const before = new Set(beforeKeys);
  const fresh = obs.nodes.filter((x) => !before.has(key(x)) && isLandmark(x) && !values.some((v) => (x.name || x.text).includes(v)));
  const byFrame = new Map<string, number>();
  for (const x of fresh) byFrame.set(x.frame.join("/"), (byFrame.get(x.frame.join("/")) ?? 0) + 1);
  // Ties go to the frame that takes up the most screen: the content pane, not a nav rail or banner.
  const area = (f: string) => {
    const own = obs.nodes.filter((x) => x.frame.join("/") === f);
    return Math.max(0, ...own.map((x) => x.bbox.x + x.bbox.w)) * Math.max(0, ...own.map((x) => x.bbox.y + x.bbox.h));
  };
  const busiest = [...byFrame.entries()].sort((a, b) => b[1] - a[1] || area(b[0]) - area(a[0]))[0]?.[0];
  const rank = (x: NodeInfo) => (x.role === "heading" ? 0 : x.role === "cell" ? 1 : (x.text || x.name).length >= 12 ? 2 : 3);
  return fresh.filter((x) => busiest === undefined || x.frame.join("/") === busiest).sort((a, b) => rank(a) - rank(b));
}

const key = (n: NodeInfo) => `${n.frame.join("/")}|${n.role}|${n.name || n.text}`;
const isLandmark = (n: NodeInfo) =>
  (n.role === "heading" || ((n.role === "cell" || n.role === "text") && n.depth === 0)) &&
  (n.name || n.text).length >= 4 && !/\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}/.test(n.name || n.text);

function urlChange(pre: Observation, post: Observation): string | undefined {
  const preUrls = new Set([pre.url, ...pre.frames.map((f) => f.url)]);
  const fresh = [post.url, ...post.frames.map((f) => f.url)].find((u) => !preUrls.has(u));
  if (!fresh) return undefined;
  try { const u = new URL(fresh); return u.pathname + u.search; } catch { return fresh; }
}

export function describeTarget(t: Target): string { return t.describe; }

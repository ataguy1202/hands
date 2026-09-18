/**
 * One evaluator for every Condition in an artifact: step checkpoints, the
 * success condition, outcome detectors, recovery and escalation triggers.
 */
import type { Condition } from "../schema/capability.js";
import type { Observation } from "../surface/types.js";
import { resolveTarget, describeStrategy } from "../surface/targets.js";

/** The text an operator can read, one node per line, optionally limited to a frame. */
export function visibleText(obs: Observation, frame?: string[]): string {
  const key = frame?.join("/");
  return obs.nodes
    .filter((n) => key === undefined || n.frame.join("/") === key)
    .map((n) => n.role === "row" ? "" : n.text || n.name)
    .filter(Boolean)
    .join("\n");
}

export type Verdict = { ok: boolean; detail: string };

export function evaluate(cond: Condition, obs: Observation): Verdict {
  switch (cond.kind) {
    case "visible": {
      const r = resolveTarget(cond.target, obs);
      return r.ok ? { ok: true, detail: `${cond.target.describe} visible via ${r.strategy}` } : { ok: false, detail: `${cond.target.describe} not visible (${r.detail})` };
    }
    case "text": {
      const rx = new RegExp(cond.pattern, "i");
      const corpus = visibleText(obs, cond.frame);
      const m = corpus.match(rx);
      return m ? { ok: true, detail: `text matched /${cond.pattern}/: "${m[0].slice(0, 80)}"` } : { ok: false, detail: `no visible text matched /${cond.pattern}/` };
    }
    case "url": {
      const rx = new RegExp(cond.pattern, "i");
      const urls = [obs.url, ...obs.frames.map((f) => f.url)];
      const hit = urls.find((u) => rx.test(u));
      return hit ? { ok: true, detail: `url ${hit} matched /${cond.pattern}/` } : { ok: false, detail: `no url matched /${cond.pattern}/ (saw ${urls.join(", ")})` };
    }
    case "dialog": {
      if (!obs.dialog) return { ok: false, detail: "no native dialog is open" };
      const ok = new RegExp(cond.pattern, "i").test(obs.dialog.message);
      return { ok, detail: ok ? `dialog "${obs.dialog.message.slice(0, 80)}"` : `dialog message did not match /${cond.pattern}/` };
    }
    case "all_of": {
      for (const c of cond.conditions) { const v = evaluate(c, obs); if (!v.ok) return v; }
      return { ok: true, detail: `all ${cond.conditions.length} conditions held` };
    }
    case "any_of": {
      const details: string[] = [];
      for (const c of cond.conditions) { const v = evaluate(c, obs); if (v.ok) return v; details.push(v.detail); }
      return { ok: false, detail: details.join("; ") };
    }
    case "not": {
      const v = evaluate(cond.condition, obs);
      return { ok: !v.ok, detail: v.ok ? `unexpectedly present: ${v.detail}` : `absent as required` };
    }
  }
}

export function describeCondition(cond: Condition): string {
  switch (cond.kind) {
    case "visible": return `${cond.target.describe} visible (${cond.target.strategies.map(describeStrategy).join(" | ")})`;
    case "text": return `text /${cond.pattern}/${cond.frame ? ` in frame ${cond.frame.join("/")}` : ""}`;
    case "url": return `url /${cond.pattern}/`;
    case "dialog": return `native dialog /${cond.pattern}/`;
    case "all_of": return `all of [${cond.conditions.map(describeCondition).join(", ")}]`;
    case "any_of": return `any of [${cond.conditions.map(describeCondition).join(", ")}]`;
    case "not": return `not (${describeCondition(cond.condition)})`;
  }
}

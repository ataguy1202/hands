/**
 * Targets: how a recorded step finds its control again.
 *
 * deriveTarget() runs at record time and keeps only the strategies that
 * uniquely identified the control in the observation it was recorded from.
 * resolveTarget() runs at replay time and walks the list in order, so the
 * most semantic strategy that still works wins, and a fallback is reported
 * as drift instead of silently masking it.
 */
import type { Target, TargetStrategy } from "../schema/capability.js";
import type { NodeInfo, Observation, Resolution } from "./types.js";

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const looksLikeValue = (s: string) => /^[-$(]?[\d,.]+%?\)?$/.test(s.trim()) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s.trim());
const sameFrame = (a: string[], b: string[]) => a.join("/") === b.join("/");

export function matches(strategy: TargetStrategy, n: NodeInfo): boolean {
  switch (strategy.kind) {
    case "role":
      return n.role === strategy.role && (strategy.name === undefined || norm(n.name) === norm(strategy.name));
    case "anchor":
      return n.tag === strategy.tag && norm(n.anchor) === norm(strategy.text);
    case "attr":
      return n.tag === strategy.tag && Object.entries(strategy.attrs).every(([k, v]) => (k === "type" ? n.type === v : n.attrs[k] === v));
    case "text":
      return (!strategy.tag || n.tag === strategy.tag) && norm(n.text || n.name) === norm(strategy.text);
    case "cell":
      return n.role === "cell" && !!n.cell && norm(n.cell.column) === norm(strategy.column) && n.cell.rowText.some((t) => norm(t) === norm(strategy.rowContains));
    case "css":
      return n.css === strategy.selector;
  }
}

export function describeStrategy(s: TargetStrategy): string {
  switch (s.kind) {
    case "role": return `role ${s.role}${s.name ? ` "${s.name}"` : ""}`;
    case "anchor": return `${s.tag} anchored to "${s.text}"`;
    case "attr": return `${s.tag}[${Object.entries(s.attrs).map(([k, v]) => `${k}=${v}`).join(",")}]`;
    case "text": return `text "${s.text}"`;
    case "cell": return `cell column "${s.column}" in row with "${s.rowContains}"`;
    case "css": return `css ${s.selector}`;
  }
}

/** Candidate strategies for a node, most semantic first. Uniqueness is checked by the caller. */
function candidateStrategies(n: NodeInfo): TargetStrategy[] {
  const out: TargetStrategy[] = [];
  const isField = ["textbox", "combobox", "checkbox", "radio"].includes(n.role);
  const isCaptioned = ["link", "button", "heading", "columnheader", "text", "cell"].includes(n.role);

  if (n.role === "cell" && n.cell) {
    // Pick the row anchor: the first cell in the row that is not a value and not this cell's own text.
    const anchor = n.cell.rowText.find((t) => t && norm(t) !== norm(n.text) && !looksLikeValue(t));
    if (anchor && n.cell.column) out.push({ kind: "cell", column: n.cell.column, rowContains: anchor });
  }
  if (n.name && (isField || ["link", "button", "heading", "img", "dialog"].includes(n.role))) {
    out.push({ kind: "role", role: n.role, name: n.name });
  }
  if ((isField || n.role === "cell") && n.anchor) out.push({ kind: "anchor", text: n.anchor, tag: n.tag });
  if (n.attrs.name) {
    const attrs: Record<string, string> = { name: n.attrs.name };
    if (n.type) attrs.type = n.type;
    out.push({ kind: "attr", tag: n.tag, attrs });
  }
  if (isCaptioned && (n.text || n.name) && !looksLikeValue(n.text || n.name)) {
    out.push({ kind: "text", text: n.text || n.name, tag: n.tag });
  }
  out.push({ kind: "css", selector: n.css });
  return out;
}

export function deriveTarget(node: NodeInfo, observation: Observation): Target {
  const peers = observation.nodes.filter((n) => sameFrame(n.frame, node.frame));
  const strategies = candidateStrategies(node).filter((s) => {
    const hits = peers.filter((n) => matches(s, n));
    return hits.length === 1 && hits[0]!.ref === node.ref;
  });
  const fingerprint: Target["fingerprint"] = { tag: node.tag, role: node.role };
  if (node.type) fingerprint.type = node.type;
  if (node.name && CAPTIONED.includes(node.role)) fingerprint.name = node.name;
  return {
    describe: describeNode(node),
    frame: node.frame,
    strategies: strategies.length ? strategies : [{ kind: "css", selector: node.css }],
    fingerprint,
  };
}

export function describeNode(n: NodeInfo): string {
  const label = n.name || n.text;
  return label ? `${n.role} "${label.slice(0, 60)}"` : `${n.role} <${n.tag}>`;
}

/** Roles whose accessible name is part of their identity. */
const CAPTIONED = ["button", "link", "textbox", "combobox", "checkbox", "radio", "dialog", "heading", "img"];

export function fingerprintMatches(fp: Target["fingerprint"], n: NodeInfo): boolean {
  return n.tag === fp.tag && n.role === fp.role && (!fp.type || n.type === fp.type) && (!fp.name || norm(n.name) === norm(fp.name));
}

export function resolveTarget(target: Target, observation: Observation): Resolution {
  const peers = observation.nodes.filter((n) => sameFrame(n.frame, target.frame));
  let ambiguous: string | undefined;
  for (let i = 0; i < target.strategies.length; i++) {
    const s = target.strategies[i]!;
    const hits = peers.filter((n) => matches(s, n) && fingerprintMatches(target.fingerprint, n));
    if (hits.length === 1) return { ok: true, ref: hits[0]!.ref, node: hits[0]!, strategyIndex: i, strategy: describeStrategy(s) };
    if (hits.length > 1) ambiguous = `${describeStrategy(s)} matched ${hits.length} controls`;
  }
  if (ambiguous) return { ok: false, reason: "ambiguous", detail: ambiguous };
  return {
    ok: false,
    reason: "not_found",
    detail: `none of ${target.strategies.length} strategies matched in frame [${target.frame.join("/") || "top"}]: ${target.strategies.map(describeStrategy).join("; ")}`,
  };
}

import { describe, expect, it } from "vitest";
import { deriveTarget, resolveTarget } from "../src/surface/targets.js";
import { Guard, Policy } from "../src/policy/policy.js";
import { Redactor } from "../src/policy/redact.js";
import { parseValue } from "../src/replay/parse.js";
import { evaluate } from "../src/replay/conditions.js";
import type { NodeInfo, Observation } from "../src/surface/types.js";

const node = (partial: Partial<NodeInfo> & { ref: string; role: string }): NodeInfo => ({
  frame: ["main"], name: "", tag: "td", attrs: {}, text: "", depth: 0, css: `body > ${partial.ref}`, bbox: { x: 0, y: 0, w: 10, h: 10 }, ...partial,
});
const obs = (nodes: NodeInfo[]): Observation => ({ at: "", url: "http://x/", title: "", frames: [{ path: ["main"], url: "http://x/main" }], nodes, tree: "" });

describe("target resolution", () => {
  const field = node({ ref: "e1", role: "textbox", name: "Member Number", tag: "input", type: "text", attrs: { name: "mbrno" }, anchor: "Member Number" });
  const recorded = obs([node({ ref: "e0", role: "cell", text: "Member Number" }), field, node({ ref: "e2", role: "button", name: "Search", tag: "input", type: "submit" })]);
  const target = deriveTarget(field, recorded);

  it("keeps only strategies that were unique at record time, most semantic first", () => {
    expect(target.strategies.map((s) => s.kind)).toEqual(["role", "anchor", "attr", "css"]);
    expect(target.fingerprint).toEqual({ tag: "input", type: "text", role: "textbox", name: "Member Number" });
  });

  it("falls back down the chain and reports which strategy matched", () => {
    // A restyled screen: label text changed, field name kept. Role and anchor fail, attr matches.
    const drifted = obs([node({ ref: "e9", role: "textbox", name: "Member No.", tag: "input", type: "text", attrs: { name: "mbrno" }, anchor: "Member No." })]);
    const r = resolveTarget({ ...target, fingerprint: { tag: "input", type: "text", role: "textbox" } }, drifted);
    expect(r).toMatchObject({ ok: true, ref: "e9", strategyIndex: 2 });
  });

  it("rejects a structural match whose identity does not fit the fingerprint", () => {
    const other = obs([node({ ref: "e5", role: "dialog", name: "Compliance Attestation", tag: "table", css: "body > table" })]);
    const dialogTarget = { describe: "dialog", frame: ["main"], strategies: [{ kind: "css" as const, selector: "body > table" }], fingerprint: { tag: "table", role: "dialog", name: "System Notice" } };
    expect(resolveTarget(dialogTarget, other)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("calls out ambiguity instead of guessing", () => {
    const twins = obs([node({ ref: "a", role: "button", name: "Search", tag: "input", type: "submit" }), node({ ref: "b", role: "button", name: "Search", tag: "input", type: "submit" })]);
    const t = deriveTarget(twins.nodes[0]!, twins);
    expect(t.strategies.map((s) => s.kind)).toEqual(["css"]);
    const r = resolveTarget({ ...t, strategies: [{ kind: "role", role: "button", name: "Search" }] }, twins);
    expect(r).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("addresses grid cells by column and row anchor, never by their value", () => {
    const cell = node({ ref: "c3", role: "cell", text: "$4,212.18", cell: { column: "Current Balance", rowText: ["S01", "Regular Savings", "$4,212.18"] } });
    const t = deriveTarget(cell, obs([cell]));
    expect(t.strategies[0]).toEqual({ kind: "cell", column: "Current Balance", rowContains: "S01" });
    expect(t.strategies.some((s) => s.kind === "text")).toBe(false);
  });
});

describe("policy", () => {
  const guard = new Guard(Policy.parse({
    id: "t", allowedOrigins: ["http://localhost:4100"], allowedPaths: ["^/member/", "^/login$"], deniedPaths: ["^/__faults"],
    allowedActions: ["navigate", "click", "type"],
    irreversible: { mode: "confirm", buttonPatterns: ["^open account$"], dialogPatterns: ["cannot be undone"] },
    redaction: { patterns: {}, secretNames: [] }, escalation: {},
  }));
  const at = { url: "http://localhost:4100/member/1" };

  it("enforces origin, path allowlist and denylist", () => {
    expect(guard.check({ kind: "navigate", url: "http://localhost:4100/member/2" }, at).allowed).toBe(true);
    expect(guard.check({ kind: "navigate", url: "http://evil.example/member/2" }, at)).toMatchObject({ allowed: false });
    expect(guard.check({ kind: "navigate", url: "/reports" }, at)).toMatchObject({ allowed: false });
    expect(guard.check({ kind: "navigate", url: "/__faults" }, at)).toMatchObject({ allowed: false });
    expect(guard.check({ kind: "navigate", url: "javascript:alert(1)" }, at)).toMatchObject({ allowed: false });
  });

  it("checks link destinations before a click and refuses unlisted action kinds", () => {
    const link = node({ ref: "l", role: "link", name: "Reports", tag: "a", attrs: { href: "/reports" } });
    expect(guard.check({ kind: "click", ref: "l" }, { ...at, node: link })).toMatchObject({ allowed: false });
    expect(guard.check({ kind: "select", ref: "x", value: "1" }, at)).toMatchObject({ allowed: false });
  });

  it("classifies irreversible controls and dialogs", () => {
    const open = node({ ref: "b", role: "button", name: "Open Account", tag: "input", type: "submit" });
    expect(guard.check({ kind: "click", ref: "b" }, { ...at, node: open })).toMatchObject({ allowed: true, risk: "irreversible" });
    expect(guard.classifyDialog("This cannot be undone.")).toBe("irreversible");
    expect(guard.classifyDialog("Session will expire in 5 minutes.")).toBe("safe");
  });
});

describe("redaction", () => {
  const r = new Redactor(Policy.parse({
    id: "t", allowedOrigins: ["http://x"], allowedActions: [], irreversible: {}, escalation: {},
    redaction: { patterns: { ssn: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }, secretNames: ["PW"] },
  }), { PW: "meridian1" });

  it("scrubs secrets, sensitive inputs and pattern matches, deeply", () => {
    r.addSensitiveValue("2468");
    expect(r.text("typed meridian1 then SSN 123-45-6789 and pin 2468")).toBe("typed [secret] then SSN [redacted:ssn] and pin [redacted]");
    expect(r.value({ a: ["meridian1", { b: "123-45-6789" }] })).toEqual({ a: ["[secret]", { b: "[redacted:ssn]" }] });
  });
});

describe("parsing and conditions", () => {
  it("parses money and numbers as shown on legacy screens", () => {
    expect(parseValue("$4,212.18", "money")).toBe(4212.18);
    expect(parseValue("-$9,750.00", "money")).toBe(-9750);
    expect(parseValue("(1,000.00)", "money")).toBe(-1000);
    expect(parseValue("abc", "number")).toBeUndefined();
    expect(parseValue("  Okafor, Margaret A ", "text")).toBe("Okafor, Margaret A");
  });

  it("evaluates text conditions per frame and url conditions across frames", () => {
    const o = obs([node({ ref: "t", role: "cell", text: "Member Detail" })]);
    expect(evaluate({ kind: "text", pattern: "member detail", frame: ["main"] }, o).ok).toBe(true);
    expect(evaluate({ kind: "text", pattern: "member detail", frame: ["nav"] }, o).ok).toBe(false);
    expect(evaluate({ kind: "url", pattern: "/main$" }, o).ok).toBe(true);
    expect(evaluate({ kind: "not", condition: { kind: "text", pattern: "Permission Denied" } }, o).ok).toBe(true);
  });
});

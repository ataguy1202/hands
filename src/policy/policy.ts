/**
 * Guardrails. Enforced at the surface boundary, for discovery and replay
 * alike, so no prompt wording and no artifact content can widen them.
 */
import { z } from "zod";
import fs from "node:fs";
import type { NodeInfo, SurfaceAction } from "../surface/types.js";

export const Policy = z.object({
  id: z.string(),
  allowedOrigins: z.array(z.string()).min(1),
  allowedPaths: z.array(z.string()).default([".*"]),   // regexes over the path; at least one must match
  deniedPaths: z.array(z.string()).default([]),        // regexes; any match denies, wins over allowedPaths
  allowedActions: z.array(z.enum(["navigate", "click", "type", "select", "press", "dialog", "extract"])),
  irreversible: z.object({
    // block: never perform. confirm: pause for a human decision. allow: perform and flag in evidence.
    mode: z.enum(["block", "confirm", "allow"]).default("confirm"),
    buttonPatterns: z.array(z.string()).default([]),
    dialogPatterns: z.array(z.string()).default([]),
  }),
  redaction: z.object({
    patterns: z.record(z.string(), z.string()).default({}),  // name -> regex
    secretNames: z.array(z.string()).default([]),             // env vars whose values must never appear anywhere
  }),
  escalation: z.object({
    consolePort: z.number().int().default(4700),
    timeoutMs: z.number().int().default(10 * 60_000),
  }),
});
export type Policy = z.infer<typeof Policy>;

export type Risk = "safe" | "irreversible";
export type PolicyDecision = { allowed: true; risk: Risk } | { allowed: false; reason: string; risk: Risk };

export function loadPolicy(path: string): Policy {
  return Policy.parse(JSON.parse(fs.readFileSync(path, "utf8")));
}

export class Guard {
  private readonly origins: string[];
  private readonly allowed: RegExp[];
  private readonly denied: RegExp[];
  private readonly buttonRx: RegExp[];
  private readonly dialogRx: RegExp[];

  constructor(readonly policy: Policy) {
    this.origins = policy.allowedOrigins.map((o) => new URL(o).origin);
    this.allowed = policy.allowedPaths.map((p) => new RegExp(p, "i"));
    this.denied = policy.deniedPaths.map((p) => new RegExp(p, "i"));
    this.buttonRx = policy.irreversible.buttonPatterns.map((p) => new RegExp(p, "i"));
    this.dialogRx = policy.irreversible.dialogPatterns.map((p) => new RegExp(p, "i"));
  }

  urlAllowed(url: string, base?: string): { ok: true } | { ok: false; reason: string } {
    let u: URL;
    try { u = new URL(url, base); } catch { return { ok: false, reason: `unparseable url ${url}` }; }
    if (u.protocol === "javascript:") return { ok: false, reason: "javascript: urls are not permitted" };
    if (!this.origins.includes(u.origin)) return { ok: false, reason: `origin ${u.origin} is not in the allowlist` };
    if (this.denied.some((r) => r.test(u.pathname))) return { ok: false, reason: `path ${u.pathname} is denied` };
    if (!this.allowed.some((r) => r.test(u.pathname))) return { ok: false, reason: `path ${u.pathname} is not in the allowlist` };
    return { ok: true };
  }

  /** Is this control one whose activation we should treat as irreversible? */
  classifyControl(node: NodeInfo | undefined): Risk {
    if (!node) return "safe";
    const caption = node.name || node.text;
    return node.role === "button" && this.buttonRx.some((r) => r.test(caption)) ? "irreversible" : "safe";
  }

  classifyDialog(message: string): Risk {
    return this.dialogRx.some((r) => r.test(message)) ? "irreversible" : "safe";
  }

  /**
   * Decide whether an action may run. The caller passes the current URL and, for
   * ref-based actions, the perceived node so link destinations and button
   * captions can be checked before anything is dispatched.
   */
  check(action: SurfaceAction, ctx: { url: string; node?: NodeInfo; dialogMessage?: string }): PolicyDecision {
    if (!this.policy.allowedActions.includes(action.kind)) {
      return { allowed: false, reason: `action "${action.kind}" is not permitted by policy`, risk: "safe" };
    }
    if (action.kind === "navigate") {
      const r = this.urlAllowed(action.url, ctx.url);
      return r.ok ? { allowed: true, risk: "safe" } : { allowed: false, reason: r.reason, risk: "safe" };
    }
    if (action.kind === "click" && ctx.node?.role === "link" && ctx.node.attrs.href) {
      const r = this.urlAllowed(ctx.node.attrs.href, ctx.url);
      if (!r.ok) return { allowed: false, reason: `link leads outside the allowlist: ${r.reason}`, risk: "safe" };
    }
    let risk: Risk = "safe";
    if (action.kind === "click") risk = this.classifyControl(ctx.node);
    if (action.kind === "dialog" && action.respond === "accept" && ctx.dialogMessage) risk = this.classifyDialog(ctx.dialogMessage);
    if (risk === "irreversible" && this.policy.irreversible.mode === "block") {
      return { allowed: false, reason: "irreversible action blocked by policy", risk };
    }
    return { allowed: true, risk };
  }
}

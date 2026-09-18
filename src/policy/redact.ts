/**
 * Redaction. Applied to everything that leaves the process boundary: model
 * prompts, evidence logs, artifacts, the operator console. Secret values are
 * taken from the environment at construction so they can be scrubbed wherever
 * they might be echoed, without ever being written down.
 */
import type { Policy } from "./policy.js";

export class Redactor {
  private readonly patterns: { name: string; rx: RegExp }[];
  private readonly secrets: string[];
  private readonly sensitiveValues = new Set<string>();

  constructor(policy: Policy, env: NodeJS.ProcessEnv = process.env) {
    this.patterns = Object.entries(policy.redaction.patterns).map(([name, p]) => ({ name, rx: new RegExp(p, "g") }));
    this.secrets = policy.redaction.secretNames.map((n) => env[n] ?? "").filter((v) => v.length >= 4);
  }

  /** Register a per-invocation value (an input marked sensitive) so it is masked in logs. */
  addSensitiveValue(v: unknown) {
    const s = String(v ?? "");
    if (s.length >= 3) this.sensitiveValues.add(s);
  }

  text(s: string): string {
    let out = s;
    for (const v of this.secrets) out = out.split(v).join("[secret]");
    for (const v of this.sensitiveValues) out = out.split(v).join("[redacted]");
    for (const { name, rx } of this.patterns) out = out.replace(rx, `[redacted:${name}]`);
    return out;
  }

  /** Deep-redact strings inside any JSON-serialisable value. */
  value<T>(v: T): T {
    if (typeof v === "string") return this.text(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.value(x)) as T;
    if (v && typeof v === "object" && !(v instanceof Buffer)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = this.value(x);
      return out as T;
    }
    return v;
  }
}

/**
 * Evidence for one run: a structured event log, screenshots, perceived-tree
 * snapshots, and whatever the run produced (artifact, result). Everything
 * passes through the redactor on the way to disk.
 */
import fs from "node:fs";
import path from "node:path";
import type { Redactor } from "../policy/redact.js";
import { renderReport } from "./report.js";

export type RunKind = "discovery" | "replay";

export type RunEvent = {
  seq: number;
  at: string;
  type: string;
  [k: string]: unknown;
};

export class RunLog {
  readonly id: string;
  readonly dir: string;
  readonly startedAt = new Date();
  private seq = 0;
  private events: RunEvent[] = [];
  private files = 0;

  constructor(readonly kind: RunKind, name: string, private readonly redactor: Redactor, root = "evidence", id?: string) {
    const stamp = this.startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    this.id = id ?? `${kind}-${name}-${stamp}`;
    this.dir = path.join(root, this.id);
    fs.mkdirSync(path.join(this.dir, "steps"), { recursive: true });
    fs.mkdirSync(path.join(this.dir, "snapshots"), { recursive: true });
  }

  event(type: string, data: Record<string, unknown> = {}): RunEvent {
    const e: RunEvent = { seq: ++this.seq, at: new Date().toISOString(), type, ...this.redactor.value(data) };
    this.events.push(e);
    fs.appendFileSync(path.join(this.dir, "events.jsonl"), JSON.stringify(e) + "\n");
    return e;
  }

  screenshot(label: string, png: Buffer): string | undefined {
    if (!png.length) return undefined;
    const rel = path.join("steps", `${String(++this.files).padStart(2, "0")}-${safe(label)}.png`);
    fs.writeFileSync(path.join(this.dir, rel), png);
    return rel;
  }

  snapshot(label: string, tree: string): string {
    const rel = path.join("snapshots", `${String(++this.files).padStart(2, "0")}-${safe(label)}.txt`);
    fs.writeFileSync(path.join(this.dir, rel), this.redactor.text(tree));
    return rel;
  }

  write(name: string, value: unknown): string {
    const p = path.join(this.dir, name);
    fs.writeFileSync(p, typeof value === "string" ? this.redactor.text(value) : JSON.stringify(this.redactor.value(value), null, 2));
    return p;
  }

  finish(summary: Record<string, unknown>) {
    this.event("run.finished", { ...summary, durationMs: Date.now() - this.startedAt.getTime() });
    fs.writeFileSync(path.join(this.dir, "report.html"), renderReport({ id: this.id, kind: this.kind, events: this.events, summary }));
  }
}

const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "step";

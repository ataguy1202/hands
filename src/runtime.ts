/**
 * Wiring shared by every command: browser, policy, redaction, evidence,
 * control plane, operator console. One place to see what a run consists of.
 */
import fs from "node:fs";
import path from "node:path";
import { Guard, loadPolicy, type Policy } from "./policy/policy.js";
import { Redactor } from "./policy/redact.js";
import { RunLog, type RunKind } from "./evidence/run.js";
import { ControlPlane } from "./session/control.js";
import { OperatorConsole } from "./session/console.js";
import { WebSurface } from "./surface/web.js";
import { Capability } from "./schema/capability.js";

export type Runtime = {
  policy: Policy;
  guard: Guard;
  redactor: Redactor;
  log: RunLog;
  surface: WebSurface;
  control: ControlPlane;
  console: OperatorConsole;
  close(): Promise<void>;
};

export async function bootstrap(opts: {
  policyPath: string;
  kind: RunKind;
  name: string;
  headed?: boolean;
  evidenceRoot?: string;
  capability?: string;
  goal?: string;
  consolePort?: number;
}): Promise<Runtime> {
  const policy = loadPolicy(opts.policyPath);
  const guard = new Guard(policy);
  const redactor = new Redactor(policy);
  const log = new RunLog(opts.kind, opts.name, redactor, opts.evidenceRoot ?? "evidence");
  const surface = await WebSurface.launch({ headed: opts.headed ?? false });
  const control = new ControlPlane(surface, log, redactor, { timeoutMs: policy.escalation.timeoutMs, runId: log.id, capability: opts.capability, goal: opts.goal });
  const port = opts.consolePort ?? policy.escalation.consolePort;
  const operatorConsole = new OperatorConsole(control, log.dir, port);
  await operatorConsole.start();
  surface.onDialog = (info, decision) => log.event("dialog.native", { type: info.type, message: info.message, decision });
  return {
    policy, guard, redactor, log, surface, control, console: operatorConsole,
    async close() { await operatorConsole.stop(); await surface.close(); },
  };
}

// ---------- capability files ----------

export const CAPABILITY_DIR = "capabilities";

export function capabilityPath(cap: { name: string; version: number }, dir = CAPABILITY_DIR): string {
  return path.join(dir, `${cap.name}.v${cap.version}.json`);
}

export function loadCapability(file: string): Capability {
  return Capability.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function saveCapability(cap: Capability, dir = CAPABILITY_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = capabilityPath(cap, dir);
  fs.writeFileSync(p, JSON.stringify(cap, null, 2) + "\n");
  return p;
}

export function listCapabilities(dir = CAPABILITY_DIR): { file: string; cap: Capability }[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: path.join(dir, f), cap: loadCapability(path.join(dir, f)) }));
}

/** Resolve a capability by name or file. By name, the highest version wins. */
export function findCapability(ref: string, dir = CAPABILITY_DIR): { file: string; cap: Capability } {
  if (fs.existsSync(ref)) return { file: ref, cap: loadCapability(ref) };
  const matches = listCapabilities(dir).filter((c) => c.cap.name === ref).sort((a, b) => b.cap.version - a.cap.version);
  if (!matches.length) throw new Error(`no capability named "${ref}" in ${dir}`);
  return matches[0]!;
}

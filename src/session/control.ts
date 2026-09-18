/**
 * Who is driving the session. Exactly one party holds control at a time:
 * automation, or a human operator who took it through an intervention.
 *
 * Automation raises an intervention and blocks until it is resolved. For a
 * takeover the human takes control, acts on the same live session (in the
 * headed browser, or through the console's remote-hands panel), and hands
 * control back with a decision about the step that was interrupted. For an
 * approval nobody takes control; the human decides and automation continues.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { RunLog } from "../evidence/run.js";
import type { Redactor } from "../policy/redact.js";
import type { WebSurface, HumanEvent } from "../surface/web.js";
import type { Observation, SurfaceAction } from "../surface/types.js";

export type Controller = "automation" | "human";
export type InterventionKind = "approval" | "takeover";
export type Resolution = "approved" | "denied" | "retry_step" | "skip_step" | "abort" | "timeout";

export type Intervention = {
  id: string;
  kind: InterventionKind;
  runId: string;
  capability?: string;
  goal?: string;
  atStep?: string;
  reason: string;
  context: { url: string; tree: string; screenshot?: string };
  raisedAt: string;
  state: "open" | "human_in_control" | "resolved";
  takenAt?: string;
  resolvedAt?: string;
  resolution?: Resolution;
  humanActions: HumanEvent[];
};

export class NotInControlError extends Error {
  constructor(msg = "automation does not hold control of the session") { super(msg); }
}

export class ControlPlane {
  controller: Controller = "automation";
  private readonly items = new Map<string, Intervention>();
  private readonly waiters = new Map<string, (r: Resolution) => void>();
  private readonly dir: string;
  private lastObservation?: Observation;

  constructor(
    private readonly surface: WebSurface,
    private readonly log: RunLog,
    private readonly redactor: Redactor,
    private readonly opts: { timeoutMs: number; runId: string; capability?: string; goal?: string },
  ) {
    this.dir = path.join(log.dir, "interventions");
    fs.mkdirSync(this.dir, { recursive: true });
    surface.onHumanEvent = (e) => this.recordHuman(e);
  }

  assertAutomation() {
    if (this.controller !== "automation") throw new NotInControlError();
  }

  list(): Intervention[] {
    return [...this.items.values()].sort((a, b) => (a.state === "resolved" ? 1 : 0) - (b.state === "resolved" ? 1 : 0) || b.raisedAt.localeCompare(a.raisedAt));
  }
  get(id: string): Intervention | undefined { return this.items.get(id); }
  open(): Intervention | undefined { return this.list().find((i) => i.state !== "resolved"); }

  /** Raise an intervention and wait for a person. Resolves with their decision. */
  async raise(kind: InterventionKind, input: { reason: string; atStep?: string; observation: Observation }): Promise<Intervention> {
    const id = `int_${randomBytes(4).toString("hex")}`;
    const screenshot = input.observation.screenshot
      ? this.log.screenshot(`intervention-${id}`, input.observation.screenshot)
      : this.log.screenshot(`intervention-${id}`, await this.surface.screenshot());
    const item: Intervention = {
      id, kind, runId: this.opts.runId, capability: this.opts.capability, goal: this.opts.goal,
      atStep: input.atStep, reason: input.reason,
      context: { url: input.observation.url, tree: this.redactor.text(input.observation.tree), screenshot },
      raisedAt: new Date().toISOString(), state: "open", humanActions: [],
    };
    this.items.set(id, item);
    this.lastObservation = input.observation;
    this.persist(item);
    this.log.event("intervention.raised", { id, kind, atStep: input.atStep, reason: input.reason, screenshot, url: input.observation.url });

    const resolution = await new Promise<Resolution>((resolve) => {
      this.waiters.set(id, resolve);
      setTimeout(() => this.resolveWith(id, "timeout"), this.opts.timeoutMs).unref();
    });
    item.resolution = resolution;
    return item;
  }

  /** The human takes the live session. Automation is already blocked in raise(). */
  take(id: string): Intervention {
    const item = this.must(id);
    if (item.kind !== "takeover" || item.state !== "open") throw new Error(`intervention ${id} cannot be taken (${item.kind}, ${item.state})`);
    item.state = "human_in_control";
    item.takenAt = new Date().toISOString();
    this.controller = "human";
    // A person answering a native dialog they raised themselves is not something automation should hold.
    this.surface.dialogPolicy = () => "accept";
    this.persist(item);
    this.log.event("intervention.taken", { id, controller: "human" });
    return item;
  }

  /** The human hands the session back with a decision about the interrupted step. */
  handBack(id: string, resolution: Exclude<Resolution, "approved" | "denied" | "timeout">): Intervention {
    const item = this.must(id);
    if (item.state !== "human_in_control") throw new Error(`intervention ${id} is not in human control`);
    this.controller = "automation";
    this.surface.dialogPolicy = () => "hold";
    this.log.event("intervention.handback", { id, resolution, humanActions: item.humanActions.length });
    return this.resolveWith(id, resolution);
  }

  decide(id: string, decision: "approved" | "denied"): Intervention {
    const item = this.must(id);
    if (item.kind !== "approval" || item.state !== "open") throw new Error(`intervention ${id} cannot be decided (${item.kind}, ${item.state})`);
    this.log.event("intervention.decided", { id, decision });
    return this.resolveWith(id, decision);
  }

  /** Remote hands: act on the live session on the human's behalf, only while they hold control. */
  async humanAct(id: string, action: SurfaceAction): Promise<Observation> {
    const item = this.must(id);
    if (item.state !== "human_in_control") throw new NotInControlError("the human does not hold control for this intervention");
    const obs = await this.surface.observe();
    if ("ref" in action && action.ref) {
      const node = obs.nodes.find((n) => n.ref === action.ref);
      this.recordHuman({ at: new Date().toISOString(), type: `remote.${action.kind}`, frame: node?.frame.join("/") ?? "", detail: node ? `${node.role} "${node.name || node.text}"` : action.ref });
    } else {
      this.recordHuman({ at: new Date().toISOString(), type: `remote.${action.kind}`, frame: "", detail: action.kind === "navigate" ? action.url : action.kind });
    }
    await this.surface.act(action.kind === "type" ? { ...action } : action);
    return this.surface.observe();
  }

  async humanObserve(id: string): Promise<Observation> {
    const item = this.must(id);
    if (item.state !== "human_in_control") throw new NotInControlError("the human does not hold control for this intervention");
    return this.surface.observe();
  }

  async currentObservation(): Promise<Observation> {
    return this.controller === "human" ? this.surface.observe() : (this.lastObservation ?? this.surface.observe());
  }
  async liveScreenshot(): Promise<Buffer> { return this.surface.screenshot(); }

  private recordHuman(e: HumanEvent) {
    if (this.controller !== "human") return;
    const item = [...this.items.values()].find((i) => i.state === "human_in_control");
    if (!item) return;
    const redacted = { ...e, detail: this.redactor.text(e.detail) };
    item.humanActions.push(redacted);
    this.persist(item);
    this.log.event("human.action", { intervention: item.id, ...redacted });
  }

  private resolveWith(id: string, resolution: Resolution): Intervention {
    const item = this.must(id);
    if (item.state === "resolved") return item;
    item.state = "resolved";
    item.resolvedAt = new Date().toISOString();
    item.resolution = resolution;
    if (this.controller === "human") { this.controller = "automation"; this.surface.dialogPolicy = () => "hold"; }
    this.persist(item);
    this.log.event("intervention.resolved", { id, resolution, humanActions: item.humanActions.length });
    this.waiters.get(id)?.(resolution);
    this.waiters.delete(id);
    return item;
  }

  private must(id: string): Intervention {
    const item = this.items.get(id);
    if (!item) throw new Error(`unknown intervention ${id}`);
    return item;
  }

  private persist(item: Intervention) {
    fs.writeFileSync(path.join(this.dir, `${item.id}.json`), JSON.stringify(item, null, 2));
  }
}

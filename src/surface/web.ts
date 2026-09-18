/**
 * Playwright-backed Surface. Perception comes from our walker (not from
 * Playwright's locators), so replay resolves controls the same way discovery
 * saw them. Playwright is used for what it is good at: launching a real
 * browser, dispatching real input, and waiting for actionability.
 */
import { chromium, type Browser, type BrowserContext, type Dialog, type ElementHandle, type Frame, type Page } from "playwright";
import type { Target } from "../schema/capability.js";
import { walkDocument, type RawNode } from "./walker.js";
import { resolveTarget } from "./targets.js";
import type { DialogInfo, NodeInfo, Observation, Resolution, Surface, SurfaceAction } from "./types.js";

export type HumanEvent = { at: string; type: string; frame: string; detail: string };
export type DialogPolicy = (info: DialogInfo) => "accept" | "dismiss" | "hold";

export class StaleRefError extends Error {}

const humanCaptureScript = `
(() => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const describe = (el) => {
    if (!el || !el.tagName) return "";
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["submit","button","reset"].includes(el.type)) return 'button "' + norm(el.value) + '"';
    if (tag === "button") return 'button "' + norm(el.innerText) + '"';
    if (tag === "a") return 'link "' + norm(el.innerText) + '"';
    if (tag === "input" || tag === "textarea" || tag === "select") return tag + (el.name ? "[name=" + el.name + "]" : "");
    return tag + (norm(el.innerText) ? ' "' + norm(el.innerText) + '"' : "");
  };
  const send = (type, detail) => { try { window.__handsHumanEvent && window.__handsHumanEvent({ type, detail, frame: window.name || "" }); } catch (e) {} };
  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest ? e.target.closest("a,button,input,select,label,td,th,div,span,font") : e.target;
    send("click", describe(el));
  }, true);
  document.addEventListener("change", (e) => {
    const el = e.target;
    // Values are never captured. Only the fact that a field changed, and its length.
    const len = el && typeof el.value === "string" ? el.value.length : 0;
    send("change", describe(el) + " value=[redacted " + len + " chars]");
  }, true);
  document.addEventListener("submit", (e) => send("submit", describe(e.target)), true);
})();`;

export class WebSurface implements Surface {
  readonly driver = "playwright-chromium";
  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private last?: Observation;
  private pending?: { dialog: Dialog; info: DialogInfo };
  private inflight?: Promise<unknown>;
  dialogPolicy: DialogPolicy = () => "hold";
  onHumanEvent?: (e: HumanEvent) => void;
  onDialog?: (info: DialogInfo, decision: "accept" | "dismiss" | "hold") => void;

  static async launch(opts: { headed?: boolean; slowMo?: number } = {}): Promise<WebSurface> {
    const s = new WebSurface();
    s.browser = await chromium.launch({ headless: !opts.headed, slowMo: opts.slowMo ?? 0 });
    s.context = await s.browser.newContext({ viewport: { width: 1100, height: 760 } });
    await s.context.exposeBinding("__handsHumanEvent", (_src, e: { type: string; detail: string; frame: string }) => {
      s.onHumanEvent?.({ at: new Date().toISOString(), ...e });
    });
    await s.context.addInitScript(humanCaptureScript);
    s.page = await s.context.newPage();
    s.page.on("dialog", (d) => s.handleDialog(d));
    return s;
  }

  get rawPage(): Page { return this.page; }
  url(): string { return this.page.url(); }
  pendingDialog(): DialogInfo | undefined { return this.pending?.info; }

  private handleDialog(d: Dialog) {
    const info: DialogInfo = { type: d.type() as DialogInfo["type"], message: d.message() };
    const decision = this.dialogPolicy(info);
    this.onDialog?.(info, decision);
    if (decision === "hold") { this.pending = { dialog: d, info }; return; }
    void (decision === "accept" ? d.accept() : d.dismiss());
  }

  async observe(opts: { screenshot?: boolean } = {}): Promise<Observation> {
    if (this.pending) {
      // The page is blocked; reuse the last tree and put the dialog in front of it.
      const base = this.last ?? { at: "", url: this.page.url(), title: "", frames: [], nodes: [], tree: "" };
      const obs: Observation = { ...base, at: new Date().toISOString(), dialog: this.pending.info, tree: `- native ${this.pending.info.type} dialog: "${this.pending.info.message}"\n  (page is blocked until it is answered)\n${base.tree}` };
      return obs;
    }
    const nodes: NodeInfo[] = [];
    let index = 0;
    for (const frame of this.page.frames()) {
      const path = framePath(frame);
      let raw: RawNode[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        try { raw = await frame.evaluate(inPage(walkDocument, index)) as RawNode[]; break; }
        catch { await frame.waitForLoadState("load", { timeout: 3000 }).catch(() => {}); }
      }
      index += raw.length;
      for (const r of raw) nodes.push({ ...r, frame: path });
    }
    const frames = this.page.frames().map((f) => ({ path: framePath(f), url: f.url() }));
    const obs: Observation = {
      at: new Date().toISOString(),
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      frames,
      nodes,
      tree: renderTree(nodes, frames),
    };
    if (opts.screenshot) obs.screenshot = await this.screenshot();
    this.last = obs;
    return obs;
  }

  resolve(target: Target, observation: Observation): Resolution {
    return resolveTarget(target, observation);
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: "png", timeout: 5000 }).catch(() => Buffer.alloc(0));
  }

  private frameByPath(path: string[]): Frame {
    for (const f of this.page.frames()) if (framePath(f).join("/") === path.join("/")) return f;
    throw new StaleRefError(`frame [${path.join("/")}] no longer exists`);
  }

  private async handleFor(ref: string): Promise<ElementHandle<Element>> {
    const node = this.last?.nodes.find((n) => n.ref === ref);
    if (!node) throw new StaleRefError(`ref ${ref} is not in the current observation`);
    const frame = this.frameByPath(node.frame);
    const h = await frame.evaluateHandle((r: string) => window.__hands?.refs[r] ?? null, ref);
    const el = h.asElement();
    if (!el) throw new StaleRefError(`ref ${ref} is no longer attached`);
    return el as ElementHandle<Element>;
  }

  async act(action: SurfaceAction): Promise<void> {
    if (action.kind === "dialog") {
      if (!this.pending) throw new Error("no dialog is pending");
      const { dialog } = this.pending;
      this.pending = undefined;
      if (action.respond === "accept") await dialog.accept(action.text); else await dialog.dismiss();
      await this.awaitInflight();
      await this.settle();
      return;
    }
    if (this.pending) throw new Error(`a native ${this.pending.info.type} dialog is open; answer it first`);

    if (action.kind === "navigate") {
      await this.page.goto(action.url, { waitUntil: "load", timeout: 15000 });
      await this.settle();
      return;
    }
    const timeout = 5000;
    if (action.kind === "press" && !action.ref) {
      await this.page.keyboard.press(action.key);
      await this.settle();
      return;
    }
    const el = await this.handleFor(action.ref!);
    let op: Promise<unknown>;
    switch (action.kind) {
      case "click": op = el.click({ timeout }); break;
      case "type": op = el.fill(action.text, { timeout }); break;
      case "select":
        op = el.selectOption({ label: action.value }, { timeout }).catch(() => el.selectOption({ value: action.value }, { timeout }));
        break;
      case "press": op = el.press(action.key, { timeout }); break;
    }
    // A click can open a native dialog, which blocks the page and therefore the click's own
    // post-action waiting. Let the dialog win the race and leave the click in flight.
    let stopPolling = () => {};
    const dialogOpened = new Promise<"dialog">((resolve) => {
      const timer = setInterval(() => { if (this.pending) { clearInterval(timer); resolve("dialog"); } }, 25);
      stopPolling = () => clearInterval(timer);
    });
    const result = await Promise.race([op.then(() => "done" as const), dialogOpened]);
    stopPolling();
    if (result === "dialog") { this.inflight = op.catch(() => {}); return; }
    await this.settle();
  }

  private async awaitInflight() {
    if (!this.inflight) return;
    const p = this.inflight; this.inflight = undefined;
    await Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
  }

  /** Let navigations finish and the DOM go quiet. Bounded, and never a fixed sleep. */
  async settle(maxMs = 4000): Promise<void> {
    const deadline = Date.now() + maxMs;
    await this.page.waitForLoadState("load", { timeout: maxMs }).catch(() => {});
    for (const f of this.page.frames()) {
      const left = Math.max(200, deadline - Date.now());
      await f.waitForLoadState("load", { timeout: left }).catch(() => {});
      await f.evaluate(inPage(quietDom, Math.min(left, 2000))).catch(() => {});
    }
  }

  async close() { await this.browser.close().catch(() => {}); }
}

/**
 * Serialize a self-contained function for page.evaluate. tsx/esbuild injects a
 * `__name` helper into function source when it keeps names; the shim makes the
 * source valid whether or not that helper is present.
 */
function inPage(fn: (...args: any[]) => unknown, ...args: unknown[]): string {
  return `(() => { const __name = (f) => f; return (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")}); })()`;
}

/** Resolves when the document has had no mutations for 150 ms, or after maxMs. */
function quietDom(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, 150);
    const hard = setTimeout(done, maxMs);
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 150); });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    function done() { mo.disconnect(); clearTimeout(timer); clearTimeout(hard); resolve(); }
  });
}

export function framePath(frame: Frame): string[] {
  const path: string[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    const parent: Frame = f.parentFrame()!;
    const name = f.name() || `#${parent.childFrames().indexOf(f)}`;
    path.unshift(name);
    f = parent;
  }
  return path;
}

export function renderTree(nodes: NodeInfo[], frames: { path: string[]; url: string }[]): string {
  const lines: string[] = [];
  for (const fr of frames) {
    const own = nodes.filter((n) => n.frame.join("/") === fr.path.join("/"));
    if (!own.length && fr.path.length) continue;
    lines.push(`frame ${fr.path.length ? `"${fr.path.join("/")}"` : "(top)"}: ${fr.url}`);
    for (let i = 0; i < own.length; i++) {
      const n = own[i]!;
      const pad = "  ".repeat(n.depth + 1);
      if (n.role === "row") {
        const cells: string[] = [];
        while (i + 1 < own.length && own[i + 1]!.depth > n.depth && ["cell", "columnheader"].includes(own[i + 1]!.role)) {
          const c = own[++i]!;
          cells.push(`${c.role === "columnheader" ? "header" : "cell"} "${c.text}" [${c.ref}]`);
        }
        lines.push(`${pad}- row [${n.ref}]: ${cells.join(" | ")}`);
        continue;
      }
      lines.push(pad + "- " + renderNode(n));
    }
  }
  return lines.join("\n");
}

function renderNode(n: NodeInfo): string {
  const parts: string[] = [n.role];
  const label = n.role === "text" || n.role === "cell" || n.role === "columnheader" || n.role === "heading" ? n.text || n.name : n.name;
  if (label) parts.push(`"${label}"`);
  parts.push(`[${n.ref}]`);
  const extras: string[] = [];
  if (n.type && n.type !== "text" && n.type !== "submit") extras.push(`type=${n.type}`);
  if (n.attrs.name) extras.push(`name=${n.attrs.name}`);
  if (n.value) extras.push(`value="${n.value}"`);
  if (n.options) extras.push(`options: ${n.options.map((o) => `"${o}"`).join(", ")}`);
  if (n.disabled) extras.push("disabled");
  if (n.dialog) extras.push(`in dialog "${n.dialog}"`);
  if (extras.length) parts.push(`(${extras.join("; ")})`);
  return parts.join(" ");
}

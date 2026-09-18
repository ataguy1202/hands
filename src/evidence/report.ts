/**
 * A self-contained HTML view of a run's event log, next to the raw JSONL.
 * For the person debugging a failure at 2am: what happened, in order, with the
 * screenshot that goes with it.
 */
import type { RunEvent, RunKind } from "./run.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const HIDDEN = new Set(["seq", "at", "type", "screenshot", "snapshot"]);

export function renderReport(input: { id: string; kind: RunKind; events: RunEvent[]; summary: Record<string, unknown> }): string {
  const { id, kind, events, summary } = input;
  const t0 = events.length ? Date.parse(events[0]!.at) : Date.now();
  const status = String(summary.status ?? "unknown");

  const rows = events.map((e) => {
    const dt = ((Date.parse(e.at) - t0) / 1000).toFixed(2);
    const fields = Object.entries(e).filter(([k, v]) => !HIDDEN.has(k) && v !== undefined && v !== null && v !== "");
    const detail = fields.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${fmt(v)}</span></div>`).join("");
    const shot = e.screenshot ? `<a class="shot" href="${esc(e.screenshot)}" target="_blank"><img src="${esc(e.screenshot)}" alt="screenshot" loading="lazy"></a>` : "";
    const snap = e.snapshot ? `<a class="snap" href="${esc(e.snapshot)}" target="_blank">perceived tree</a>` : "";
    return `<section class="ev ${esc(e.type.replace(/\./g, "-"))}">
  <div class="meta"><span class="t">+${dt}s</span><span class="ty">${esc(e.type)}</span>${snap}</div>
  <div class="body">${detail}${shot}</div>
</section>`;
  }).join("\n");

  const sum = Object.entries(summary).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${fmt(v)}</span></div>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(id)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { --bg:#fafafa; --fg:#1a1a1a; --mute:#6b6b6b; --line:#e4e4e4; --card:#fff; --ok:#1f7a4d; --bad:#b3261e; --warn:#8a6d00; --acc:#2b4c7e; }
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif }
header { padding:28px 32px 20px; border-bottom:1px solid var(--line); background:var(--card) }
header h1 { margin:0 0 6px; font-size:18px; font-weight:600; letter-spacing:-.01em }
header .sub { color:var(--mute); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px }
.badge { display:inline-block; padding:2px 8px; border-radius:3px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin-left:10px; vertical-align:middle }
.badge.succeeded, .badge.compiled { background:#e3f3ea; color:var(--ok) }
.badge.failed, .badge.aborted { background:#fbe9e7; color:var(--bad) }
.badge.outcome, .badge.escalated { background:#fff4cc; color:var(--warn) }
.badge.unknown { background:#eee; color:var(--mute) }
main { max-width:1100px; margin:0 auto; padding:24px 32px 64px }
.summary { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:14px 18px; margin-bottom:28px; columns:2; column-gap:32px }
.kv { display:flex; gap:12px; padding:3px 0; break-inside:avoid }
.k { color:var(--mute); min-width:120px; flex:0 0 auto; font-size:12px; padding-top:2px }
.v { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; white-space:pre-wrap; word-break:break-word }
.ev { display:grid; grid-template-columns:200px 1fr; gap:18px; padding:12px 0; border-top:1px solid var(--line) }
.ev .meta { display:flex; flex-direction:column; gap:2px }
.ev .t { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--mute) }
.ev .ty { font-weight:600; font-size:13px }
.ev.decide .ty, .ev.intervention-raised .ty, .ev.recovery .ty { color:var(--acc) }
.ev.failure .ty, .ev.step-failed .ty, .ev.policy-blocked .ty { color:var(--bad) }
.ev.outcome .ty, .ev.escalation .ty, .ev.drift .ty { color:var(--warn) }
.ev .snap { font-size:12px; color:var(--acc); text-decoration:none }
.shot { display:block; margin-top:10px; max-width:560px }
.shot img { width:100%; border:1px solid var(--line); border-radius:4px; display:block }
@media (max-width:720px){ .ev{grid-template-columns:1fr} .summary{columns:1} main{padding:16px} header{padding:20px 16px} }
</style></head>
<body>
<header>
  <h1>${esc(id)} <span class="badge ${esc(status)}">${esc(status)}</span></h1>
  <div class="sub">${esc(kind)} run · ${events.length} events · generated ${esc(new Date().toISOString())}</div>
</header>
<main>
  <div class="summary">${sum}</div>
  ${rows}
</main>
</body></html>`;
}

function fmt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return esc(v);
  if (typeof v === "number" || typeof v === "boolean") return esc(String(v));
  return esc(JSON.stringify(v, null, 1).replace(/\n\s*/g, " "));
}

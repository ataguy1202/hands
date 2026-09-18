/**
 * Operator console. Deliberately small: a list of interventions, one page per
 * intervention with the screenshot and the reason, the controls to take and
 * hand back the session, and a remote-hands panel that acts on the same live
 * browser for operators who are not sitting at the headed window.
 *
 * The JSON API under /api is what a real console or a scripted operator uses.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ControlPlane, type Intervention } from "./control.js";
import type { SurfaceAction } from "../surface/types.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class OperatorConsole {
  private server?: http.Server;
  constructor(private readonly plane: ControlPlane, private readonly evidenceDir: string, readonly port: number) {}

  get url() { return `http://localhost:${this.port}`; }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => json(res, 500, { error: String(e?.message ?? e) })));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, resolve);
    });
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    const p = url.pathname;
    const m = (rx: RegExp) => p.match(rx);
    let mm: RegExpMatchArray | null;

    if (p === "/api/interventions") return json(res, 200, { controller: this.plane.controller, interventions: this.plane.list() });
    if ((mm = m(/^\/api\/interventions\/([^/]+)$/))) {
      const it = this.plane.get(mm[1]!);
      return it ? json(res, 200, it) : json(res, 404, { error: "not found" });
    }
    if ((mm = m(/^\/api\/interventions\/([^/]+)\/(take|handback|decide|act|observe)$/)) && req.method === "POST") {
      const [, id, op] = mm;
      const body = await readJson(req);
      if (op === "take") return json(res, 200, this.plane.take(id!));
      if (op === "handback") return json(res, 200, this.plane.handBack(id!, body.resolution));
      if (op === "decide") return json(res, 200, this.plane.decide(id!, body.decision));
      if (op === "observe") { const o = await this.plane.humanObserve(id!); return json(res, 200, { url: o.url, tree: o.tree }); }
      if (op === "act") {
        const o = await this.plane.humanAct(id!, body as SurfaceAction);
        return json(res, 200, { url: o.url, tree: o.tree });
      }
    }
    if ((mm = m(/^\/api\/interventions\/([^/]+)\/screenshot$/))) {
      const png = await this.plane.liveScreenshot();
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return res.end(png);
    }
    if ((mm = m(/^\/evidence\/(.+)$/))) {
      const root = path.resolve(this.evidenceDir);
      const file = path.resolve(root, mm[1]!);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": file.endsWith(".png") ? "image/png" : "text/plain" });
      return res.end(fs.readFileSync(file));
    }
    if ((mm = m(/^\/i\/([^/]+)$/))) {
      const it = this.plane.get(mm[1]!);
      if (!it) return html(res, 404, page("Not found", `<p>No intervention ${esc(mm[1])}.</p>`));
      const tree = it.state === "human_in_control" ? (await this.plane.currentObservation()) : null;
      return html(res, 200, page(it.id, detail(it, this.plane.controller, tree?.tree ?? it.context.tree, tree?.nodes ?? [])));
    }
    if (p === "/") return html(res, 200, page("Interventions", index(this.plane.list(), this.plane.controller)));
    json(res, 404, { error: "not found" });
  }
}

// ---------- rendering ----------

const style = `
:root{--bg:#f6f6f4;--fg:#161616;--mute:#6f6f6f;--line:#e2e2df;--card:#fff;--acc:#2b4c7e;--bad:#b3261e;--ok:#1f7a4d;--warn:#8a6d00}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
header{padding:18px 28px;border-bottom:1px solid var(--line);background:var(--card);display:flex;justify-content:space-between;align-items:center}
header h1{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}header a{color:var(--acc);text-decoration:none;font-size:13px}
.ctl{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--mute)}.ctl b{color:var(--fg)}
main{max-width:1180px;margin:0 auto;padding:24px 28px 64px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:16px 18px;margin-bottom:16px}
.row{display:grid;grid-template-columns:150px 1fr;gap:10px;padding:4px 0}.row .k{color:var(--mute);font-size:12px;padding-top:2px}.row .v{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.badge{display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;vertical-align:middle}
.open{background:#fff4cc;color:var(--warn)}.human_in_control{background:#e4ecf7;color:var(--acc)}.resolved{background:#e3f3ea;color:var(--ok)}
table.list{width:100%;border-collapse:collapse}table.list td,table.list th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;font-size:13px}table.list th{color:var(--mute);font-weight:500;font-size:12px}
table.list a{color:var(--acc);text-decoration:none}
button{font:inherit;font-size:13px;padding:7px 12px;border-radius:4px;border:1px solid var(--line);background:#fff;cursor:pointer}button.primary{background:var(--acc);color:#fff;border-color:var(--acc)}button.danger{color:var(--bad)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:860px){.grid{grid-template-columns:1fr}}
img.shot{width:100%;border:1px solid var(--line);border-radius:4px;display:block}
pre{font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;margin:0;max-height:420px;overflow:auto;background:#fafaf8;border:1px solid var(--line);border-radius:4px;padding:10px}
.ctrl{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px dashed var(--line);font-family:ui-monospace,Menlo,monospace;font-size:12px}.ctrl .n{flex:1}
.ctrl button{padding:3px 9px;font-size:12px}
input[type=text]{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line);border-radius:4px;width:100%}
.note{color:var(--mute);font-size:12px}ul.log{margin:6px 0 0;padding-left:18px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · hands operator</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}</style></head><body>${body}</body></html>`;
}

function index(items: Intervention[], controller: string): string {
  const rows = items.map((i) => `<tr><td><a href="/i/${esc(i.id)}">${esc(i.id)}</a></td><td>${esc(i.kind)}</td><td><span class="badge ${esc(i.state)}">${esc(i.state.replace(/_/g, " "))}</span></td><td>${esc(i.capability ?? i.goal ?? "")}</td><td>${esc(i.atStep ?? "")}</td><td>${esc(i.reason)}</td><td class="note">${esc(i.raisedAt)}</td></tr>`).join("");
  return `<header><h1>hands · operator console</h1><span class="ctl">session control: <b>${esc(controller)}</b></span></header>
<main><div class="card"><table class="list"><tr><th>id</th><th>kind</th><th>state</th><th>capability</th><th>step</th><th>reason</th><th>raised</th></tr>${rows || `<tr><td colspan="7" class="note">No interventions.</td></tr>`}</table></div>
<p class="note">This page refreshes every 3 seconds.</p></main><script>setTimeout(()=>location.reload(),3000)</script>`;
}

function detail(it: Intervention, controller: string, tree: string, nodes: { ref: string; role: string; name: string; text: string }[]): string {
  const rows = (kv: [string, unknown][]) => kv.map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("");
  const live = it.state === "human_in_control";
  const shot = live
    ? `<img class="shot" id="shot" src="/api/interventions/${esc(it.id)}/screenshot?t=0" alt="live session">`
    : it.context.screenshot ? `<img class="shot" src="/evidence/${esc(it.context.screenshot)}" alt="state at escalation">` : `<p class="note">No screenshot.</p>`;

  let actions = "";
  if (it.kind === "approval" && it.state === "open") {
    actions = `<div class="actions"><button class="primary" onclick="post('decide',{decision:'approved'})">Approve and continue</button><button class="danger" onclick="post('decide',{decision:'denied'})">Deny</button></div>
<p class="note">Approving performs the irreversible action exactly once. Denying aborts the run and records the decision.</p>`;
  } else if (it.kind === "takeover" && it.state === "open") {
    actions = `<div class="actions"><button class="primary" onclick="post('take',{})">Take control of the live session</button></div>
<p class="note">Automation is paused. Taking control lets you operate the same browser session; nothing is reset or re-logged-in.</p>`;
  } else if (live) {
    actions = `<div class="actions">
<button class="primary" onclick="post('handback',{resolution:'retry_step'})">Hand back · retry step</button>
<button onclick="post('handback',{resolution:'skip_step'})">Hand back · skip step</button>
<button class="danger" onclick="post('handback',{resolution:'abort'})">Hand back · abort run</button></div>
<p class="note">Retry re-runs the interrupted step from the current state. Skip treats it as done and verifies its checkpoint. Abort ends the run and keeps the evidence.</p>`;
  } else {
    actions = `<p class="note">Resolved: <b>${esc(it.resolution)}</b> at ${esc(it.resolvedAt)}.</p>`;
  }

  const controls = live
    ? nodes.filter((n) => ["button", "link", "textbox", "combobox", "checkbox", "radio"].includes(n.role)).map((n) => {
        const label = `${n.role} "${n.name || n.text}"`;
        const act = n.role === "textbox"
          ? `<button onclick="typeInto('${esc(n.ref)}')">type…</button>`
          : n.role === "combobox" ? `<button onclick="selectIn('${esc(n.ref)}')">select…</button>` : `<button onclick="act({kind:'click',ref:'${esc(n.ref)}'})">click</button>`;
        return `<div class="ctrl"><span class="n">${esc(label)}</span><span class="note">${esc(n.ref)}</span>${act}</div>`;
      }).join("")
    : "";

  return `<header><h1><a href="/">interventions</a> / ${esc(it.id)} <span class="badge ${esc(it.state)}">${esc(it.state.replace(/_/g, " "))}</span></h1><span class="ctl">session control: <b>${esc(controller)}</b></span></header>
<main>
<div class="card">${rows([["kind", it.kind], ["run", it.runId], ["capability / goal", it.capability ?? it.goal ?? ""], ["step", it.atStep ?? ""], ["reason", it.reason], ["url", it.context.url], ["raised", it.raisedAt]])}${actions}</div>
<div class="grid">
  <div class="card"><div class="note" style="margin-bottom:8px">${live ? "Live session (refreshes every 2s)" : "State when escalated"}</div>${shot}</div>
  <div class="card"><div class="note" style="margin-bottom:8px">${live ? "Remote hands: act on the live session" : "Perceived tree at escalation"}</div>
    ${live ? `<div id="controls">${controls}</div><p class="note" style="margin-top:10px">Prefer the headed browser window when you have one. This panel exists for operators who do not.</p>` : `<pre>${esc(tree)}</pre>`}
  </div>
</div>
<div class="card"><div class="note">Human actions recorded (${it.humanActions.length})</div><ul class="log">${it.humanActions.map((a) => `<li>${esc(a.at)} · ${esc(a.type)} · ${esc(a.detail)}</li>`).join("") || "<li class='note'>none</li>"}</ul></div>
</main>
<script>
const id=${JSON.stringify(it.id)};
async function post(op,body){const r=await fetch('/api/interventions/'+id+'/'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok){alert((await r.json()).error)}location.reload()}
async function act(a){const r=await fetch('/api/interventions/'+id+'/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(a)});if(!r.ok){alert((await r.json()).error)}location.reload()}
function typeInto(ref){const t=prompt('Text to type (it is not recorded):');if(t!=null)act({kind:'type',ref,text:t})}
function selectIn(ref){const t=prompt('Option label to select:');if(t!=null)act({kind:'select',ref,value:t})}
${live ? `setInterval(()=>{const i=document.getElementById('shot');if(i)i.src='/api/interventions/'+id+'/screenshot?t='+Date.now()},2000);setTimeout(()=>location.reload(),15000);` : `setTimeout(()=>location.reload(),4000);`}
</script>`;
}

// ---------- helpers ----------

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function html(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}

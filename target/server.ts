/**
 * Meridian CoreSuite: a stand-in for a legacy credit-union core.
 *
 * Deliberately hostile to automation: frameset, table layout, no ids or test
 * ids, cryptic field names, native confirm() dialogs, a session that expires,
 * an interstitial notice, a permission gate that needs a supervisor, and a
 * fault-injection endpoint so runtime conditions can be reproduced on demand.
 *
 * No real data. Every member, balance, and credential here is fictional.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { URL, pathToFileURL } from "node:url";

const PORT = Number(process.env.MERIDIAN_PORT ?? 4100);
const SESSION_TTL_MS = Number(process.env.MERIDIAN_SESSION_TTL_MS ?? 20 * 60_000);
const OPERATOR = { user: "operator", password: "meridian1", role: "Teller" };
const SUPERVISOR_PIN = "2468";

type Share = { id: string; description: string; balance: number };
type Member = {
  id: string;
  name: string;
  since: string;
  status: string;
  restricted?: boolean;
  shares: Share[];
};

const members = new Map<string, Member>([
  ["10042", { id: "10042", name: "Okafor, Margaret A", since: "03/14/2009", status: "Active", shares: [
    { id: "S01", description: "Regular Savings", balance: 4212.18 },
    { id: "S05", description: "Checking", balance: 1088.4 },
    { id: "L10", description: "Auto Loan", balance: -9750.0 },
  ]}],
  ["10077", { id: "10077", name: "Reyes, Daniel", since: "11/02/2015", status: "Active", shares: [
    { id: "S01", description: "Regular Savings", balance: 12930.55 },
    { id: "S05", description: "Checking", balance: 402.11 },
  ]}],
  ["20015", { id: "20015", name: "Natarajan, Priya", since: "06/21/2021", status: "Active", shares: [
    { id: "S01", description: "Regular Savings", balance: 88.2 },
  ]}],
  ["40001", { id: "40001", name: "Whitfield, Thomas J", since: "01/09/2001", status: "Active", restricted: true, shares: [
    { id: "S01", description: "Regular Savings", balance: 2500.0 },
  ]}],
]);

type Session = {
  user: string;
  lastSeen: number;
  noticeAcked: boolean;
  overrides: Set<string>;
  attested: boolean;
};
const sessions = new Map<string, Session>();

/** Runtime conditions a test or a demo can switch on. Not part of the "product". */
type Faults = {
  slowMs: number;          // delay every response by this much
  appErrorOnce: boolean;   // next page request returns an application error
  expireSession: boolean;  // next request finds the session gone
  complianceDialog: boolean; // member pages show an attestation box until attested
};
const faults: Faults = { slowMs: 0, appErrorOnce: false, expireSession: false, complianceDialog: false };

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const style = `
<style>
body { font-family: Verdana, Arial, sans-serif; font-size: 11px; background: #d4d0c8; margin: 8px; color: #000; }
a { color: #003399; } a:visited { color: #003399; }
table.box { background: #ffffff; border: 1px solid #808080; }
td.hd { background: #000080; color: #ffffff; font-weight: bold; padding: 3px 6px; }
td.lbl { background: #ece9d8; padding: 3px 6px; white-space: nowrap; }
td.val { padding: 3px 6px; }
table.grid td, table.grid th { border: 1px solid #a0a0a0; padding: 2px 6px; font-size: 11px; }
table.grid th { background: #ece9d8; text-align: left; font-weight: bold; }
input, select { font-family: Verdana, Arial, sans-serif; font-size: 11px; }
.err { color: #c00000; font-weight: bold; }
.notice { background: #ffffe1; border: 1px solid #808080; }
</style>`;

const page = (title: string, body: string) =>
  `<html><head><title>${esc(title)} - Meridian CoreSuite</title>${style}</head><body>${body}</body></html>`;

function cookie(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return v;
  }
  return undefined;
}

function getSession(req: http.IncomingMessage): Session | undefined {
  const sid = cookie(req, "MCSID");
  if (!sid) return undefined;
  const s = sessions.get(sid);
  if (!s) return undefined;
  if (faults.expireSession || Date.now() - s.lastSeen > SESSION_TTL_MS) {
    faults.expireSession = false;
    sessions.delete(sid);
    return undefined;
  }
  s.lastSeen = Date.now();
  return s;
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

function send(res: http.ServerResponse, status: number, html: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(html);
}
const redirect = (res: http.ServerResponse, to: string) => { res.writeHead(302, { location: to }); res.end(); };

// ---------- pages ----------

const loginPage = (msg?: string) => page("Sign On", `
<br><br>
<table class="box" align="center" cellspacing="0" cellpadding="0" width="360"><tr><td class="hd">Meridian CoreSuite &nbsp;-&nbsp; Sign On</td></tr>
<tr><td style="padding:10px">
${msg ? `<font class="err">${esc(msg)}</font><br><br>` : ""}
<form method="post" action="/login">
<table cellspacing="0" cellpadding="2">
<tr><td class="lbl">Operator ID</td><td class="val"><input type="text" name="uid" size="16"></td></tr>
<tr><td class="lbl">Password</td><td class="val"><input type="password" name="pwd" size="16"></td></tr>
<tr><td class="lbl">Branch</td><td class="val"><select name="br"><option value="01">01 - Main Office</option><option value="02">02 - Westgate</option></select></td></tr>
<tr><td></td><td class="val"><input type="submit" value="Sign On"></td></tr>
</table>
</form>
</td></tr></table>
<p align="center"><font size="1">Meridian CoreSuite v7.2.14 &nbsp;&nbsp; Unauthorized access is prohibited.</font></p>`);

const frameset = () => `<html><head><title>Meridian CoreSuite</title></head>
<frameset rows="52,*" frameborder="1" border="2">
  <frame name="banner" src="/banner" scrolling="no" noresize>
  <frameset cols="170,*">
    <frame name="nav" src="/nav" scrolling="auto">
    <frame name="main" src="/home">
  </frameset>
</frameset></html>`;

const bannerFrame = (s: Session) => page("Banner", `
<table width="100%" cellspacing="0" cellpadding="0"><tr>
<td><font size="4" color="#000080"><b>Meridian CoreSuite</b></font> <font size="1">v7.2.14</font></td>
<td align="right"><font size="1">Operator: <b>${esc(s.user)}</b> (${OPERATOR.role}) &nbsp; Branch 01 &nbsp; ${new Date().toLocaleDateString("en-US")}</font></td>
</tr></table>`);

const navFrame = () => page("Navigation", `
<table class="box" width="100%" cellspacing="0" cellpadding="3">
<tr><td class="hd">Menu</td></tr>
<tr><td><a href="/home" target="main">Home</a></td></tr>
<tr><td><a href="/inquiry" target="main">Member Inquiry</a></td></tr>
<tr><td><a href="/transactions" target="main">Transaction Posting</a></td></tr>
<tr><td><a href="/reports" target="main">Reports</a></td></tr>
<tr><td><a href="/logout" target="_top">Sign Off</a></td></tr>
</table>`);

const homePage = (s: Session) => page("Home", `
<table class="box" width="100%" cellspacing="0" cellpadding="0"><tr><td class="hd">Welcome</td></tr>
<tr><td style="padding:8px">Good day, <b>${esc(s.user)}</b>. Select a function from the menu at left.<br><br>
<font size="1">Last sign on: ${new Date(Date.now() - 86_400_000).toLocaleString("en-US")}</font></td></tr></table>`);

const noticePage = (returnTo: string) => page("System Notice", `
<br>
<table class="box notice" align="center" width="440" cellspacing="0" cellpadding="0" role="dialog" aria-label="System Notice">
<tr><td class="hd">System Notice</td></tr>
<tr><td style="padding:10px">
Scheduled maintenance will occur Sunday 02:00 to 04:00 ET. Posting functions will be unavailable during this window.
<br><br>
<form method="post" action="/notice/ack">
<input type="hidden" name="ret" value="${esc(returnTo)}">
<div align="center"><input type="submit" value="Continue"></div>
</form>
</td></tr></table>`);

const inquiryPage = (err?: string) => page("Member Inquiry", `
<table class="box" width="100%" cellspacing="0" cellpadding="0"><tr><td class="hd">Member Inquiry</td></tr>
<tr><td style="padding:8px">
${err ? `<font class="err">${esc(err)}</font><br><br>` : ""}
Enter a member number or a last name, then press Search.
<form method="post" action="/inquiry/search">
<table cellspacing="0" cellpadding="2">
<tr><td class="lbl">Member Number</td><td class="val"><input type="text" name="mbrno" size="12" maxlength="8"></td></tr>
<tr><td class="lbl">Last Name</td><td class="val"><input type="text" name="lname" size="24"></td></tr>
<tr><td></td><td class="val"><input type="submit" value="Search"> &nbsp; <input type="reset" value="Clear"></td></tr>
</table>
</form>
</td></tr></table>`);

const notFoundPage = (q: string) => page("Member Inquiry", `
<table class="box" width="100%" cellspacing="0" cellpadding="0"><tr><td class="hd">Member Inquiry</td></tr>
<tr><td style="padding:8px">
<font class="err">No member found for "${esc(q)}".</font><br><br>
Verify the member number and try again.<br><br>
<a href="/inquiry">Return to Member Inquiry</a>
</td></tr></table>`);

const compliancePage = (m: Member) => page("Compliance Attestation", `
<br>
<table class="box notice" align="center" width="460" cellspacing="0" cellpadding="0" role="dialog" aria-label="Compliance Attestation">
<tr><td class="hd">Compliance Attestation Required</td></tr>
<tr><td style="padding:10px">
Access to member <b>${esc(m.id)}</b> requires a compliance attestation for this session under policy BSA-114.
Enter your initials to confirm you have a business need to view this record.
<br><br>
<form method="post" action="/compliance/attest">
<input type="hidden" name="ret" value="/member/${esc(m.id)}">
<table cellspacing="0" cellpadding="2">
<tr><td class="lbl">Operator initials</td><td class="val"><input type="text" name="ini" size="4" maxlength="3"></td></tr>
<tr><td></td><td class="val"><input type="submit" value="Attest"></td></tr>
</table>
</form>
</td></tr></table>`);

const memberPage = (m: Member, note?: string) => page(`Member ${m.id}`, `
<table class="box" width="100%" cellspacing="0" cellpadding="0"><tr><td class="hd">Member Detail</td></tr>
<tr><td style="padding:8px">
${note ? `<font color="#006600"><b>${esc(note)}</b></font><br><br>` : ""}
<table cellspacing="0" cellpadding="2">
<tr><td class="lbl">Member Number</td><td class="val">${esc(m.id)}</td><td class="lbl">Status</td><td class="val">${esc(m.status)}</td></tr>
<tr><td class="lbl">Name</td><td class="val">${esc(m.name)}</td><td class="lbl">Member Since</td><td class="val">${esc(m.since)}</td></tr>
</table>
<br>
<b>Share Accounts</b>
<table class="grid" cellspacing="0" cellpadding="0">
<tr><th>Share ID</th><th>Description</th><th>Current Balance</th><th>Available</th></tr>
${m.shares.map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.description)}</td><td align="right">${money(s.balance)}</td><td align="right">${money(Math.max(0, s.balance))}</td></tr>`).join("\n")}
</table>
<br>
<a href="/member/${esc(m.id)}/shares/new">Open Sub-Account</a> &nbsp;|&nbsp;
<a href="/member/${esc(m.id)}/history">Transaction History</a> &nbsp;|&nbsp;
<a href="/inquiry">New Inquiry</a>
</td></tr></table>`);

const overridePage = (m: Member, err?: string) => page("Permission Denied", `
<table class="box" width="100%" cellspacing="0" cellpadding="0"><tr><td class="hd">Permission Denied</td></tr>
<tr><td style="padding:8px">
<font class="err">Your role (${OPERATOR.role}) cannot open sub-accounts for member ${esc(m.id)}. A supervisor override is required.</font><br><br>
${err ? `<font class="err">${esc(err)}</font><br><br>` : ""}
<form method="post" action="/member/${esc(m.id)}/override">
<table cellspacing="0" cellpadding="2">
<tr><td class="lbl">Supervisor PIN</td><td class="val"><input type="password" name="spin" size="6"></td></tr>
<tr><td></td><td class="val"><input type="submit" value="Apply Override"></td></tr>
</table>
</form>
<br><a href="/member/${esc(m.id)}">Back to Member Detail</a>
</td></tr></table>`);

const newSharePage = (m: Member, errors: string[] = [], vals: Record<string, string> = {}) => page("Open Sub-Account", `
<table class="box" width="100%" cellspacing="0" cellpadding="0"><tr><td class="hd">Open Sub-Account &nbsp;-&nbsp; Member ${esc(m.id)} ${esc(m.name)}</td></tr>
<tr><td style="padding:8px">
${errors.length ? `<font class="err">${errors.map(esc).join("<br>")}</font><br><br>` : ""}
<form method="post" action="/member/${esc(m.id)}/shares/new" onsubmit="return confirm('Open a new sub-account for member ${esc(m.id)}? This will create a live share record and cannot be undone.')">
<table cellspacing="0" cellpadding="2">
<tr><td class="lbl">Share Type</td><td class="val"><select name="shtyp">
<option value="">-- select --</option>
<option value="S20" ${vals.shtyp === "S20" ? "selected" : ""}>S20 Holiday Club</option>
<option value="S30" ${vals.shtyp === "S30" ? "selected" : ""}>S30 Money Market</option>
<option value="S40" ${vals.shtyp === "S40" ? "selected" : ""}>S40 Secondary Savings</option>
</select></td></tr>
<tr><td class="lbl">Nickname</td><td class="val"><input type="text" name="nick" size="20" maxlength="20" value="${esc(vals.nick ?? "")}"></td></tr>
<tr><td class="lbl">Initial Deposit</td><td class="val"><input type="text" name="dep" size="10" value="${esc(vals.dep ?? "")}"> <font size="1">(minimum $5.00)</font></td></tr>
<tr><td></td><td class="val"><input type="submit" value="Open Account"></td></tr>
</table>
</form>
<br><a href="/member/${esc(m.id)}">Cancel</a>
</td></tr></table>`);

const confirmPage = (m: Member, shareId: string, type: string, nick: string, dep: number, ref: string) => page("Confirmation", `
<table class="box" width="100%" cellspacing="0" cellpadding="0"><tr><td class="hd">Sub-Account Opened</td></tr>
<tr><td style="padding:8px">
<font color="#006600"><b>Sub-account ${esc(shareId)} has been opened for member ${esc(m.id)}.</b></font><br><br>
<table cellspacing="0" cellpadding="2">
<tr><td class="lbl">Confirmation Number</td><td class="val">${esc(ref)}</td></tr>
<tr><td class="lbl">Share ID</td><td class="val">${esc(shareId)}</td></tr>
<tr><td class="lbl">Share Type</td><td class="val">${esc(type)}</td></tr>
<tr><td class="lbl">Nickname</td><td class="val">${esc(nick || "(none)")}</td></tr>
<tr><td class="lbl">Initial Deposit</td><td class="val">${money(dep)}</td></tr>
</table>
<br><a href="/member/${esc(m.id)}">Return to Member Detail</a>
</td></tr></table>`);

const deniedPage = (what: string) => page("Permission Denied", `
<table class="box" width="100%" cellspacing="0" cellpadding="0"><tr><td class="hd">Permission Denied</td></tr>
<tr><td style="padding:8px"><font class="err">Your role (${OPERATOR.role}) is not authorized to access ${esc(what)}.</font><br><br>
<a href="/home">Return Home</a></td></tr></table>`);

const appErrorPage = () => page("Application Error", `
<table class="box" width="100%" cellspacing="0" cellpadding="0"><tr><td class="hd">Application Error</td></tr>
<tr><td style="padding:8px"><font class="err">An unexpected error occurred while processing your request (MCS-5001).</font><br><br>
The transaction was not completed. Please try again. If the problem persists, contact the help desk.</td></tr></table>`);

// ---------- routing ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // Fault injection: an out-of-band control surface for tests and demos.
  if (path === "/__faults") {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      Object.assign(faults, JSON.parse(Buffer.concat(chunks).toString() || "{}"));
    } else if (req.method === "DELETE") {
      Object.assign(faults, { slowMs: 0, appErrorOnce: false, expireSession: false, complianceDialog: false });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(faults));
    return;
  }

  if (faults.slowMs > 0) await new Promise((r) => setTimeout(r, faults.slowMs));

  if (path === "/login") {
    if (req.method === "POST") {
      const f = await readForm(req);
      if (f.get("uid") === OPERATOR.user && f.get("pwd") === OPERATOR.password) {
        const sid = randomBytes(12).toString("hex");
        sessions.set(sid, { user: OPERATOR.user, lastSeen: Date.now(), noticeAcked: false, overrides: new Set(), attested: false });
        res.writeHead(302, { location: "/", "set-cookie": `MCSID=${sid}; Path=/; HttpOnly` });
        res.end();
        return;
      }
      return send(res, 200, loginPage("Invalid operator ID or password."));
    }
    return send(res, 200, loginPage(url.searchParams.get("msg") ?? undefined));
  }

  const session = getSession(req);
  if (!session) {
    return redirect(res, "/login?msg=" + encodeURIComponent("Your session has expired. Please sign on again."));
  }

  if (faults.appErrorOnce && req.method === "GET") {
    faults.appErrorOnce = false;
    return send(res, 500, appErrorPage());
  }

  if (path === "/") return send(res, 200, frameset());
  if (path === "/banner") return send(res, 200, bannerFrame(session));
  if (path === "/nav") return send(res, 200, navFrame());
  if (path === "/home") return send(res, 200, homePage(session));
  if (path === "/logout") {
    sessions.delete(cookie(req, "MCSID") ?? "");
    return redirect(res, "/login?msg=" + encodeURIComponent("You have been signed off."));
  }
  if (path === "/reports" || path === "/transactions") return send(res, 200, deniedPage(path === "/reports" ? "Reports" : "Transaction Posting"));

  if (path === "/notice/ack" && req.method === "POST") {
    const f = await readForm(req);
    session.noticeAcked = true;
    return redirect(res, f.get("ret") || "/home");
  }
  if (path === "/compliance/attest" && req.method === "POST") {
    const f = await readForm(req);
    if ((f.get("ini") ?? "").trim().length >= 2) session.attested = true;
    return redirect(res, f.get("ret") || "/home");
  }

  if (path === "/inquiry") {
    if (!session.noticeAcked) return send(res, 200, noticePage("/inquiry"));
    return send(res, 200, inquiryPage());
  }
  if (path === "/inquiry/search" && req.method === "POST") {
    const f = await readForm(req);
    const mbrno = (f.get("mbrno") ?? "").trim();
    const lname = (f.get("lname") ?? "").trim().toLowerCase();
    if (!mbrno && !lname) return send(res, 200, inquiryPage("Enter a member number or a last name."));
    if (mbrno) {
      if (!/^\d+$/.test(mbrno)) return send(res, 200, inquiryPage("Member number must be numeric."));
      return members.has(mbrno) ? redirect(res, `/member/${mbrno}`) : send(res, 200, notFoundPage(mbrno));
    }
    const hit = [...members.values()].find((m) => m.name.toLowerCase().startsWith(lname));
    return hit ? redirect(res, `/member/${hit.id}`) : send(res, 200, notFoundPage(lname));
  }

  const mm = path.match(/^\/member\/(\d+)(\/.*)?$/);
  if (mm) {
    const m = members.get(mm[1]!);
    if (!m) return send(res, 200, notFoundPage(mm[1]!));
    const sub = mm[2] ?? "";

    if (faults.complianceDialog && !session.attested) return send(res, 200, compliancePage(m));

    if (sub === "") return send(res, 200, memberPage(m, url.searchParams.get("note") ?? undefined));
    if (sub === "/history") return send(res, 200, deniedPage("Transaction History"));

    if (sub === "/override" && req.method === "POST") {
      const f = await readForm(req);
      if (f.get("spin") === SUPERVISOR_PIN) { session.overrides.add(m.id); return redirect(res, `/member/${m.id}/shares/new`); }
      return send(res, 200, overridePage(m, "Invalid supervisor PIN."));
    }

    if (sub === "/shares/new") {
      if (m.restricted && !session.overrides.has(m.id)) return send(res, 200, overridePage(m));
      if (req.method === "GET") return send(res, 200, newSharePage(m));
      const f = await readForm(req);
      const vals = { shtyp: f.get("shtyp") ?? "", nick: f.get("nick") ?? "", dep: f.get("dep") ?? "" };
      const errors: string[] = [];
      if (!vals.shtyp) errors.push("Share Type is required.");
      const dep = Number(vals.dep.replace(/[$,]/g, ""));
      if (!vals.dep || Number.isNaN(dep)) errors.push("Initial Deposit must be a dollar amount.");
      else if (dep < 5) errors.push("Initial Deposit must be at least $5.00.");
      if (vals.nick.length > 20) errors.push("Nickname must be 20 characters or fewer.");
      if (errors.length) return send(res, 200, newSharePage(m, errors, vals));
      const typeLabel = { S20: "Holiday Club", S30: "Money Market", S40: "Secondary Savings" }[vals.shtyp] ?? vals.shtyp;
      const shareId = vals.shtyp.slice(0, 2) + String(m.shares.filter((s) => s.id.startsWith(vals.shtyp.slice(0, 2))).length + 1);
      m.shares.push({ id: shareId, description: `${typeLabel}${vals.nick ? " - " + vals.nick : ""}`, balance: dep });
      const ref = "C" + Date.now().toString(36).toUpperCase();
      return send(res, 200, confirmPage(m, shareId, `${vals.shtyp} ${typeLabel}`, vals.nick, dep, ref));
    }
  }

  send(res, 404, page("Not Found", `<font class="err">The requested function was not found.</font><br><br><a href="/home">Return Home</a>`));
});

export function startMeridian(port = PORT): Promise<http.Server> {
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMeridian().then(() => console.log(`Meridian CoreSuite listening on http://localhost:${PORT}  (operator / meridian1, supervisor PIN ${SUPERVISOR_PIN})`));
}

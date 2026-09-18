/**
 * In-page walker. Serialized into every frame with frame.evaluate, so it must
 * be self-contained: no imports, no closures over Node scope.
 *
 * It produces a compact, accessibility-style list of the controls and text a
 * human operator would see, with a stable ref per node, and keeps the ref to
 * element mapping in window.__hands so actions can be dispatched by ref.
 *
 * It deliberately does not rely on ids, test ids, or <label for>. Names are
 * computed the way an operator reads a legacy screen: the cell to the left,
 * the text above, the button's own caption.
 */

export type RawNode = {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  attrs: Record<string, string>;
  text: string;
  value?: string;
  anchor?: string;
  cell?: { column: string; rowText: string[] };
  options?: string[];
  disabled?: boolean;
  dialog?: string;
  depth: number;
  css: string;
  bbox: { x: number; y: number; w: number; h: number };
};

declare global {
  interface Window { __hands?: { refs: Record<string, Element> } }
}

export function walkDocument(startIndex: number): RawNode[] {
  const out: RawNode[] = [];
  const refs: Record<string, Element> = {};
  let counter = startIndex;

  const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

  const visible = (el: Element): boolean => {
    const anyEl = el as any;
    if (typeof anyEl.checkVisibility === "function") {
      if (!anyEl.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    }
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if ((el as HTMLElement).tagName === "INPUT" && (el as HTMLInputElement).type === "hidden") return false;
    return true;
  };

  const INLINE = /^(FONT|B|I|U|STRONG|EM|SPAN|SMALL|BIG|NOBR|BR|SUP|SUB)$/;
  // Anything worth descending into. An element with none of these inside is an inline-only leaf and is read whole.
  const CONTROLS = "a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6,table,tr,td,th,ul,ol,li,p,div,form,fieldset,img[alt],[role]";
  /** Direct text nodes, plus inline formatting wrappers when asked: that is how an operator reads a legacy cell. */
  const ownText = (el: Element, withInline: boolean): string => {
    let s = "";
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) s += n.textContent ?? "";
      else if (withInline && n.nodeType === Node.ELEMENT_NODE && INLINE.test((n as Element).tagName)) s += " " + fullText(n as Element) + " ";
    }
    const t = norm(s);
    return /^[\s|:;,.\-–—]*$/.test(t) ? "" : t;
  };
  const fullText = (el: Element): string => norm((el as HTMLElement).innerText ?? el.textContent ?? "");

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && cur.parentElement) {
      const tag = cur.tagName.toLowerCase();
      const sibs = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(cur) + 1})` : tag);
      cur = cur.parentElement;
    }
    return "body > " + parts.join(" > ");
  };

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (tag === "BUTTON") return "button";
    if (tag === "INPUT") {
      const t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "hidden") return null;
      return "textbox";
    }
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "TH") return "columnheader";
    if (tag === "TD") return "cell";
    if (tag === "TR") return "row";
    if (tag === "TABLE") return "table";
    if (tag === "IMG") return (el as HTMLImageElement).alt ? "img" : null;
    return null;
  };

  const isField = (role: string) => ["textbox", "combobox", "checkbox", "radio"].includes(role);

  /**
   * Label-ish text for a control: the cell to its left, else (for fields only) the cell
   * above in the same column, else the nearest preceding text. A plain cell never anchors
   * upward: that would make the next row's label share its anchor.
   */
  const anchorFor = (el: Element, allowAbove: boolean): string | undefined => {
    const td = el.closest("td");
    if (td) {
      let prev = td.previousElementSibling;
      while (prev) {
        const t = fullText(prev);
        if (t) return t;
        prev = prev.previousElementSibling;
      }
      if (!allowAbove) return undefined;
      const tr = td.parentElement;
      const idx = tr ? Array.from(tr.children).indexOf(td) : -1;
      const above = tr?.previousElementSibling?.children[idx];
      if (above && fullText(above)) return fullText(above);
    }
    let prev: Node | null = el.previousSibling;
    while (prev) {
      if (prev.nodeType === Node.TEXT_NODE && norm(prev.textContent)) return norm(prev.textContent);
      if (prev.nodeType === Node.ELEMENT_NODE && fullText(prev as Element)) return fullText(prev as Element);
      prev = prev.previousSibling;
    }
    return undefined;
  };

  const nameFor = (el: Element, role: string): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return norm(aria);
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const t = labelled.split(/\s+/).map((id) => fullText(document.getElementById(id) ?? document.createElement("i"))).join(" ");
      if (norm(t)) return norm(t);
    }
    if (isField(role)) {
      const id = el.getAttribute("id");
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab && fullText(lab)) return fullText(lab);
      }
      const wrap = el.closest("label");
      if (wrap && fullText(wrap)) return fullText(wrap);
      const ph = el.getAttribute("placeholder") || el.getAttribute("title");
      if (ph) return norm(ph);
      return anchorFor(el, true) ?? norm(el.getAttribute("name"));
    }
    if (role === "button") {
      const v = (el as HTMLInputElement).value;
      if (el.tagName === "INPUT" && v) return norm(v);
      return fullText(el) || norm(el.getAttribute("title")) || norm((el.querySelector("img") as HTMLImageElement | null)?.alt);
    }
    if (role === "link") return fullText(el) || norm((el.querySelector("img") as HTMLImageElement | null)?.alt) || norm(el.getAttribute("title"));
    if (role === "img") return norm((el as HTMLImageElement).alt);
    if (role === "dialog") {
      const h = el.querySelector("h1,h2,h3,h4,td.hd,th,b");
      return norm(h ? fullText(h) : "");
    }
    return ownText(el, !el.querySelector(CONTROLS)) || (role === "row" || role === "table" ? "" : fullText(el));
  };

  const emit = (el: Element, role: string, depth: number, extra: Partial<RawNode> = {}): RawNode => {
    const ref = "e" + ++counter;
    refs[ref] = el;
    const r = el.getBoundingClientRect();
    const attrs: Record<string, string> = {};
    for (const a of ["name", "href", "title", "placeholder", "value"]) {
      const v = el.getAttribute(a);
      if (v != null && v !== "" && !(a === "value" && role === "textbox")) attrs[a] = v.slice(0, 200);
    }
    const node: RawNode = {
      ref, role, name: nameFor(el, role), tag: el.tagName.toLowerCase(), attrs,
      text: ownText(el, !el.querySelector(CONTROLS)), depth, css: cssPath(el),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      ...extra,
    };
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const input = el as HTMLInputElement;
      const t = (input.type || "text").toLowerCase();
      node.type = t;
      if (role === "textbox") node.value = t === "password" ? (input.value ? "[redacted]" : "") : input.value;
      if (role === "checkbox" || role === "radio") node.value = input.checked ? "checked" : "unchecked";
    }
    if (el.tagName === "SELECT") {
      const sel = el as HTMLSelectElement;
      node.options = Array.from(sel.options).map((o) => norm(o.text)).filter(Boolean).slice(0, 40);
      node.value = norm(sel.selectedOptions[0]?.text);
    }
    if ((el as HTMLButtonElement).disabled) node.disabled = true;
    // Fields and layout-table cells are read by the label next to them. That label is the
    // most stable handle a legacy screen offers.
    if (isField(role)) node.anchor = anchorFor(el, true);
    else if (role === "cell" && !extra.cell) node.anchor = anchorFor(el, false);
    const dlg = el.closest('[role="dialog"], dialog');
    if (dlg && dlg !== el) node.dialog = nameFor(dlg, "dialog");
    out.push(node);
    return node;
  };

  const headerRowOf = (table: Element): string[] | null => {
    const ths = Array.from(table.querySelectorAll(":scope > thead th, :scope > tbody > tr:first-child > th, :scope > tr:first-child > th"));
    return ths.length ? ths.map(fullText) : null;
  };

  const walk = (el: Element, depth: number, ctx: { headers: string[] | null; rowText: string[] | null }) => {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT" || el.tagName === "OPTION") return;
    if (!visible(el)) return;
    const role = roleOf(el);
    let nextDepth = depth;
    let nextCtx = ctx;

    if (role === "table") {
      nextCtx = { headers: headerRowOf(el), rowText: null };
    } else if (role === "row") {
      const cells = Array.from(el.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
      nextCtx = { ...ctx, rowText: cells.map(fullText) };
      if (ctx.headers) { emit(el, "row", depth); nextDepth = depth + 1; }
    } else if (role === "cell" || role === "columnheader") {
      const tr = el.parentElement;
      const idx = tr ? Array.from(tr.children).indexOf(el) : -1;
      const hasControls = !!el.querySelector(CONTROLS);
      if (ctx.headers && role === "cell") {
        emit(el, "cell", depth, { cell: { column: ctx.headers[idx] ?? "", rowText: ctx.rowText ?? [] } });
        return; // grid cells are leaves
      }
      if (role === "columnheader") { emit(el, "columnheader", depth); return; }
      // Layout-table cell. A leaf cell is read whole; a container cell contributes only its
      // direct text and lets its children speak for themselves.
      if (!hasControls) { if (ownText(el, true)) emit(el, "cell", depth); return; }
      if (ownText(el, false)) { emit(el, "text", depth); nextDepth = depth + 1; }
    } else if (role) {
      const isContainer = role === "dialog" || role === "region" || role === "form" || role === "navigation" || role === "main";
      emit(el, role, depth);
      if (!isContainer) return; // controls and headings are leaves
      nextDepth = depth + 1;
    } else {
      if (/^(HTML|BODY|FRAMESET)$/.test(el.tagName)) { /* structural */ }
      else if (!el.querySelector(CONTROLS)) { if (ownText(el, true)) emit(el, "text", depth); return; }
      else if (ownText(el, false)) { emit(el, "text", depth); nextDepth = depth + 1; }
    }
    for (const child of Array.from(el.children)) walk(child, nextDepth, nextCtx);
  };

  if (document.body) walk(document.body, 0, { headers: null, rowText: null });
  window.__hands = { refs };
  return out;
}

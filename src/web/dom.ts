/// <reference lib="dom" />
// import_web, browser side: `snapshot` runs inside the rendered page (page.evaluate) and returns
// the visible element tree with boxes and the computed styles the converter needs.
// It must stay self-contained: Playwright serializes the function, so it can't use imports or
// anything defined outside it.

export interface RawBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawTextStyle {
  family: string;
  weight: number;
  italic: boolean;
  size: number;
  lineHeight: string;
  letterSpacing: string;
  color: string;
  decoration: string;
  transform: string;
}

export interface RawRun {
  text: string;
  style: RawTextStyle;
  href?: string;
}

export interface RawNode {
  /** box: element → frame; text: a run of inline content; image: <img>; svg: inline <svg>; raster: rendered as a picture. */
  kind: "box" | "text" | "image" | "svg" | "raster";
  tag: string;
  name: string;
  box: RawBox;
  /** Computed styles, colors normalized to #RRGGBB[AA]. */
  css: Record<string, string>;
  children: RawNode[];
  runs?: RawRun[];
  lines?: number;
  /** Text only: width comes from the text itself (flex item, nowrap), not from its container. */
  autoWidth?: boolean;
  src?: string;
  svg?: string;
}

export interface Snapshot {
  title: string;
  url: string;
  width: number;
  height: number;
  root: RawNode;
  nodes: number;
  truncated: boolean;
  warnings: string[];
}

export interface SnapshotOptions {
  selector?: string;
  maxNodes: number;
  maxHeight: number;
}

export function snapshot(opts: SnapshotOptions): Snapshot {
  const warnings: string[] = [];
  let count = 0;
  let truncated = false;

  // ─── Colors: any CSS color (oklch, lab, color(), hsl…) → #RRGGBB[AA] ──────────
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const colorCache: Record<string, string> = {};
  const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0").toUpperCase();
  function parseRgb(s: string): number[] | null {
    let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
    if (m) return [parseInt(m[1]!.slice(0, 2), 16), parseInt(m[1]!.slice(2, 4), 16), parseInt(m[1]!.slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!), a];
  }
  function color(c: string): string {
    if (colorCache[c] !== undefined) return colorCache[c]!;
    let rgba = parseRgb(c.trim());
    if (!rgba) {
      ctx.fillStyle = "#000000";
      ctx.fillStyle = c;
      rgba = parseRgb(String(ctx.fillStyle));
      if (!rgba) {
        // Wide-gamut colors: the opaque sRGB version through relative color syntax, alpha from a pixel.
        ctx.fillStyle = "#000000";
        ctx.fillStyle = "rgb(from " + c + " r g b)";
        const opaque = parseRgb(String(ctx.fillStyle));
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const px = ctx.getImageData(0, 0, 1, 1).data;
        rgba = opaque ? [opaque[0]!, opaque[1]!, opaque[2]!, px[3]! / 255] : [px[0]!, px[1]!, px[2]!, px[3]! / 255];
      }
    }
    const out = "#" + hex2(rgba[0]!) + hex2(rgba[1]!) + hex2(rgba[2]!) + (rgba[3]! < 0.999 ? hex2(rgba[3]! * 255) : "");
    colorCache[c] = out;
    return out;
  }
  const COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi;
  const colors = (v: string) => v.replace(COLOR_FN, (m) => color(m));

  // ─── Pseudo-elements become real elements so they can be measured ──────────
  const style = document.createElement("style");
  style.textContent = "[data-fb-before]::before,[data-fb-after]::after{content:none!important}";
  document.head.appendChild(style);
  const all = Array.prototype.slice.call(document.body.querySelectorAll("*")) as Element[];
  for (const el of all) {
    for (const which of ["before", "after"]) {
      const cs = getComputedStyle(el, "::" + which);
      const content = cs.content;
      if (!content || content === "none" || content === "normal" || cs.display === "none") continue;
      const fake = document.createElement("fb-pseudo");
      for (let i = 0; i < cs.length; i++) {
        const prop = cs[i]!;
        fake.style.setProperty(prop, cs.getPropertyValue(prop));
      }
      const str = /^"((?:[^"\\]|\\.)*)"$/.exec(content);
      if (str) fake.textContent = str[1]!.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1");
      const url = /^url\("?(.*?)"?\)$/.exec(content);
      if (url) {
        const img = document.createElement("img");
        img.src = url[1]!;
        img.style.cssText = "display:block;width:100%;height:100%";
        fake.appendChild(img);
      }
      if (which === "before") el.insertBefore(fake, el.firstChild);
      else el.appendChild(fake);
      el.setAttribute("data-fb-" + which, "");
    }
  }

  // ─── Names ──────────────────────────────────────────────────────────────────
  const UTILITY =
    /^-?(?:[a-z]+:)*(?:m[xytblr]?|p[xytblr]?|w|h|min|max|size|text|bg|border|rounded|flex|grid|gap|space|items|justify|self|place|content|font|leading|tracking|shadow|opacity|z|top|left|right|bottom|inset|col|row|order|overflow|absolute|relative|fixed|sticky|static|block|inline|hidden|visible|invisible|container|sr|transition|duration|ease|delay|animate|transform|translate|scale|rotate|skew|origin|cursor|select|pointer|ring|outline|fill|stroke|object|aspect|line|truncate|uppercase|lowercase|capitalize|normal|italic|underline|no|antialiased|subpixel|whitespace|break|list|divide|backdrop|blur|drop|group|peer|decoration|underline|align|basis|grow|shrink|from|via|to|dark|sm|md|lg|xl|2xl|hover|focus|active|disabled|first|last|odd|even|isolate|mix|will|appearance|resize|snap|scroll|touch|columns|float|clear|box|table|caption|indent|tab|js|is|has)(?:-|$)/i;
  function humanize(s: string): string {
    const words = s
      .replace(/__/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[-_.]+/g, " ")
      .trim();
    return words ? (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 40) : "";
  }
  function meaningfulClass(el: Element): string {
    const list = Array.prototype.slice.call(el.classList) as string[];
    for (const c of list) {
      if (/[:[\]/!@]/.test(c) || UTILITY.test(c)) continue;
      if (/^(?:sc-|css-|jsx-|svelte-|astro-|ng-|v-|_)/i.test(c)) continue;
      if (/\d/.test(c) && /^[a-z0-9]{5,10}$/i.test(c)) continue; // generated hashes
      const moduleName = /^([A-Za-z][\w-]*?)(?:_|-)[A-Za-z0-9]{5,}$/.exec(c); // CSS modules: Card_root__x1y2z
      return humanize(moduleName && /[A-Z_]/.test(c) ? c.replace(/_{1,2}[A-Za-z0-9]{5,}$/, "") : c);
    }
    return "";
  }
  function nameOf(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim().slice(0, 40);
    if (el.tagName === "IMG") return ((el as HTMLImageElement).alt || "").trim().slice(0, 40);
    if (el.id && !/\d{3,}|^[:_]/.test(el.id)) return humanize(el.id);
    return meaningfulClass(el);
  }

  // ─── Measurement ────────────────────────────────────────────────────────────
  const sx = window.scrollX;
  const sy = window.scrollY;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const toBox = (r: DOMRect | { left: number; top: number; width: number; height: number }): RawBox => ({
    x: r1(r.left + sx),
    y: r1(r.top + sy),
    w: r1(r.width),
    h: r1(r.height),
  });
  const px = (v: string) => parseFloat(v) || 0;

  const BOX_PROPS = [
    "display",
    "position",
    "flexDirection",
    "flexWrap",
    "justifyContent",
    "alignItems",
    "alignSelf",
    "flexGrow",
    "rowGap",
    "columnGap",
    "gridTemplateColumns",
    "gridTemplateRows",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderTopStyle",
    "borderRightStyle",
    "borderBottomStyle",
    "borderLeftStyle",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderBottomRightRadius",
    "borderBottomLeftRadius",
    "backgroundColor",
    "backgroundImage",
    "backgroundSize",
    "backgroundRepeat",
    "boxShadow",
    "opacity",
    "overflowX",
    "overflowY",
    "filter",
    "backdropFilter",
    "zIndex",
    "objectFit",
    "textAlign",
    "whiteSpace",
    "transform",
    "mixBlendMode",
  ];
  const COLOR_PROPS = ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "backgroundColor", "backgroundImage", "boxShadow"];

  function cssOf(cs: CSSStyleDeclaration): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of BOX_PROPS) {
      let v = (cs as any)[p] as string;
      if (v === undefined || v === "") continue;
      if (COLOR_PROPS.indexOf(p) !== -1) v = colors(v);
      out[p] = v;
    }
    return out;
  }

  function textStyle(cs: CSSStyleDeclaration): RawTextStyle {
    return {
      family: cs.fontFamily,
      weight: Number(cs.fontWeight) || 400,
      italic: cs.fontStyle === "italic" || cs.fontStyle.indexOf("oblique") === 0,
      size: px(cs.fontSize),
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      color: color(cs.color),
      decoration: cs.textDecorationLine,
      transform: cs.textTransform,
    };
  }

  function hidden(el: Element, cs: CSSStyleDeclaration): boolean {
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return true;
    if (Number(cs.opacity) === 0) return true;
    return false;
  }

  const SKIP = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BASE"];
  const RASTER = ["CANVAS", "VIDEO", "IFRAME", "OBJECT", "EMBED", "AUDIO", "MATH"];

  /** Inline-level element that only carries text styling: its text joins the parent's runs. */
  function isPlainInline(el: Element, cs: CSSStyleDeclaration): boolean {
    if (cs.display !== "inline" || el.tagName === "IMG" || el.tagName === "svg" || el.tagName === "INPUT" || el.tagName === "BUTTON" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return false;
    if (RASTER.indexOf(el.tagName) !== -1) return false;
    if (cs.position === "absolute" || cs.position === "fixed") return false;
    const bg = color(cs.backgroundColor);
    const hasBg = !(bg.length === 9 && bg.endsWith("00")) || cs.backgroundImage !== "none";
    const hasBorder = px(cs.borderTopWidth) + px(cs.borderBottomWidth) + px(cs.borderLeftWidth) + px(cs.borderRightWidth) > 0;
    const hasPadding = px(cs.paddingLeft) + px(cs.paddingRight) > 0;
    if (hasBg || hasBorder || hasPadding || cs.boxShadow !== "none") return false;
    return !el.querySelector("img,svg,canvas,video,iframe,input,button,select,textarea,[style*=block]");
  }

  // ─── Inline content → text runs ─────────────────────────────────────────────
  function collapse(cs: CSSStyleDeclaration, s: string): string {
    return /^pre/.test(cs.whiteSpace) || cs.whiteSpace === "break-spaces" ? s : s.replace(/[\t\n\r\f ]+/g, " ");
  }

  function runsOf(nodes: Node[], out: RawRun[]) {
    for (const n of nodes) {
      if (n.nodeType === 3) {
        const parent = n.parentElement!;
        const cs = getComputedStyle(parent);
        const text = collapse(cs, n.nodeValue || "");
        if (!text) continue;
        const a = parent.closest("a");
        const run: RawRun = { text, style: textStyle(cs) };
        if (a && a.getAttribute("href")) run.href = (a as HTMLAnchorElement).href;
        out.push(run);
      } else if (n.nodeType === 1) {
        const el = n as Element;
        if (el.tagName === "BR") {
          out.push({ text: "\n", style: textStyle(getComputedStyle(el.parentElement!)) });
          continue;
        }
        const cs = getComputedStyle(el);
        if (hidden(el, cs)) continue;
        runsOf(Array.prototype.slice.call(el.childNodes), out);
      }
    }
  }

  /** Joins runs like the browser collapses white space between them. */
  function tidy(runs: RawRun[]): RawRun[] {
    const out: RawRun[] = [];
    let atLineStart = true;
    for (const r of runs) {
      let t = r.text;
      if (t === "\n") {
        if (out.length) out[out.length - 1]!.text = out[out.length - 1]!.text.replace(/ $/, "");
        atLineStart = true;
        out.push(r);
        continue;
      }
      if (atLineStart || (out.length && / $/.test(out[out.length - 1]!.text))) t = t.replace(/^ /, "");
      if (!t) continue;
      out.push({ text: t, style: r.style, href: r.href });
      atLineStart = false;
    }
    while (out.length && !out[out.length - 1]!.text.replace(/ +$/, "")) out.pop();
    if (out.length) out[out.length - 1]!.text = out[out.length - 1]!.text.replace(/ +$/, "");
    return out.filter((r) => r.text.length);
  }

  function lineCount(rects: DOMRect[]): number {
    const tops: number[] = [];
    for (const r of rects) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      if (!tops.some((t) => Math.abs(t - r.top) < Math.max(2, r.height / 2))) tops.push(r.top);
    }
    return Math.max(1, tops.length);
  }

  /** whole: the text is all the content of `parent`, so it fills its content box. */
  function textNode(parent: Element, pcs: CSSStyleDeclaration, nodes: Node[], whole: boolean): RawNode | null {
    const runs = tidy(
      (function () {
        const r: RawRun[] = [];
        runsOf(nodes, r);
        return r;
      })(),
    );
    if (!runs.length) return null;
    const range = document.createRange();
    range.setStartBefore(nodes[0]!);
    range.setEndAfter(nodes[nodes.length - 1]!);
    const rects = Array.prototype.slice.call(range.getClientRects()) as DOMRect[];
    const union = range.getBoundingClientRect();
    if (union.width < 0.5 || union.height < 0.5) return null;
    const lines = lineCount(rects);
    // Text directly in a flex row or a grid is an item sized by its content; in a stretching flex column
    // or a block it is as wide as the container.
    const flexColumn = /flex/.test(pcs.display) && /column/.test(pcs.flexDirection) && /normal|stretch/.test(pcs.alignItems);
    const flexItem = /flex|grid/.test(pcs.display) && !flexColumn;
    const nowrap = /nowrap|pre$/.test(pcs.whiteSpace);
    const autoWidth = flexItem || nowrap;
    let box = toBox(union);
    // Glyph boxes are shorter than line boxes: the layer spans whole lines, like Figma's text box.
    const lh = px(pcs.lineHeight);
    const first = rects.filter((r) => r.width >= 0.5)[0];
    if (lh > 0 && first) {
      box.y = r1(first.top + first.height / 2 - lh / 2 + sy);
      box.h = r1(lines * lh);
    }
    if (!autoWidth) {
      // Block text: as wide as its container's content box, so it wraps like the page.
      const r = parent.getBoundingClientRect();
      const left = r.left + px(pcs.borderLeftWidth) + px(pcs.paddingLeft);
      const right = r.right - px(pcs.borderRightWidth) - px(pcs.paddingRight);
      box = { x: r1(left + sx), y: box.y, w: r1(Math.max(union.width, right - left)), h: box.h };
      if (whole) {
        const top = r.top + px(pcs.borderTopWidth) + px(pcs.paddingTop);
        const bottom = r.bottom - px(pcs.borderBottomWidth) - px(pcs.paddingBottom);
        if (bottom - top >= union.height - 1) box = { x: box.x, y: r1(top + sy), w: box.w, h: r1(bottom - top) };
      }
    }
    return { kind: "text", tag: "#text", name: "", box, css: { textAlign: pcs.textAlign, whiteSpace: pcs.whiteSpace }, children: [], runs, lines, autoWidth };
  }

  // ─── Inline SVG ─────────────────────────────────────────────────────────────
  const SVG_PAINT = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "fill-rule"];
  function svgMarkup(el: SVGSVGElement, box: RawBox): string {
    const clone = el.cloneNode(true) as SVGSVGElement;
    // <use href="#sprite"> pointing outside this svg: inline the symbol.
    const uses = Array.prototype.slice.call(clone.querySelectorAll("use")) as SVGUseElement[];
    for (const u of uses) {
      const ref = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
      if (ref.charAt(0) !== "#") continue;
      const target = document.getElementById(ref.slice(1));
      if (!target) continue;
      const g = document.createElementNS("http://www.w3.org/2000/svg", target.tagName === "symbol" ? "svg" : "g");
      if (target.tagName === "symbol") {
        const vb = target.getAttribute("viewBox");
        if (vb) g.setAttribute("viewBox", vb);
        for (const a of ["x", "y", "width", "height"]) if (u.getAttribute(a)) g.setAttribute(a, u.getAttribute(a)!);
        for (const c of Array.prototype.slice.call(target.childNodes)) g.appendChild(c.cloneNode(true));
      } else {
        g.appendChild(target.cloneNode(true));
      }
      u.parentNode!.replaceChild(g, u);
    }
    // Paint set by CSS classes (fill-current, stroke-2…) becomes attributes; currentColor is resolved.
    const src = [el].concat(Array.prototype.slice.call(el.querySelectorAll("*")));
    const dst = [clone as Element].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
    if (src.length === dst.length) {
      for (let i = 0; i < src.length; i++) {
        const cs = getComputedStyle(src[i]!);
        for (const p of SVG_PAINT) {
          let v = cs.getPropertyValue(p);
          if (!v) continue;
          if (p === "fill" || p === "stroke") v = /^(?:none|url)/.test(v) ? v : color(v);
          if (dst[i]!.getAttribute(p) !== null || i === 0 || (p !== "opacity" && cs.getPropertyValue(p) !== getComputedStyle(src[i]!.parentElement || el).getPropertyValue(p))) {
            dst[i]!.setAttribute(p, v);
          }
        }
      }
    }
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(box.w));
    clone.setAttribute("height", String(box.h));
    clone.removeAttribute("class");
    clone.removeAttribute("style");
    return clone.outerHTML.replace(/currentColor/g, color(getComputedStyle(el).color));
  }

  // ─── Tree walk ──────────────────────────────────────────────────────────────
  function visit(el: Element): RawNode[] {
    if (SKIP.indexOf(el.tagName) !== -1) return [];
    if (count >= opts.maxNodes) {
      truncated = true;
      return [];
    }
    const cs = getComputedStyle(el);
    if (hidden(el, cs)) return [];
    if (cs.display === "contents") return childrenOf(el, cs);
    const rect = el.getBoundingClientRect();
    const box = toBox(rect);
    if (box.y > opts.maxHeight) return [];
    count++;
    const name = nameOf(el);
    const tag = el.tagName.toLowerCase();

    if (tag === "svg") {
      if (box.w < 0.5 || box.h < 0.5) return [];
      return [{ kind: "svg", tag, name, box, css: cssOf(cs), children: [], svg: svgMarkup(el as SVGSVGElement, box) }];
    }
    if (tag === "img") {
      const img = el as HTMLImageElement;
      if (box.w < 0.5 || box.h < 0.5) return [];
      if (!img.currentSrc && !img.src) return [];
      return [{ kind: "image", tag, name, box, css: cssOf(cs), children: [], src: img.currentSrc || img.src }];
    }
    const nativeControl =
      (tag === "input" && /^(checkbox|radio|range|color|file)$/i.test((el as HTMLInputElement).type)) || (tag === "select" && cs.appearance !== "none");
    if (RASTER.indexOf(el.tagName) !== -1 || nativeControl) {
      if (box.w < 0.5 || box.h < 0.5) return [];
      return [{ kind: "raster", tag, name, box, css: cssOf(cs), children: [] }];
    }
    const node: RawNode = { kind: "box", tag, name, box, css: cssOf(cs), children: [] };
    if (tag === "input" || tag === "textarea") {
      const input = el as HTMLInputElement;
      const value = input.type === "password" ? "•".repeat(input.value.length) : input.value;
      const text = value || input.placeholder || "";
      if (text) {
        const ts = textStyle(cs);
        if (!value) ts.color = color(getComputedStyle(el, "::placeholder").color);
        const left = rect.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
        const right = rect.right - px(cs.borderRightWidth) - px(cs.paddingRight);
        const lh = cs.lineHeight === "normal" ? ts.size * 1.2 : px(cs.lineHeight);
        const top = tag === "input" ? rect.top + (rect.height - lh) / 2 : rect.top + px(cs.borderTopWidth) + px(cs.paddingTop);
        node.children.push({
          kind: "text",
          tag: "#text",
          name: "",
          box: { x: r1(left + sx), y: r1(top + sy), w: r1(right - left), h: r1(lh) },
          css: { textAlign: cs.textAlign, whiteSpace: "nowrap" },
          children: [],
          runs: [{ text: text.replace(/\s+/g, " "), style: ts }],
          lines: 1,
        });
      }
      return [node];
    }
    node.children = childrenOf(el, cs);
    return [node];
  }

  function childrenOf(el: Element, cs: CSSStyleDeclaration): RawNode[] {
    const out: RawNode[] = [];
    let inline: Node[] = [];
    const flush = (last: boolean) => {
      if (!inline.length) return;
      const t = textNode(el, cs, inline, last && !out.length);
      inline = [];
      if (t) {
        count++;
        out.push(t);
      }
    };
    const kids = Array.prototype.slice.call(el.childNodes) as Node[];
    for (const k of kids) {
      if (k.nodeType === 3) {
        if ((k.nodeValue || "").trim() || inline.length) inline.push(k);
        continue;
      }
      if (k.nodeType !== 1) continue;
      const child = k as Element;
      if (child.tagName === "BR") {
        inline.push(k);
        continue;
      }
      if (SKIP.indexOf(child.tagName) !== -1) continue;
      const ccs = getComputedStyle(child);
      if (hidden(child, ccs)) continue;
      if (isPlainInline(child, ccs)) {
        inline.push(k);
        continue;
      }
      flush(false);
      for (const n of visit(child)) out.push(n);
    }
    flush(true);
    return out;
  }

  let rootEl: Element = document.body;
  if (opts.selector) {
    const found = document.querySelector(opts.selector);
    if (!found) throw new Error('No element matches the selector "' + opts.selector + '"');
    rootEl = found;
  }
  const doc = document.documentElement;
  const width = opts.selector ? rootEl.getBoundingClientRect().width : doc.clientWidth;
  const fullHeight = opts.selector ? rootEl.getBoundingClientRect().height : Math.max(doc.scrollHeight, document.body.scrollHeight);
  const height = Math.min(fullHeight, opts.maxHeight);
  if (fullHeight > opts.maxHeight) warnings.push("The page is " + Math.round(fullHeight) + " px tall: imported the first " + opts.maxHeight + " px (raise maxHeight for more).");
  const rootCs = getComputedStyle(rootEl);
  const root = visit(rootEl)[0] || { kind: "box", tag: rootEl.tagName.toLowerCase(), name: "", box: toBox(rootEl.getBoundingClientRect()), css: cssOf(rootCs), children: [] };
  root.kind = "box";
  if (!opts.selector) {
    // The canvas behind the page: html's background, else body's (CSS background propagation).
    const htmlBg = color(getComputedStyle(doc).backgroundColor);
    const bodyBg = color(rootCs.backgroundColor);
    const transparent = (c: string) => c.length === 9 && c.endsWith("00");
    root.box = { x: 0, y: 0, w: r1(width), h: r1(height) };
    root.css.backgroundColor = !transparent(htmlBg) ? htmlBg : !transparent(bodyBg) ? bodyBg : "#FFFFFF";
    root.css.overflowX = root.css.overflowY = "hidden";
  }
  return { title: document.title, url: location.href, width: r1(width), height: r1(height), root, nodes: count, truncated, warnings };
}

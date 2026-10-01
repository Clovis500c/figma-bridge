// export_code, server side: turns the layer tree exported by the plugin into HTML or React,
// styled with plain CSS or Tailwind classes. Auto-layout maps to flexbox/grid, text to semantic tags.

export type Framework = "html" | "react";
export type Styling = "css" | "tailwind";

export interface Segment {
  text: string;
  family: string;
  style: string;
  weight: number;
  size: number;
  color?: string;
  decoration?: string;
  link?: string;
  letterSpacing?: string;
  lineHeight?: string;
  textCase?: string;
}

export interface IrNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  sizeH: "fixed" | "hug" | "fill";
  sizeV: "fixed" | "hug" | "fill";
  absolute?: boolean;
  grow?: boolean;
  colSpan?: number;
  rowSpan?: number;
  rotation?: number;
  clip?: boolean;
  css: Record<string, string>;
  layout?: {
    mode: "row" | "column" | "grid";
    padding: number[];
    gap?: number;
    justify?: string;
    align?: string;
    wrap?: boolean;
    rowGap?: number;
    columnGap?: number;
    columns?: string[];
    rows?: string[];
  };
  text?: { autoResize: string; align: string; valign: string; truncate: number; segments: Segment[] };
  asset?: { file: string; kind: "svg" | "image"; fit?: string };
  bgImage?: { file: string; fit: string };
  children?: IrNode[];
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface CodegenOptions {
  framework: Framework;
  styling: Styling;
  /** Final asset path for each file name the plugin gave, e.g. "hero.img" → "assets/hero.png". */
  assetPath: (file: string) => string;
}

type Style = Record<string, string>;

interface El {
  tag: string;
  cls: string;
  style: Style;
  attrs: [string, string][];
  /** React only: inline style entries whose value is a JS expression. */
  inline?: [string, string][];
  children: (El | string)[];
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const kebab = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "n$1");
const pascal = (s: string) => kebab(s).replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase()) || "Design";
const camel = (s: string) => pascal(s).replace(/^./, (c) => c.toLowerCase());

const JUSTIFY: Record<string, string> = { CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" };
const ALIGN: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", BASELINE: "baseline" };
const TEXT_ALIGN: Record<string, string> = { CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };

const NAME_TAGS: [RegExp, string][] = [
  [/\b(button|btn|cta)\b/i, "button"],
  [/^(header|top ?bar|app ?bar)\b/i, "header"],
  [/^(nav|navbar|navigation|menu)\b/i, "nav"],
  [/^footer\b/i, "footer"],
  [/^main\b/i, "main"],
  [/^(section|hero)\b/i, "section"],
  [/^(aside|sidebar)\b/i, "aside"],
  [/^form\b/i, "form"],
  [/^link\b/i, "a"],
];
const INLINE_PARENTS = ["button", "a", "span", "h1", "h2", "h3", "p"];

function padding(p: number[]): string | null {
  const [t, r, b, l] = p.map((v) => Math.round(v * 100) / 100) as [number, number, number, number];
  if (!t && !r && !b && !l) return null;
  if (t === b && r === l) return t === r ? px(t) : `${px(t)} ${px(r)}`;
  return [t, r, b, l].map(px).join(" ");
}

function dominant(segments: Segment[]): Segment {
  return segments.reduce((best, s) => (s.text.length > best.text.length ? s : best), segments[0]!);
}

function segmentStyle(s: Segment): Style {
  const st: Style = {
    "font-family": `${/\s/.test(s.family) ? `'${s.family}'` : s.family}, sans-serif`,
    "font-size": px(s.size),
    "font-weight": String(s.weight),
  };
  if (/italic|oblique/i.test(s.style)) st["font-style"] = "italic";
  if (s.lineHeight) st["line-height"] = s.lineHeight;
  if (s.letterSpacing) st["letter-spacing"] = s.letterSpacing;
  if (s.color) st.color = s.color;
  if (s.textCase) st["text-transform"] = s.textCase;
  if (s.decoration) st["text-decoration"] = s.decoration;
  return st;
}

function diffStyle(base: Style, s: Style): Style {
  const out: Style = {};
  for (const [k, v] of Object.entries(s)) if (base[k] !== v) out[k] = v;
  return out;
}

class Generator {
  private classes = new Map<string, number>();
  private images = new Map<string, string>(); // asset path → React import name
  private fonts = new Map<string, Set<number>>();
  readonly warnings: string[] = [];

  constructor(private opts: CodegenOptions) {}

  private className(name: string, fallback: string): string {
    const base = kebab(name) || fallback;
    const n = (this.classes.get(base) ?? 0) + 1;
    this.classes.set(base, n);
    return n > 1 ? `${base}-${n}` : base;
  }

  private imageRef(file: string): string {
    const path = this.opts.assetPath(file);
    if (this.opts.framework !== "react") return path;
    let name = this.images.get(path);
    if (!name) {
      name = camel("img " + file.replace(/\.[a-z]+$/, ""));
      while ([...this.images.values()].includes(name)) name += "2";
      this.images.set(path, name);
    }
    return name;
  }

  private sizeAndPosition(n: IrNode, parent: IrNode | null, st: Style) {
    const mode = parent?.layout?.mode;
    const isText = !!n.text;
    const nowrap = isText && n.text!.autoResize === "WIDTH_AND_HEIGHT";
    const fixedW = (st2: Style) => {
      if (!nowrap) st2.width = px(n.w);
    };
    const fixedH = (st2: Style) => {
      if (!isText || n.text!.autoResize === "NONE" || n.text!.autoResize === "TRUNCATE") st2.height = px(n.h);
    };
    if (!parent) {
      if (n.sizeH !== "hug") fixedW(st);
      if (n.sizeV !== "hug") fixedH(st);
    } else if (n.absolute || !mode) {
      st.position = "absolute";
      st.left = px(n.x);
      st.top = px(n.y);
      if (!(isText && n.sizeH === "hug")) fixedW(st);
      if (!(isText && n.sizeV === "hug")) fixedH(st);
    } else if (mode === "row" || mode === "column") {
      const main = mode === "row" ? n.sizeH : n.sizeV;
      const cross = mode === "row" ? n.sizeV : n.sizeH;
      if (main === "fill") {
        st.flex = "1 1 0";
        st[mode === "row" ? "min-width" : "min-height"] = "0";
      } else if (main === "fixed") {
        (mode === "row" ? fixedW : fixedH)(st);
        st["flex-shrink"] = "0";
      } else if (n.grow) st["flex-grow"] = "1";
      if (cross === "fill") st["align-self"] = "stretch";
      else if (cross === "fixed") (mode === "row" ? fixedH : fixedW)(st);
    } else {
      if (n.sizeH === "fixed") fixedW(st);
      else if (n.sizeH === "hug") st["justify-self"] = "start";
      else st.width = "100%";
      if (n.sizeV === "fixed") fixedH(st);
      else if (n.sizeV === "hug") st["align-self"] = "start";
      else st.height = "100%";
      if (n.colSpan) st["grid-column"] = `span ${n.colSpan} / span ${n.colSpan}`;
      if (n.rowSpan) st["grid-row"] = `span ${n.rowSpan} / span ${n.rowSpan}`;
    }
    if (nowrap) st["white-space"] = "nowrap";
  }

  private layout(n: IrNode, st: Style) {
    const l = n.layout;
    if (!l) {
      if (n.children?.length && !st.position) st.position = "relative";
      return;
    }
    const pad = padding(l.padding);
    if (l.mode === "grid") {
      st.display = "grid";
      if (l.columns?.length) st["grid-template-columns"] = l.columns.join(" ");
      if (l.rows?.length) st["grid-template-rows"] = l.rows.join(" ");
      if (l.columnGap) st["column-gap"] = px(l.columnGap);
      if (l.rowGap) st["row-gap"] = px(l.rowGap);
    } else {
      st.display = "flex";
      if (l.mode === "column") st["flex-direction"] = "column";
      if (l.gap) st.gap = px(l.gap);
      if (l.justify && JUSTIFY[l.justify]) st["justify-content"] = JUSTIFY[l.justify]!;
      st["align-items"] = ALIGN[l.align ?? "MIN"] ?? "flex-start";
      if (l.wrap) {
        st["flex-wrap"] = "wrap";
        if (l.rowGap) st["row-gap"] = px(l.rowGap);
      }
    }
    if (pad) st.padding = pad;
    if (n.children?.some((c) => c.absolute) && !st.position) st.position = "relative";
  }

  private tagFor(n: IrNode, inline: boolean): string {
    if (n.asset) return "img";
    if (n.text) {
      const segs = n.text.segments;
      if (segs.length && segs.every((s) => s.link && s.link === segs[0]!.link)) return "a";
      if (inline) return "span";
      const d = dominant(segs);
      if (d.size >= 28) return "h1";
      if (d.size >= 22) return "h2";
      if (d.size >= 18 && d.weight >= 600) return "h3";
      return "p";
    }
    for (const [re, tag] of NAME_TAGS) if (re.test(n.name)) return inline ? "span" : tag;
    return inline ? "span" : "div";
  }

  element(n: IrNode, parent: IrNode | null, parentTag: string): El {
    const inline = INLINE_PARENTS.includes(parentTag);
    const tag = this.tagFor(n, inline);
    const st: Style = {};
    this.sizeAndPosition(n, parent, st);
    this.layout(n, st);
    Object.assign(st, n.css);
    if (n.rotation) st.transform = `rotate(${-n.rotation}deg)`;
    if (n.clip) st.overflow = "hidden";
    if (tag === "span" && !n.text && !st.display) st.display = "block";
    if (tag === "button" || tag === "a") st.cursor = "pointer";
    if ((tag === "button" || (tag === "a" && !n.text)) && !st.display) st.display = "block";

    const el: El = { tag, cls: this.opts.styling === "css" ? this.className(n.name, tag) : "", style: st, attrs: [], children: [] };

    if (n.asset) {
      el.attrs.push(["src", this.imageRef(n.asset.file)], ["alt", n.asset.kind === "svg" ? "" : n.name]);
      if (n.asset.kind === "image") st["object-fit"] = n.asset.fit === "contain" ? "contain" : "cover";
      return el;
    }
    if (n.bgImage) {
      delete st.background;
      st["background-size"] = n.bgImage.fit === "tile" ? "auto" : n.bgImage.fit;
      st["background-position"] = "center";
      if (n.bgImage.fit !== "tile") st["background-repeat"] = "no-repeat";
      const ref = this.imageRef(n.bgImage.file);
      if (this.opts.framework === "react") el.inline = [["backgroundImage", "`url(${" + ref + "})`"]];
      else st["background-image"] = `url('${ref}')`;
    }
    if (n.text) {
      this.textContent(n, el);
      return el;
    }
    if (tag === "button") el.attrs.push(["type", "button"]);
    if (tag === "a") el.attrs.push(["href", "#"]);
    for (const c of n.children ?? []) el.children.push(this.element(c, n, tag));
    return el;
  }

  private textContent(n: IrNode, el: El) {
    const t = n.text!;
    const segs = t.segments.length ? t.segments : [{ text: "", family: "Inter", style: "Regular", weight: 400, size: 14 }];
    const base = segmentStyle(dominant(segs));
    Object.assign(el.style, base);
    if (TEXT_ALIGN[t.align]) el.style["text-align"] = TEXT_ALIGN[t.align]!;
    if (t.truncate === 1) Object.assign(el.style, { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
    else if (t.truncate > 1) Object.assign(el.style, { display: "-webkit-box", "-webkit-line-clamp": String(t.truncate), "-webkit-box-orient": "vertical", overflow: "hidden" });
    for (const s of segs) this.fonts.set(s.family, (this.fonts.get(s.family) ?? new Set()).add(s.weight));
    if (el.tag === "a") el.attrs.push(["href", segs[0]!.link!]);

    for (const s of segs) {
      const diff = diffStyle(base, segmentStyle(s));
      const parts = s.text.split("\n");
      const pieces: (El | string)[] = [];
      parts.forEach((p, i) => {
        if (i) pieces.push({ tag: "br", cls: "", style: {}, attrs: [], children: [] });
        if (p) pieces.push(p);
      });
      const link = s.link && el.tag !== "a" ? s.link : undefined;
      if (!Object.keys(diff).length && !link) {
        el.children.push(...pieces);
        continue;
      }
      const span: El = {
        tag: link ? "a" : "span",
        cls: this.opts.styling === "css" && Object.keys(diff).length ? this.className(`${el.cls || n.name}-${link ? "link" : "span"}`, "span") : "",
        style: diff,
        attrs: link ? [["href", link]] : [],
        children: pieces,
      };
      el.children.push(span);
    }
  }

  // ─── Output ───────────────────────────────────────────────────────────────

  render(root: El, name: string): GeneratedFile[] {
    const css: string[] = [];
    const collect = (el: El) => {
      if (el.cls && Object.keys(el.style).length) css.push(`.${el.cls} {\n${Object.entries(el.style).map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`);
      for (const c of el.children) if (typeof c !== "string") collect(c);
    };
    if (this.opts.styling === "css") collect(root);
    const component = pascal(name);
    const reset =
      this.opts.styling === "css"
        ? `*, *::before, *::after { box-sizing: border-box; }\nbody, h1, h2, h3, p { margin: 0; }\nbutton { font: inherit; color: inherit; border: none; background: none; padding: 0; text-align: inherit; }\na { color: inherit; text-decoration: none; }\n\n`
        : "";
    const fontLinks = [...this.fonts.entries()].map(
      ([family, weights]) =>
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${[...weights].sort((a, b) => a - b).join(";")}&display=swap" />`,
    );

    if (this.opts.framework === "html") {
      const head = [
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
        `<title>${escapeHtml(name)}</title>`,
        ...fontLinks,
        ...(this.opts.styling === "tailwind" ? ['<script src="https://cdn.tailwindcss.com"></script>'] : []),
        ...(this.opts.styling === "css" ? [`<style>\n${indent(reset + css.join("\n\n"), 2)}\n</style>`] : []),
      ];
      const html = `<!doctype html>\n<html lang="en">\n<head>\n${indent(head.join("\n"), 2)}\n</head>\n<body>\n${this.markup(root, 1, false)}\n</body>\n</html>\n`;
      return [{ path: "index.html", content: html }];
    }

    const imports = [...this.images.entries()].map(([path, v]) => `import ${v} from "./${path}";`);
    if (this.opts.styling === "css") imports.unshift(`import "./${component}.css";`);
    const notes = fontLinks.length ? `// Fonts: ${[...this.fonts.keys()].join(", ")} (load them in your app, e.g. from Google Fonts).\n` : "";
    const jsx = `${imports.join("\n")}${imports.length ? "\n\n" : ""}${notes}export default function ${component}() {\n  return (\n${this.markup(root, 2, true)}\n  );\n}\n`;
    const files: GeneratedFile[] = [{ path: `${component}.jsx`, content: jsx }];
    if (this.opts.styling === "css") files.push({ path: `${component}.css`, content: reset + css.join("\n\n") + "\n" });
    return files;
  }

  private markup(el: El, depth: number, react: boolean): string {
    const pad = "  ".repeat(depth);
    const attrs: string[] = [];
    const classes = this.opts.styling === "tailwind" ? tailwind(el.style).join(" ") : el.cls && Object.keys(el.style).length ? el.cls : "";
    if (classes) attrs.push(`${react ? "className" : "class"}="${classes}"`);
    for (const [k, v] of el.attrs) {
      if (react && k === "src" && /^[A-Za-z_$][\w$]*$/.test(v)) attrs.push(`src={${v}}`);
      else attrs.push(`${k}="${escapeAttr(v)}"`);
    }
    if (el.inline?.length) attrs.push(`style={{ ${el.inline.map(([k, v]) => `${k}: ${v}`).join(", ")} }}`);
    const open = `<${el.tag}${attrs.length ? " " + attrs.join(" ") : ""}`;
    if (el.tag === "img" || el.tag === "br") return pad + open + (react ? " />" : el.tag === "br" ? ">" : " />");
    const text = (s: string) => (react ? escapeJsx(s) : escapeHtml(s));
    const simple = el.children.every((c) => typeof c === "string" || c.tag === "br" || (c.children.every((x) => typeof x === "string") && c.tag !== "img"));
    if (!el.children.length) return `${pad}${open}></${el.tag}>`;
    if (simple && el.children.length <= 12) {
      const inner = el.children.map((c) => (typeof c === "string" ? text(c) : this.markup(c, 0, react).trim())).join("");
      if (inner.length < 160) return `${pad}${open}>${inner}</${el.tag}>`;
    }
    const inner = el.children.map((c) => (typeof c === "string" ? "  ".repeat(depth + 1) + text(c) : this.markup(c, depth + 1, react))).join("\n");
    return `${pad}${open}>\n${inner}\n${pad}</${el.tag}>`;
  }

  fontFamilies() {
    return [...this.fonts.keys()];
  }
}

function indent(s: string, n: number) {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");
const escapeJsx = (s: string) => escapeHtml(s).replace(/[{}]/g, (c) => `{"${c}"}`);

// ─── Tailwind ───────────────────────────────────────────────────────────────

const SPACING: Record<number, string> = { 1: "px" };
for (const k of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96]) SPACING[k * 4] = String(k);
const FONT_SIZES: Record<number, string> = { 12: "xs", 14: "sm", 16: "base", 18: "lg", 20: "xl", 24: "2xl", 30: "3xl", 36: "4xl", 48: "5xl", 60: "6xl", 72: "7xl", 96: "8xl", 128: "9xl" };
const WEIGHTS: Record<string, string> = { "100": "thin", "200": "extralight", "300": "light", "400": "normal", "500": "medium", "600": "semibold", "700": "bold", "800": "extrabold", "900": "black" };
const RADII: Record<number, string> = { 2: "rounded-sm", 4: "rounded", 6: "rounded-md", 8: "rounded-lg", 12: "rounded-xl", 16: "rounded-2xl", 24: "rounded-3xl" };

const pxOf = (v: string) => (/^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);
const arb = (v: string) => v.trim().replace(/_/g, "\\_").replace(/\s+/g, "_");
const isColor = (v: string) => /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i.test(v.trim());

function spacing(prefix: string, v: string): string {
  const n = pxOf(v);
  if (n !== null && SPACING[n] !== undefined) return `${prefix}-${SPACING[n]}`;
  return `${prefix}-[${arb(v)}]`;
}

function paddingClasses(v: string): string[] {
  const p = v.split(/\s+/);
  const [t, r = t, b = t, l = r] = p as [string, string?, string?, string?];
  if (t === r && r === b && b === l) return [spacing("p", t!)];
  if (t === b && r === l) return [spacing("px", r!), spacing("py", t!)];
  return [spacing("pt", t!), spacing("pr", r!), spacing("pb", b!), spacing("pl", l!)];
}

/** CSS declarations → Tailwind classes (scale values when they match, arbitrary values otherwise). */
export function tailwind(st: Style): string[] {
  const out: string[] = [];
  for (const [k, raw] of Object.entries(st)) {
    const v = raw.trim();
    switch (k) {
      case "display":
        out.push(v === "flex" ? "flex" : v === "grid" ? "grid" : v === "block" ? "block" : `[display:${arb(v)}]`);
        break;
      case "flex-direction":
        if (v === "column") out.push("flex-col");
        break;
      case "flex-wrap":
        out.push("flex-wrap");
        break;
      case "gap":
        out.push(spacing("gap", v));
        break;
      case "row-gap":
        out.push(spacing("gap-y", v));
        break;
      case "column-gap":
        out.push(spacing("gap-x", v));
        break;
      case "padding":
        out.push(...paddingClasses(v));
        break;
      case "justify-content":
        out.push({ center: "justify-center", "flex-end": "justify-end", "space-between": "justify-between", "flex-start": "justify-start" }[v] ?? `[justify-content:${arb(v)}]`);
        break;
      case "align-items":
        out.push({ "flex-start": "items-start", center: "items-center", "flex-end": "items-end", baseline: "items-baseline", stretch: "items-stretch" }[v] ?? `[align-items:${arb(v)}]`);
        break;
      case "align-self":
        out.push({ stretch: "self-stretch", start: "self-start", "flex-start": "self-start", center: "self-center" }[v] ?? `[align-self:${arb(v)}]`);
        break;
      case "justify-self":
        out.push(v === "start" ? "justify-self-start" : `[justify-self:${arb(v)}]`);
        break;
      case "flex":
        out.push(v === "1 1 0" ? "flex-1" : `flex-[${arb(v)}]`);
        break;
      case "flex-grow":
        out.push("grow");
        break;
      case "flex-shrink":
        out.push(v === "0" ? "shrink-0" : "shrink");
        break;
      case "min-width":
      case "min-height":
        out.push(v === "0" ? `${k === "min-width" ? "min-w" : "min-h"}-0` : `${k === "min-width" ? "min-w" : "min-h"}-[${arb(v)}]`);
        break;
      case "width":
        out.push(v === "100%" ? "w-full" : spacing("w", v));
        break;
      case "height":
        out.push(v === "100%" ? "h-full" : spacing("h", v));
        break;
      case "position":
        out.push(v);
        break;
      case "left":
      case "top":
        out.push(spacing(k, v).replace(/^(left|top)-\[-/, "-$1-["));
        break;
      case "overflow":
        out.push(`overflow-${v}`);
        break;
      case "text-overflow":
        out.push(v === "ellipsis" ? "text-ellipsis" : `[text-overflow:${arb(v)}]`);
        break;
      case "white-space":
        out.push(v === "nowrap" ? "whitespace-nowrap" : `whitespace-${v}`);
        break;
      case "grid-template-columns":
        out.push(`grid-cols-[${arb(v)}]`);
        break;
      case "grid-template-rows":
        out.push(`grid-rows-[${arb(v)}]`);
        break;
      case "grid-column":
      case "grid-row": {
        const m = /^span (\d+)/.exec(v);
        out.push(m ? `${k === "grid-column" ? "col" : "row"}-span-${m[1]}` : `[${k}:${arb(v)}]`);
        break;
      }
      case "font-family":
        out.push(`font-['${v.replace(/, sans-serif$/, "").replace(/^'|'$/g, "").replace(/ /g, "_")}']`);
        break;
      case "font-size": {
        const n = pxOf(v);
        out.push(n !== null && FONT_SIZES[n] ? `text-${FONT_SIZES[n]}` : `text-[${arb(v)}]`);
        break;
      }
      case "font-weight":
        out.push(WEIGHTS[v] ? `font-${WEIGHTS[v]}` : `font-[${arb(v)}]`);
        break;
      case "font-style":
        if (v === "italic") out.push("italic");
        break;
      case "line-height":
        out.push(`leading-[${arb(v)}]`);
        break;
      case "letter-spacing":
        out.push(`tracking-[${arb(v)}]`);
        break;
      case "color":
        out.push(isColor(v) ? `text-[${arb(v)}]` : `[color:${arb(v)}]`);
        break;
      case "text-align":
        out.push(`text-${v}`);
        break;
      case "text-transform":
        out.push(v === "capitalize" ? "capitalize" : v);
        break;
      case "text-decoration":
        out.push(v === "underline" ? "underline" : v === "line-through" ? "line-through" : `[text-decoration:${arb(v)}]`);
        break;
      case "background":
        out.push(isColor(v) ? `bg-[${arb(v)}]` : `[background:${arb(v)}]`);
        break;
      case "background-image":
        out.push(`bg-[${arb(v)}]`);
        break;
      case "background-size":
        out.push(v === "cover" ? "bg-cover" : v === "contain" ? "bg-contain" : `bg-[length:${arb(v)}]`);
        break;
      case "background-position":
        out.push(v === "center" ? "bg-center" : `bg-[position:${arb(v)}]`);
        break;
      case "background-repeat":
        out.push(v === "no-repeat" ? "bg-no-repeat" : `bg-${v}`);
        break;
      case "border-radius": {
        const n = pxOf(v);
        out.push(n !== null && n >= 999 ? "rounded-full" : n !== null && RADII[n] ? RADII[n]! : `rounded-[${arb(v)}]`);
        break;
      }
      case "border": {
        const m = /^([\d.]+px)\s+(solid|dashed|dotted)\s+(.+)$/.exec(v);
        if (!m) out.push(`[border:${arb(v)}]`);
        else {
          out.push(m[1] === "1px" ? "border" : `border-[${m[1]}]`);
          if (m[2] !== "solid") out.push(`border-${m[2]}`);
          out.push(isColor(m[3]!) ? `border-[${arb(m[3]!)}]` : `[border-color:${arb(m[3]!)}]`);
        }
        break;
      }
      case "box-shadow":
        out.push(`shadow-[${arb(v)}]`);
        break;
      case "opacity": {
        const n = Math.round(parseFloat(v) * 100);
        out.push(n % 5 === 0 ? `opacity-${n}` : `opacity-[${v}]`);
        break;
      }
      case "object-fit":
        out.push(`object-${v}`);
        break;
      case "cursor":
        out.push(`cursor-${v}`);
        break;
      case "transform": {
        const m = /^rotate\((-?[\d.]+)deg\)$/.exec(v);
        out.push(m ? (m[1]!.startsWith("-") ? `-rotate-[${m[1]!.slice(1)}deg]` : `rotate-[${m[1]}deg]`) : `[transform:${arb(v)}]`);
        break;
      }
      default:
        out.push(`[${k}:${arb(v)}]`);
    }
  }
  return out;
}

export function generateCode(tree: IrNode, opts: CodegenOptions): { files: GeneratedFile[]; fonts: string[]; warnings: string[] } {
  const gen = new Generator(opts);
  const root = gen.element(tree, null, "");
  const files = gen.render(root, tree.name || "Design");
  return { files, fonts: gen.fontFamilies(), warnings: gen.warnings };
}

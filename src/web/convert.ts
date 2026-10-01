// import_web: turns the page snapshot into a `build` spec. Layout is inferred from the boxes the
// browser computed, then checked by simulating Figma's auto-layout: a container gets auto-layout
// only when it reproduces every child position within TOL px, else its children keep x/y.
import type { RawNode, RawRun, Snapshot } from "./dom";
import type { FontIndex } from "./fonts";
import { backgroundPaints, blurOf, border, borderWidths, type Box, isTransparent, px, r1, radius, shadows } from "./css";

export type Spec = Record<string, any>;

export interface Asset {
  /** Image URL to download; absent for layers rendered from the page (canvas, video, native controls). */
  url?: string;
  /** Where to take a picture of it in the page when there is no URL or the download fails. */
  box: Box;
  /** A layer of its own (can be rasterized), not a background fill. */
  layer: boolean;
}

export interface ConvertResult {
  spec: Spec;
  assets: Record<string, Asset>;
  substitutions: Record<string, string>;
  warnings: string[];
  stats: { layers: number; text: number; images: number; autoLayout: number; free: number };
  truncated: boolean;
}

export interface ConvertOptions {
  fonts: FontIndex;
  maxNodes: number;
  name?: string;
}

const TOL = 1.5;
type Dir = "row" | "column";
type Align = "start" | "center" | "end";

const TAG_NAMES: Record<string, string> = {
  header: "Header",
  nav: "Nav",
  main: "Main",
  footer: "Footer",
  section: "Section",
  article: "Article",
  aside: "Sidebar",
  form: "Form",
  button: "Button",
  a: "Link",
  ul: "List",
  ol: "List",
  li: "List item",
  input: "Input",
  textarea: "Text area",
  select: "Select",
  label: "Label",
  table: "Table",
  tr: "Row",
  td: "Cell",
  th: "Cell",
  figure: "Figure",
  img: "Image",
  svg: "Icon",
  video: "Video",
  canvas: "Canvas",
  iframe: "Embed",
  h1: "Heading",
  h2: "Heading",
  h3: "Heading",
  h4: "Heading",
  h5: "Heading",
  h6: "Heading",
  p: "Paragraph",
  blockquote: "Quote",
  dialog: "Dialog",
  "fb-pseudo": "Decoration",
};

const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol;
const outOfFlow = (n: RawNode) => n.css.position === "absolute" || n.css.position === "fixed";

class Converter {
  assets: Record<string, Asset> = {};
  substitutions: Record<string, string> = {};
  warnings = new Set<string>();
  stats = { layers: 0, text: 0, images: 0, autoLayout: 0, free: 0 };
  truncated = false;
  private urlKeys = new Map<string, string>();
  private n = 0;

  constructor(private opts: ConvertOptions) {}

  warn(msg: string) {
    if (this.warnings.size < 40) this.warnings.add(msg);
  }

  private asset(url: string | undefined, box: Box, layer: boolean): string {
    if (url && !layer && this.urlKeys.has(url)) return this.urlKeys.get(url)!;
    if (url && layer && this.urlKeys.has(url) && this.assets[this.urlKeys.get(url)!]!.layer) return this.urlKeys.get(url)!;
    const key = `w${this.n++}`;
    this.assets[key] = { url, box, layer };
    if (url) this.urlKeys.set(url, key);
    return key;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  hasVisuals(n: RawNode): boolean {
    const c = n.css;
    if (!isTransparent(c.backgroundColor) || (c.backgroundImage && c.backgroundImage !== "none")) return true;
    if (borderWidths(c).some((w) => w > 0)) return true;
    if (c.boxShadow && c.boxShadow !== "none") return true;
    if (c.opacity && Number(c.opacity) < 1) return true;
    if (blurOf(c.filter) || blurOf(c.backdropFilter)) return true;
    if (/hidden|clip|auto|scroll/.test(`${c.overflowX} ${c.overflowY}`) && n.children.some((k) => !inside(k.box, n.box))) return true;
    return false;
  }

  /** Drops invisible empty boxes and wrappers that add nothing (same box as their only child). */
  prune(n: RawNode): RawNode | null {
    if (n.kind !== "box") return n;
    n.children = n.children.map((c) => this.prune(c)).filter((c): c is RawNode => !!c);
    if (!n.children.length && !this.hasVisuals(n) && n.tag !== "input" && n.tag !== "textarea") return null;
    if (n.children.length === 1 && !this.hasVisuals(n) && n.tag !== "body") {
      const c = n.children[0]!;
      if (sameBox(c.box, n.box)) {
        if (outOfFlow(n)) c.css.position = n.css.position!;
        else if (outOfFlow(c)) return n; // keep the in-flow wrapper of a positioned child
        if (n.css.flexGrow) c.css.flexGrow = n.css.flexGrow;
        if (n.css.alignSelf) c.css.alignSelf = n.css.alignSelf;
        if (n.css.zIndex) c.css.zIndex = n.css.zIndex;
        if (!c.name && c.kind !== "text") c.name = n.name || TAG_NAMES[n.tag] || "";
        if (c.kind === "box" && /^(div|span)$/.test(c.tag) && TAG_NAMES[n.tag]) c.tag = n.tag;
        return c;
      }
    }
    return n;
  }

  // ─── Nodes ────────────────────────────────────────────────────────────────

  node(n: RawNode): Spec | null {
    if (this.stats.layers >= this.opts.maxNodes) {
      this.truncated = true;
      return null;
    }
    this.stats.layers++;
    if (n.kind === "text") return this.text(n);
    if (n.kind === "svg") return { type: "svg", name: n.name || "Icon", svg: n.svg, w: n.box.w, h: n.box.h, ...this.effects(n) };
    if (n.kind === "image" || n.kind === "raster") {
      this.stats.images++;
      const fits: Record<string, string> = { contain: "fit", cover: "fill", none: "crop", "scale-down": "fit" };
      const key = this.asset(n.kind === "image" ? n.src : undefined, n.box, true);
      return {
        type: "image",
        name: n.name || TAG_NAMES[n.tag] || "Image",
        imageKey: key,
        w: n.box.w,
        h: n.box.h,
        fit: fits[n.css.objectFit ?? ""] ?? "fill",
        ...this.decoration(n),
      };
    }
    return this.box(n);
  }

  private effects(n: RawNode): Spec {
    const out: Spec = {};
    const c = n.css;
    if (c.opacity && Number(c.opacity) < 1) out.opacity = Math.round(Number(c.opacity) * 100) / 100;
    const sh = shadows(c.boxShadow);
    if (sh.length) out.shadow = sh;
    const blur = blurOf(c.filter);
    if (blur) out.blur = blur;
    const bg = blurOf(c.backdropFilter);
    if (bg) out.backgroundBlur = bg;
    return out;
  }

  /** Radius, border, shadow, opacity: everything but the fill. */
  private decoration(n: RawNode): Spec {
    const out: Spec = { ...this.effects(n), ...border(n.css, (m) => this.warn(`${label(n)}: ${m}`)) };
    const r = radius(n.css, n.box);
    if (r !== undefined) out.radius = r;
    return out;
  }

  private box(n: RawNode): Spec {
    const spec: Spec = { name: n.name || TAG_NAMES[n.tag] || "" };
    const paints = backgroundPaints(n.css, n.box, (m) => this.warn(`${label(n)}: ${m}`)).map((p: any) =>
      p && typeof p === "object" && p.image ? { imageKey: this.asset(p.image, n.box, false), fit: p.fit } : p,
    );
    if (paints.length) spec.fill = paints.length === 1 ? paints[0] : paints;
    Object.assign(spec, this.decoration(n));
    if (/hidden|clip|auto|scroll/.test(`${n.css.overflowX} ${n.css.overflowY}`)) spec.clip = true;

    const flow = n.children.filter((c) => !outOfFlow(c));
    const positioned = n.children.filter(outOfFlow);
    const layout = flow.length ? this.layout(n, flow) : null;
    const children: Spec[] = [];
    if (layout) {
      this.stats.autoLayout++;
      Object.assign(spec, layout.props);
      for (const item of layout.items) {
        if (item.spacer !== undefined) {
          this.stats.layers++;
          const s = Math.max(0.01, r1(item.spacer));
          children.push({ name: "Spacer", w: layout.dir === "row" ? s : 1, h: layout.dir === "row" ? 1 : s });
          continue;
        }
        const child = this.node(item.node!);
        if (!child) break;
        // Rows and grids: main = width, cross = height; columns the other way round.
        if (item.fillMain) child[layout.dir === "column" ? "h" : "w"] = "fill";
        if (item.fillCross) child[layout.dir === "column" ? "w" : "h"] = "fill";
        if (item.colSpan && item.colSpan > 1) child.colSpan = item.colSpan;
        if (item.rowSpan && item.rowSpan > 1) child.rowSpan = item.rowSpan;
        if (item.wrap) {
          this.stats.layers++;
          children.push({
            name: "Align",
            layout: layout.dir === "row" ? "column" : "row",
            [layout.dir === "row" ? "h" : "w"]: "fill",
            [layout.dir === "row" ? "w" : "h"]: "hug",
            justify: item.wrap,
            children: [child],
          });
        } else children.push(child);
      }
      // A container with fill children (or space distribution) keeps its size instead of hugging.
      spec.w = layout.fixedW || children.some((c) => c.w === "fill") ? n.box.w : "hug";
      spec.h = layout.fixedH || children.some((c) => c.h === "fill") ? n.box.h : "hug";
    } else {
      if (flow.length) this.stats.free++;
      spec.w = n.box.w;
      spec.h = n.box.h;
      for (const c of paintOrder(flow)) {
        const child = this.node(c);
        if (!child) break;
        children.push(this.placeAt(child, c, n));
      }
    }
    for (const c of paintOrder(positioned)) {
      const child = this.node(c);
      if (!child) break;
      children.push({ ...this.placeAt(child, c, n), ...(layout ? { absolute: true } : {}) });
    }
    if (children.length) spec.children = children;
    if (!spec.name) spec.name = layout ? (layout.dir === "grid" ? "Grid" : layout.dir === "row" ? "Row" : "Column") : "Frame";
    return spec;
  }

  /** x/y inside a frame without auto-layout (or absolute inside one): sizes become fixed. */
  private placeAt(child: Spec, c: RawNode, parent: RawNode): Spec {
    child.x = r1(c.box.x - parent.box.x);
    child.y = r1(c.box.y - parent.box.y);
    if (child.w === "fill" || child.w === "hug" || (child.w === undefined && c.kind !== "text")) child.w = c.box.w;
    if (child.h === "fill" || child.h === "hug") child.h = c.box.h;
    if (c.kind === "box" && child.h === undefined) child.h = c.box.h;
    return child;
  }

  // ─── Text ─────────────────────────────────────────────────────────────────

  private font(run: RawRun) {
    const f = this.opts.fonts.resolve(run.style.family, run.style.weight, run.style.italic);
    if (f.substituted) this.substitutions[f.substituted] = f.family;
    return `${f.family}:${f.style}`;
  }

  private text(n: RawNode): Spec {
    this.stats.text++;
    const runs = n.runs ?? [];
    const base = runs.reduce((a, b) => (b.text.length > a.text.length ? b : a), runs[0]!);
    const s = base.style;
    const spec: Spec = { font: this.font(base), size: s.size, color: s.color };
    const lh = px(s.lineHeight);
    if (s.lineHeight !== "normal" && lh > 4) spec.lineHeight = r1(lh);
    const ls = px(s.letterSpacing);
    if (s.letterSpacing !== "normal" && Math.abs(ls) > 0.01) spec.letterSpacing = r1(ls * 100) / 100;
    const cases: Record<string, string> = { uppercase: "upper", lowercase: "lower", capitalize: "title" };
    if (cases[s.transform]) spec.case = cases[s.transform];
    const deco = decorationOf(s.decoration);
    if (deco) spec.decoration = deco;
    const align = /center/.test(n.css.textAlign ?? "") ? "center" : /right|end/.test(n.css.textAlign ?? "") ? "right" : n.css.textAlign === "justify" ? "justify" : "";
    if (align) spec.align = align;

    if (runs.length === 1 && !base.href) spec.text = base.text;
    else {
      spec.spans = runs.map((r) => {
        const span: Spec = { text: r.text };
        const f = this.font(r);
        if (f !== spec.font) span.font = f;
        if (r.style.size !== s.size) span.size = r.style.size;
        if (r.style.color !== s.color) span.color = r.style.color;
        const d = decorationOf(r.style.decoration);
        if (r.href) {
          span.link = r.href;
          span.decoration = d ?? "none";
        } else if (d !== deco) span.decoration = d ?? "none";
        if (r.style.transform !== s.transform) span.case = cases[r.style.transform] ?? "none";
        return span;
      });
    }
    // One line that sizes itself (flex item, nowrap) hugs; block text wraps at its container's width.
    if (!n.autoWidth || (n.lines ?? 1) > 1) spec.w = n.box.w;
    return spec;
  }

  // ─── Layout inference ─────────────────────────────────────────────────────

  private layout(n: RawNode, flow: RawNode[]): Layout | null {
    const c = n.css;
    const display = c.display ?? "block";
    const cssPad = padOf(n);
    if (/grid/.test(display)) {
      const g = gridLayout(n, flow, cssPad);
      if (g) return g;
    }
    if (/flex/.test(display)) {
      const dir: Dir = /column/.test(c.flexDirection ?? "") ? "column" : "row";
      const wrap = /wrap/.test(c.flexWrap ?? "") && c.flexWrap !== "nowrap";
      if (wrap && dir === "row") return wrapLayout(n, flow, cssPad, px(c.columnGap), px(c.rowGap), justifyOf(c.justifyContent)) ?? geometric(n, flow, cssPad);
      return lineLayout(n, flow, dir, flexCandidate(n, flow, dir, cssPad)) ?? geometric(n, flow, cssPad);
    }
    return geometric(n, flow, cssPad);
  }
}

// ─── Layout helpers (pure) ───────────────────────────────────────────────────

interface Item {
  node?: RawNode;
  spacer?: number;
  fillMain?: boolean;
  fillCross?: boolean;
  wrap?: Align;
  colSpan?: number;
  rowSpan?: number;
}

interface Layout {
  dir: Dir | "grid";
  props: Spec;
  items: Item[];
  fixedW?: boolean;
  fixedH?: boolean;
}

interface LineCfg {
  pad: number[]; // t r b l
  gap: number;
  justify: Align | "between";
  align: Align;
  items: Item[];
}

function inside(a: Box, b: Box) {
  return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;
}
function sameBox(a: Box, b: Box) {
  return near(a.x, b.x, 1) && near(a.y, b.y, 1) && near(a.w, b.w, 1) && near(a.h, b.h, 1);
}
function label(n: RawNode) {
  return n.name || TAG_NAMES[n.tag] || n.tag;
}
function decorationOf(v: string): string | undefined {
  return /underline/.test(v) ? "underline" : /line-through/.test(v) ? "strike" : undefined;
}
function paintOrder(list: RawNode[]): RawNode[] {
  const z = (n: RawNode) => (n.css.zIndex && n.css.zIndex !== "auto" ? Number(n.css.zIndex) || 0 : 0);
  return list.map((n, i) => ({ n, i })).sort((a, b) => z(a.n) - z(b.n) || a.i - b.i).map((x) => x.n);
}
function padOf(n: RawNode): number[] {
  const b = borderWidths(n.css);
  return [px(n.css.paddingTop) + b[0]!, px(n.css.paddingRight) + b[1]!, px(n.css.paddingBottom) + b[2]!, px(n.css.paddingLeft) + b[3]!];
}
function justifyOf(v: string | undefined): Align | "between" | null {
  if (!v || /normal|flex-start|^start|left/.test(v)) return "start";
  if (/center/.test(v)) return "center";
  if (/flex-end|^end|right/.test(v)) return "end";
  if (/space-between/.test(v)) return "between";
  return null;
}
function alignOf(v: string | undefined): Align | "stretch" | null {
  if (!v || /normal|stretch/.test(v)) return "stretch";
  if (/center/.test(v)) return "center";
  if (/flex-end|^end|self-end/.test(v)) return "end";
  if (/flex-start|^start|self-start|baseline/.test(v)) return "start";
  return null;
}
/** Boxes and wrapping text may stretch with their parent; pictures keep their size. */
const canFill = (n: RawNode) => n.kind === "box" || (n.kind === "text" && !n.autoWidth);

const mainOf = (b: Box, dir: Dir) => (dir === "row" ? { s: b.x, z: b.w } : { s: b.y, z: b.h });
const crossOf = (b: Box, dir: Dir) => (dir === "row" ? { s: b.y, z: b.h } : { s: b.x, z: b.w });
/** [mainStart, mainEnd, crossStart, crossEnd] padding for a direction. */
const pads = (p: number[], dir: Dir) => (dir === "row" ? [p[3]!, p[1]!, p[0]!, p[2]!] : [p[0]!, p[2]!, p[3]!, p[1]!]);

/** Positions Figma's auto-layout would give, checked against the page. */
function fits(n: RawNode, dir: Dir, cfg: LineCfg): boolean {
  const [ms, me, cs, ce] = pads(cfg.pad, dir);
  const box = n.box;
  const innerMain = mainOf(box, dir).z - ms! - me!;
  const innerCross = crossOf(box, dir).z - cs! - ce!;
  if (innerMain < -TOL || innerCross < -TOL) return false;
  const seq = cfg.items;
  const fills = seq.filter((i) => i.fillMain).length;
  const size = (i: Item) => (i.spacer !== undefined ? i.spacer : mainOf(i.node!.box, dir).z);
  const fixed = seq.filter((i) => !i.fillMain).reduce((a, i) => a + size(i), 0);
  const gaps = cfg.gap * Math.max(0, seq.length - 1);
  const fillSize = fills ? (innerMain - fixed - gaps) / fills : 0;
  const total = fixed + fills * fillSize + gaps;
  let cursor = ms!;
  let gap = cfg.gap;
  if (!fills) {
    if (cfg.justify === "center") cursor += (innerMain - total) / 2;
    else if (cfg.justify === "end") cursor += innerMain - total;
    else if (cfg.justify === "between" && seq.length > 1) gap = (innerMain - fixed) / (seq.length - 1);
  }
  for (const it of seq) {
    const z = it.fillMain ? fillSize : size(it);
    if (it.node) {
      const m = mainOf(it.node.box, dir);
      const c = crossOf(it.node.box, dir);
      if (!near(m.s - mainOf(box, dir).s, cursor) || (it.fillMain && !near(m.z, z))) return false;
      const align = it.wrap ?? cfg.align;
      const crossPos = it.fillCross ? cs! : align === "center" ? cs! + (innerCross - c.z) / 2 : align === "end" ? cs! + innerCross - c.z : cs!;
      if (!near(c.s - crossOf(box, dir).s, crossPos) || (it.fillCross && !near(c.z, innerCross))) return false;
    }
    cursor += z + gap;
  }
  return true;
}

function sortMain(flow: RawNode[], dir: Dir) {
  return flow.slice().sort((a, b) => mainOf(a.box, dir).s - mainOf(b.box, dir).s);
}

/** Flex container read from its CSS: padding, gap, justify-content and align-items. */
function flexCandidate(n: RawNode, flow: RawNode[], dir: Dir, cssPad: number[]): LineCfg | null {
  const justify = justifyOf(n.css.justifyContent);
  const align = alignOf(n.css.alignItems);
  if (!justify || !align) return null;
  const [, , cs, ce] = pads(cssPad, dir);
  const innerCross = crossOf(n.box, dir).z - cs! - ce!;
  const items: Item[] = sortMain(flow, dir).map((k) => {
    const self = k.css.alignSelf && k.css.alignSelf !== "auto" ? alignOf(k.css.alignSelf) : align;
    const it: Item = { node: k };
    if (Number(k.css.flexGrow) > 0 && canFill(k)) it.fillMain = true;
    if (self === "stretch" && canFill(k) && near(crossOf(k.box, dir).z, innerCross)) it.fillCross = true;
    else if (self && self !== "stretch" && self !== (align === "stretch" ? "start" : align)) it.wrap = self;
    return it;
  });
  return { pad: cssPad, gap: px(dir === "row" ? n.css.columnGap : n.css.rowGap), justify, align: align === "stretch" ? "start" : align, items };
}

function lineLayout(n: RawNode, _flow: RawNode[], dir: Dir, cfg: LineCfg | null): Layout | null {
  if (!cfg || !fits(n, dir, cfg)) return null;
  return toLayout(n, dir, cfg);
}

function toLayout(n: RawNode, dir: Dir, cfg: LineCfg): Layout {
  const props: Spec = { layout: dir };
  const p = cfg.pad.map(r1);
  if (p.some((v) => v)) props.padding = p[0] === p[2] && p[1] === p[3] ? (p[0] === p[1] ? p[0] : [p[0], p[1]]) : p;
  if (cfg.gap) props.gap = r1(cfg.gap);
  if (cfg.justify !== "start") props.justify = cfg.justify;
  if (cfg.align !== "start") props.align = cfg.align;
  // Hugging works only when the content plus padding is exactly the box.
  const hasFillMain = cfg.items.some((i) => i.fillMain);
  const [ms, me, cs, ce] = pads(cfg.pad, dir);
  const content = cfg.items.reduce((a, i) => a + (i.spacer ?? mainOf(i.node!.box, dir).z), 0) + cfg.gap * Math.max(0, cfg.items.length - 1);
  const crossMax = Math.max(0, ...cfg.items.filter((i) => i.node).map((i) => crossOf(i.node!.box, dir).z));
  const fixedMain = hasFillMain || cfg.justify !== "start" || !near(mainOf(n.box, dir).z, ms! + me! + content);
  const fixedCross = cfg.align !== "start" || cfg.items.some((i) => i.fillCross || i.wrap) || !near(crossOf(n.box, dir).z, cs! + ce! + crossMax);
  return { dir, props, items: cfg.items, fixedW: dir === "row" ? fixedMain : fixedCross, fixedH: dir === "row" ? fixedCross : fixedMain };
}

/** Rows or columns read from the boxes: tries the CSS padding, then padding taken from the children. */
function geometric(n: RawNode, flow: RawNode[], cssPad: number[]): Layout | null {
  const dir = direction(flow);
  if (!dir) return multiLine(n, flow, cssPad);
  const sorted = sortMain(flow, dir);
  const box = n.box;
  const first = mainOf(sorted[0]!.box, dir);
  const last = mainOf(sorted[sorted.length - 1]!.box, dir);
  const geoMain = [first.s - mainOf(box, dir).s, mainOf(box, dir).s + mainOf(box, dir).z - (last.s + last.z)];
  const crossStarts = sorted.map((k) => crossOf(k.box, dir).s - crossOf(box, dir).s);
  const crossEnds = sorted.map((k) => crossOf(box, dir).s + crossOf(box, dir).z - crossOf(k.box, dir).s - crossOf(k.box, dir).z);
  const geoCross = [Math.min(...crossStarts), Math.min(...crossEnds)];
  const [, , cs, ce] = pads(cssPad, dir);
  const toPad = (m: number[], c: number[]) => (dir === "row" ? [c[0]!, m[1]!, c[1]!, m[0]!] : [m[0]!, c[1]!, m[1]!, c[0]!]);
  const candidates = [toPad(geoMain, [cs!, ce!]), toPad(geoMain, geoCross)];
  if (geoMain.some((v) => v < -TOL) || geoCross.some((v) => v < -TOL)) return null;
  for (const pad of candidates) {
    const cfg = spaced(n, sorted, dir, pad);
    if (cfg && fits(n, dir, cfg)) return toLayout(n, dir, cfg);
  }
  return null;
}

/** Same gap everywhere, or the smallest gap plus spacers; per-child alignment with wrappers. */
function spaced(n: RawNode, sorted: RawNode[], dir: Dir, pad: number[]): LineCfg | null {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = mainOf(sorted[i - 1]!.box, dir);
    gaps.push(mainOf(sorted[i]!.box, dir).s - (a.s + a.z));
  }
  if (gaps.some((g) => g < -TOL)) return null;
  // A spacer between two items adds its size plus one more gap.
  let gap = 0;
  const spacers: (number | null)[] = gaps.map(() => null);
  if (gaps.length) {
    const min = Math.max(0, Math.min(...gaps));
    if (gaps.every((g) => near(g, gaps[0]!, 0.6))) gap = gaps[0]!;
    else {
      gap = gaps.some((g) => g > min + TOL && g < 2 * min - 0.1) ? 0 : min;
      gaps.forEach((g, i) => (spacers[i] = g > gap + TOL ? Math.max(0, g - 2 * gap) : null));
    }
  }
  const [, , cs, ce] = pads(pad, dir);
  const innerCross = crossOf(n.box, dir).z - cs! - ce!;
  const aligns: (Align | "fill")[] = [];
  for (const k of sorted) {
    const c = crossOf(k.box, dir);
    const rel = c.s - crossOf(n.box, dir).s - cs!;
    const space = innerCross - c.z;
    if (canFill(k) && near(c.z, innerCross) && near(rel, 0)) aligns.push("fill");
    else if (near(rel, 0)) aligns.push("start");
    else if (near(rel, space / 2)) aligns.push("center");
    else if (near(rel, space)) aligns.push("end");
    else return null;
  }
  const counts: Record<string, number> = {};
  for (const a of aligns) if (a !== "fill") counts[a] = (counts[a] ?? 0) + 1;
  const align = ((Object.keys(counts) as Align[]).sort((a, b) => counts[b]! - counts[a]!)[0] ?? "start") as Align;
  const items: Item[] = [];
  sorted.forEach((k, i) => {
    const spacer = i > 0 ? spacers[i - 1] : null;
    if (spacer !== null && spacer !== undefined) items.push({ spacer });
    const a = aligns[i]!;
    items.push({ node: k, fillCross: a === "fill", wrap: a !== "fill" && a !== align ? a : undefined });
  });
  return { pad, gap, justify: "start", align, items };
}

/** Stacked top to bottom → column; side by side on one line → row. */
function direction(flow: RawNode[]): Dir | null {
  if (flow.length === 1) return "column";
  const byY = flow.slice().sort((a, b) => a.box.y - b.box.y);
  if (byY.every((k, i) => i === 0 || k.box.y >= byY[i - 1]!.box.y + byY[i - 1]!.box.h - TOL)) return "column";
  const byX = flow.slice().sort((a, b) => a.box.x - b.box.x);
  const overlapY = byX.every((k) => k.box.y < byX[0]!.box.y + byX[0]!.box.h && byX[0]!.box.y < k.box.y + k.box.h);
  if (overlapY && byX.every((k, i) => i === 0 || k.box.x >= byX[i - 1]!.box.x + byX[i - 1]!.box.w - TOL)) return "row";
  return null;
}

/** Items on several lines (inline-blocks, tags): a wrapping row. */
function multiLine(n: RawNode, flow: RawNode[], cssPad: number[]): Layout | null {
  const lines = toLines(flow);
  if (lines.length < 2) return null;
  const hg = lines[0]!.length > 1 ? lines[0]![1]!.box.x - (lines[0]![0]!.box.x + lines[0]![0]!.box.w) : 0;
  const top = (l: RawNode[]) => Math.min(...l.map((k) => k.box.y));
  const bottom = (l: RawNode[]) => Math.max(...l.map((k) => k.box.y + k.box.h));
  const vg = top(lines[1]!) - bottom(lines[0]!);
  return wrapLayout(n, flow, cssPad, hg, vg, "start");
}

function toLines(flow: RawNode[]): RawNode[][] {
  const lines: RawNode[][] = [];
  for (const k of flow.slice().sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const line = lines.find((l) => l.some((o) => k.box.y < o.box.y + o.box.h - TOL && o.box.y < k.box.y + k.box.h - TOL));
    if (line) line.push(k);
    else lines.push([k]);
  }
  for (const l of lines) l.sort((a, b) => a.box.x - b.box.x);
  return lines.sort((a, b) => a[0]!.box.y - b[0]!.box.y);
}

function wrapLayout(n: RawNode, flow: RawNode[], cssPad: number[], gap: number, rowGap: number, justify: Align | "between" | null): Layout | null {
  if (!justify) return null;
  const lines = toLines(flow);
  const inner = n.box.w - cssPad[1]! - cssPad[3]!;
  let y = n.box.y + cssPad[0]!;
  const ordered: RawNode[] = [];
  for (const line of lines) {
    // Figma breaks a line when the next item doesn't fit: check the page broke at the same place.
    const width = line.reduce((a, k) => a + k.box.w, 0) + gap * (line.length - 1);
    if (width > inner + TOL) return null;
    const next = lines[lines.indexOf(line) + 1];
    if (next && width + gap + next[0]!.box.w <= inner - TOL) return null;
    const lineH = Math.max(...line.map((k) => k.box.h));
    let x = n.box.x + cssPad[3]!;
    let g = gap;
    if (justify === "center") x += (inner - width) / 2;
    else if (justify === "end") x += inner - width;
    else if (justify === "between" && line.length > 1) g = (inner - width + gap * (line.length - 1)) / (line.length - 1);
    for (const k of line) {
      if (!near(k.box.x, x) || !near(k.box.y, y)) return null;
      x += k.box.w + g;
      ordered.push(k);
    }
    y += lineH + rowGap;
  }
  const props: Spec = { layout: "row", wrap: true };
  const p = cssPad.map(r1);
  if (p.some((v) => v)) props.padding = p;
  if (gap) props.gap = r1(gap);
  if (rowGap) props.rowGap = r1(rowGap);
  if (justify !== "start") props.justify = justify;
  return { dir: "row", props, items: ordered.map((node) => ({ node })), fixedW: true, fixedH: false };
}

/** CSS grid with explicit tracks: Figma's grid auto-layout, items placed in row order. */
function gridLayout(n: RawNode, flow: RawNode[], cssPad: number[]): Layout | null {
  const tracks = (v: string | undefined) =>
    (v ?? "")
      .replace(/\[[^\]]*\]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => (/^[\d.]+px$/.test(t) ? parseFloat(t) : NaN));
  const cols = tracks(n.css.gridTemplateColumns);
  let rows = tracks(n.css.gridTemplateRows);
  if (!cols.length || cols.some(isNaN)) return null;
  if (rows.some(isNaN)) rows = [];
  const cg = px(n.css.columnGap);
  const rg = px(n.css.rowGap);
  const starts = (list: number[], origin: number, gap: number) => list.map((_, i) => origin + list.slice(0, i).reduce((a, v) => a + v + gap, 0));
  const colStart = starts(cols, n.box.x + cssPad[3]!, cg);
  const rowStart = rows.length ? starts(rows, n.box.y + cssPad[0]!, rg) : [];
  const span = (s: number, end: number, origin: number[], list: number[]) => {
    const i = origin.findIndex((o) => near(o, s));
    if (i < 0) return null;
    let j = i;
    while (j + 1 < origin.length && origin[j + 1]! < end - TOL) j++;
    return { i, n: j - i + 1, size: origin[j]! + list[j]! - origin[i]! };
  };
  const placed: { node: RawNode; c: number; r: number; cs: number; rs: number; fillW: boolean; fillH: boolean }[] = [];
  for (const k of flow) {
    const c = span(k.box.x, k.box.x + k.box.w, colStart, cols);
    const r = rows.length ? span(k.box.y, k.box.y + k.box.h, rowStart, rows) : { i: 0, n: 1, size: k.box.h };
    if (!c || !r) return null;
    placed.push({ node: k, c: c.i, r: r.i, cs: c.n, rs: r.n, fillW: canFill(k) && near(k.box.w, c.size), fillH: rows.length > 0 && k.kind === "box" && near(k.box.h, r.size) });
  }
  if (!rows.length) {
    // Rows were not resolved to pixels: number them from the boxes.
    const tops = [...new Set(placed.map((p) => Math.round(p.node.box.y)))].sort((a, b) => a - b);
    for (const p of placed) p.r = tops.findIndex((t) => near(t, p.node.box.y));
  }
  placed.sort((a, b) => a.r - b.r || a.c - b.c);
  // Figma places items one after the other: the page must not leave holes or reorder them.
  const taken = new Set<string>();
  let cursor = 0;
  for (const p of placed) {
    let pos = cursor;
    for (;;) {
      const r = Math.floor(pos / cols.length);
      const c = pos % cols.length;
      let free = c + p.cs <= cols.length;
      for (let dr = 0; free && dr < p.rs; dr++) for (let dc = 0; free && dc < p.cs; dc++) if (taken.has(`${r + dr}:${c + dc}`)) free = false;
      if (free) break;
      pos++;
    }
    if (Math.floor(pos / cols.length) !== p.r || pos % cols.length !== p.c) return null;
    for (let dr = 0; dr < p.rs; dr++) for (let dc = 0; dc < p.cs; dc++) taken.add(`${p.r + dr}:${p.c + dc}`);
    cursor = pos + p.cs;
  }
  const equal = cols.every((v) => near(v, cols[0]!, 0.5));
  const rowCount = Math.max(rows.length, ...placed.map((p) => p.r + p.rs));
  const props: Spec = { layout: "grid", columns: equal ? cols.map(() => "1fr") : cols.map(r1), rows: rows.length ? rows.map(r1) : rowCount };
  const p = cssPad.map(r1);
  if (p.some((v) => v)) props.padding = p;
  if (cg) props.columnGap = r1(cg);
  if (rg) props.rowGap = r1(rg);
  return {
    dir: "grid",
    props,
    items: placed.map((x) => ({ node: x.node, fillMain: x.fillW, fillCross: x.fillH, colSpan: x.cs, rowSpan: x.rs })),
    fixedW: true,
    fixedH: rows.length > 0,
  };
}

export function convert(snap: Snapshot, opts: ConvertOptions): ConvertResult {
  const conv = new Converter(opts);
  for (const w of snap.warnings) conv.warn(w);
  const root = conv.prune(snap.root) ?? snap.root;
  root.box = { ...snap.root.box };
  const spec = conv.node(root) ?? {};
  spec.name = opts.name ?? `${snap.title || new URL(snap.url).hostname || "Page"} · ${Math.round(snap.width)}`;
  spec.w = snap.root.box.w;
  spec.h = snap.root.box.h;
  spec.clip = true;
  delete spec.x;
  delete spec.y;
  if (conv.truncated) conv.warn(`Stopped after ${opts.maxNodes} layers: import a smaller part of the page with selector, or lower maxHeight.`);
  if (conv.stats.free) conv.warn(`${conv.stats.free} container(s) kept free positioning: their children could not be reproduced with auto-layout.`);
  return { spec, assets: conv.assets, substitutions: conv.substitutions, warnings: [...conv.warnings], stats: conv.stats, truncated: conv.truncated };
}

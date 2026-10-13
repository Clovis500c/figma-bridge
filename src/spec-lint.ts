// Checks a build spec before it reaches the plugin. Agents write CSS and React Native habits (borderRadius,
// backgroundColor, "16px", "100%", justify:"space-between"), and the plugin ignores what it doesn't know, so a
// mistake would only show up in a screenshot. Unambiguous equivalents are converted in place; everything else
// becomes a warning with the right property name.

/** Every node property build reads, across Figma, FigJam, Slides and diagrams. */
const KNOWN = new Set([
  "type", "name", "key", "children", "layout", "direction", "gap", "padding", "align", "justify", "wrap", "rowGap", "columnGap",
  "clip", "columns", "rows", "span", "colSpan", "rowSpan", "cellAlign", "cellValign", "gridSize", "w", "h", "width", "height",
  "size", "grow", "absolute", "x", "y", "text", "spans", "font", "weight", "color", "lineHeight", "letterSpacing", "valign",
  "case", "decoration", "maxLines", "textStyle", "fill", "stroke", "strokeWidth", "strokeAlign", "strokeDash", "radius",
  "opacity", "shadow", "blur", "backgroundBlur", "rotation", "visible", "locked", "icon", "src", "imageKey", "fit", "svg",
  "component", "props", "properties", "base", "variants", "variantOf", "bind", "reactions", "modes", "slides",
  // FigJam
  "wide", "author", "shape", "from", "to", "label", "line", "dashed", "startArrow", "endArrow", "fromMagnet", "toMagnet",
  "header", "headerFill", "code", "language",
  // diagram
  "source", "mermaid", "as",
]);

const SPAN_KEYS = new Set(["text", "font", "weight", "size", "color", "fill", "decoration", "case", "link"]);
const SHADOW_KEYS = new Set(["x", "y", "blur", "spread", "color", "inner"]);
const PAINT_KEYS = new Set(["gradient", "angle", "type", "image", "imageKey", "fit", "opacity"]);

type Fix = (s: Record<string, any>, value: any, ctx: NodeCtx) => string | void;
interface NodeCtx {
  isText: boolean;
}

/** Same key, same meaning: the value moves to the build name (unless that one is set too). */
function rename(to: string, only?: (ctx: NodeCtx) => boolean, convert?: (v: any) => any): Fix {
  return (s, value, ctx) => {
    if (only && !only(ctx)) return `use ${to} (only on text layers)`;
    if (s[to] === undefined) s[to] = convert ? convert(value) : value;
    return `read as ${to}`;
  };
}
const hint = (text: string): Fix => () => text;
const onText = (ctx: NodeCtx) => ctx.isText;

const ALIASES: Record<string, Fix> = {
  backgroundColor: rename("fill"),
  background: rename("fill"),
  bg: rename("fill"),
  backgroundImage: hint('use fill:{image:"https://…"|path}'),
  fills: hint('use fill: "#hex", "style:Name", "var:name", {gradient:[…]} or an array of those'),
  borderRadius: rename("radius"),
  cornerRadius: rename("radius"),
  rounded: rename("radius"),
  borderColor: rename("stroke"),
  strokes: hint('use stroke: "#hex" (+ strokeWidth)'),
  border: hint('use stroke:"#hex" + strokeWidth (+ strokeAlign, strokeDash)'),
  borderWidth: rename("strokeWidth"),
  strokeWeight: rename("strokeWidth"),
  fontSize: rename("size", onText),
  fontWeight: rename("weight"),
  fontFamily: rename("font"),
  fontName: hint('use font:"Inter" and weight, or font:"Inter:Bold"'),
  fontStyle: hint('use weight (400|500|600|700 or a style name like "Italic")'),
  textColor: rename("color"),
  colour: rename("color"),
  textAlign: rename("align", onText),
  textAlignVertical: rename("valign", onText),
  textTransform: rename("case"),
  textDecoration: rename("decoration"),
  textStyleId: rename("textStyle"),
  lineClamp: rename("maxLines"),
  numberOfLines: rename("maxLines"),
  content: rename("text"),
  characters: rename("text"),
  value: rename("text"),
  flexDirection: rename("layout"),
  layoutMode: rename("layout", undefined, (v) => String(v).toLowerCase().replace("horizontal", "row").replace("vertical", "column")),
  display: hint('use layout:"row"|"column"|"grid" (omit it for free positioning)'),
  justifyContent: rename("justify"),
  primaryAxisAlignItems: rename("justify"),
  alignItems: rename("align"),
  counterAxisAlignItems: rename("align"),
  alignSelf: hint('use w:"fill" or h:"fill" to stretch inside an auto-layout parent'),
  flexWrap: rename("wrap", undefined, (v) => v !== "nowrap" && v !== false),
  layoutWrap: rename("wrap", undefined, (v) => v === true || String(v).toUpperCase() === "WRAP"),
  spacing: rename("gap"),
  itemSpacing: rename("gap"),
  rowSpacing: rename("rowGap"),
  counterAxisSpacing: rename("rowGap"),
  flexGrow: rename("grow", undefined, Boolean),
  flex: rename("grow", undefined, Boolean),
  layoutGrow: rename("grow", undefined, Boolean),
  margin: hint("build has no margin: use gap or padding on the parent"),
  overflow: rename("clip", undefined, (v) => v === "hidden" || v === true),
  clipsContent: rename("clip", undefined, Boolean),
  boxShadow: hint('use shadow: true | {x,y,blur,spread,color} | "style:Name"'),
  dropShadow: rename("shadow"),
  elevation: hint("use shadow: true | {x,y,blur,spread,color}"),
  effects: hint('use shadow, blur or backgroundBlur (or "style:Name" in shadow)'),
  hidden: rename("visible", undefined, (v) => !v),
  rotate: rename("rotation"),
  image: rename("src"),
  url: rename("src"),
  uri: rename("src"),
  iconName: rename("icon"),
  position: hint("use absolute:true with x/y inside auto-layout, or x/y in a frame without layout"),
  left: rename("x"),
  top: rename("y"),
  minWidth: hint("min/max sizes aren't supported by build: use w, or run_script (node.minWidth)"),
  maxWidth: hint("min/max sizes aren't supported by build: use w, or run_script (node.maxWidth)"),
  minHeight: hint("min/max sizes aren't supported by build: use h, or run_script (node.minHeight)"),
  maxHeight: hint("min/max sizes aren't supported by build: use h, or run_script (node.maxHeight)"),
  gridTemplateColumns: rename("columns"),
  gridTemplateRows: rename("rows"),
  gridColumn: hint("use colSpan (or span:[rows, cols])"),
  gridRow: hint("use rowSpan (or span:[rows, cols])"),
  variant: hint('use props:{Variant:"…"} on an instance, or variants:[…] on a componentSet'),
  overrides: hint('use text:{"Layer name":"…"} on an instance'),
};
for (const side of ["Top", "Right", "Bottom", "Left", "Horizontal", "Vertical", "X", "Y"]) {
  ALIASES["padding" + side] = hint("use padding: n | [vertical, horizontal] | [top, right, bottom, left]");
}

const ENUMS: Record<string, { ok: string[]; map?: Record<string, string>; note?: Record<string, string> }> = {
  layout: {
    ok: ["row", "column", "grid", "horizontal", "vertical", "col", "none", ""],
    map: { flex: "row", "flex-row": "row", hstack: "row", "flex-col": "column", "flex-column": "column", vstack: "column", stack: "column" },
  },
  justify: {
    ok: ["start", "center", "end", "between"],
    map: { "space-between": "between", spacebetween: "between", "flex-start": "start", "flex-end": "end", left: "start", right: "end", top: "start", bottom: "end", middle: "center", min: "start", max: "end" },
    note: { "space-around": 'not supported: use "between" or gap', "space-evenly": 'not supported: use "between" or gap' },
  },
  alignFrame: {
    ok: ["start", "center", "end", "baseline"],
    map: { "flex-start": "start", "flex-end": "end", middle: "center", top: "start", bottom: "end", left: "start", right: "end", min: "start", max: "end" },
    note: { stretch: 'not an align value: give the children w:"fill" (column) or h:"fill" (row)' },
  },
  alignText: { ok: ["left", "center", "right", "justify"], map: { start: "left", end: "right", justified: "justify", middle: "center" } },
  valign: { ok: ["top", "center", "bottom"], map: { middle: "center", start: "top", end: "bottom" } },
  case: { ok: ["upper", "lower", "title", "none"], map: { uppercase: "upper", lowercase: "lower", capitalize: "title" } },
  decoration: { ok: ["underline", "strike", "strikethrough", "none"], map: { "line-through": "strike" } },
  fit: { ok: ["fill", "fit", "crop", "tile"], map: { cover: "fill", contain: "fit", repeat: "tile" } },
  cellAlign: { ok: ["start", "center", "end"], map: { left: "start", right: "end", middle: "center" } },
  cellValign: { ok: ["start", "center", "end"], map: { top: "start", bottom: "end", middle: "center" } },
};

const NAMED_COLORS: Record<string, string> = { white: "#FFFFFF", black: "#000000", transparent: "#00000000" };
const PX = /^\s*(-?\d+(?:\.\d+)?)\s*(?:px)?\s*$/i;

/** Rough edit distance, to suggest "padding" for "paddng". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

function closest(key: string, known: Set<string>): string | null {
  let best: string | null = null;
  let bestD = key.length > 5 ? 3 : 2;
  for (const k of known) {
    const d = distance(key, k);
    if (d < bestD) [best, bestD] = [k, d];
  }
  return best;
}

function isText(s: Record<string, any>): boolean {
  if (s.type) return /^text$/i.test(String(s.type));
  if (Array.isArray(s.variants) || s.component || s.svg || s.icon) return false;
  return (s.text !== undefined && typeof s.text !== "object") || Array.isArray(s.spans);
}

function nodeKind(s: Record<string, any>): string {
  if (s.type) return String(s.type).toLowerCase().replace(/[_\s-]/g, "");
  if (Array.isArray(s.variants)) return "componentset";
  if (isText(s)) return "text";
  if (s.svg) return "svg";
  if (s.icon) return "icon";
  if (s.src || s.imageKey) return "image";
  if (s.component) return "instance";
  return "frame";
}

export interface LintResult {
  warnings: string[];
}

export function lintSpec(spec: unknown): LintResult {
  // Same message on many layers: reported once, with a count and the first path.
  const seen = new Map<string, { path: string; n: number }>();
  const report = (path: string, message: string) => {
    const hit = seen.get(message);
    if (hit) hit.n++;
    else seen.set(message, { path, n: 1 });
  };

  const color = (owner: Record<string, any>, field: string | number, path: string, label = String(field)) => {
    const v = owner[field];
    if (typeof v !== "string") return;
    const t = v.trim();
    if (/^(style|var):/.test(t) || /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) return;
    const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+(\d*(?:\.\d+)?%?))?\s*\)$/i.exec(t);
    if (rgb) {
      const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0").toUpperCase();
      let alpha = "";
      if (rgb[4]) {
        const a = rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
        if (a < 1) alpha = hex(a * 255);
      }
      owner[field] = "#" + hex(+rgb[1]!) + hex(+rgb[2]!) + hex(+rgb[3]!) + alpha;
      return report(path, `${label}: rgb() converted to hex (colors are "#RRGGBB[AA]", "style:Name" or "var:name")`);
    }
    const named = NAMED_COLORS[t.toLowerCase()];
    if (named) {
      owner[field] = named;
      return report(path, `${label}: "${t}" converted to ${named}`);
    }
    report(path, `${label}: "${v}" is not a color: use "#RRGGBB[AA]", "style:Name" or "var:name"`);
  };

  const paint = (owner: Record<string, any>, field: string | number, path: string, label = String(field)) => {
    const v = owner[field];
    if (Array.isArray(v)) return v.forEach((_, i) => paint(v, i, path, label));
    if (typeof v === "string") return color(owner, field, path, label);
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) if (!PAINT_KEYS.has(k)) report(path, `${label}: unknown paint property "${k}" (paints: "#hex", {gradient:[…], angle, type:"radial"}, {image, fit})`);
      if (Array.isArray(v.gradient)) v.gradient.forEach((stop: any, i: number) => (typeof stop === "string" ? color(v.gradient, i, path, label) : stop && color(stop, "color", path, label)));
    }
  };

  const number = (owner: Record<string, any>, field: string | number, path: string, label = String(field)) => {
    const v = owner[field];
    if (typeof v !== "string" || /^var:/.test(v)) return;
    const m = PX.exec(v);
    if (m) {
      owner[field] = Number(m[1]);
      report(path, `${label}: "${v}" read as ${owner[field]} (numbers are px, without units)`);
    }
  };

  const enumValue = (s: Record<string, any>, field: string, table: keyof typeof ENUMS, path: string) => {
    const v = s[field];
    if (typeof v !== "string") return;
    const e = ENUMS[table]!;
    const low = v.toLowerCase();
    if (e.ok.includes(low)) {
      if (low !== v) s[field] = low;
      return;
    }
    const mapped = e.map?.[low] ?? e.map?.[low.replace(/[\s_]/g, "")];
    if (mapped) {
      s[field] = mapped;
      return report(path, `${field}: "${v}" read as "${mapped}"`);
    }
    report(path, `${field}: "${v}" ${e.note?.[low] ?? `is not valid (${e.ok.filter(Boolean).join(" | ")})`}, ignored`);
  };

  const size = (s: Record<string, any>, field: string, path: string) => {
    const v = s[field];
    if (typeof v !== "string" || v === "fill" || v === "hug") return;
    const low = v.trim().toLowerCase();
    const to = ["100%", "full", "stretch", "match_parent", "fill-parent", "fill_container", "auto-fill"].includes(low)
      ? "fill"
      : ["auto", "fit-content", "wrap_content", "hug-contents", "hug_contents", "fit"].includes(low)
        ? "hug"
        : null;
    if (to) {
      s[field] = to;
      return report(path, `${field}: "${v}" read as "${to}"`);
    }
    if (PX.test(v)) return number(s, field, path);
    report(path, `${field}: "${v}" is not a size: use a number (px), "fill" or "hug"`);
  };

  const walk = (s: unknown, path: string, inVariants = false) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) return;
    const node = s as Record<string, any>;
    // Aliases first: content → text changes what kind of node this is.
    for (const k of Object.keys(node)) {
      if (KNOWN.has(k)) continue;
      const ctx = { isText: isText(node) || ["content", "characters", "value"].some((a) => typeof node[a] === "string") };
      const fix = ALIASES[k];
      if (fix) {
        const note = fix(node, node[k], ctx);
        if (/^read as /.test(note ?? "")) delete node[k];
        report(path, `"${k}": ${note} (not a build property)`);
        continue;
      }
      const near = closest(k, KNOWN);
      report(path, `unknown property "${k}" ignored${near ? `: did you mean ${near}?` : ""}`);
    }

    const kind = nodeKind(node);
    const text = kind === "text";
    enumValue(node, "layout", "layout", path);
    enumValue(node, "justify", "justify", path);
    enumValue(node, "align", text ? "alignText" : "alignFrame", path);
    for (const f of ["valign", "case", "decoration", "fit", "cellAlign", "cellValign"] as const) enumValue(node, f, f, path);
    if (typeof node.strokeAlign === "string" && !/^(inside|center|outside)$/i.test(node.strokeAlign)) report(path, `strokeAlign: "${node.strokeAlign}" is not valid (inside | center | outside)`);
    if (typeof node.wrap === "string") node.wrap = node.wrap !== "nowrap";

    for (const f of ["w", "h", "width", "height"]) size(node, f, path);
    for (const f of ["gap", "rowGap", "columnGap", "radius", "strokeWidth", "x", "y", "rotation", "blur", "backgroundBlur", "letterSpacing", "lineHeight"]) {
      if (f === "gap" && node.gap === "auto") continue;
      if ((f === "letterSpacing" || f === "lineHeight") && /%$/.test(String(node[f]))) continue;
      number(node, f, path);
    }
    number(node, "size", path);
    for (const f of ["padding", "radius", "strokeWidth"]) if (Array.isArray(node[f])) node[f].forEach((_: unknown, i: number) => number(node[f], i, path, f));

    // Stickies and diagrams take color names (yellow, blue…).
    const namedColors = kind === "sticky" || kind === "diagram";
    for (const f of ["fill", "stroke"]) if (!namedColors) paint(node, f, path);
    if (typeof node.color === "string" && !namedColors) color(node, "color", path);
    const shadows = Array.isArray(node.shadow) ? node.shadow : node.shadow && typeof node.shadow === "object" ? [node.shadow] : [];
    for (const sh of shadows) {
      if (!sh || typeof sh !== "object") continue;
      for (const k of Object.keys(sh)) if (!SHADOW_KEYS.has(k)) report(path, `shadow: unknown property "${k}" (x, y, blur, spread, color, inner)`);
      color(sh, "color", path);
      for (const f of ["x", "y", "blur", "spread"]) number(sh, f, path, "shadow." + f);
    }
    if (Array.isArray(node.spans)) {
      node.spans.forEach((sp: any, i: number) => {
        if (!sp || typeof sp !== "object") return;
        for (const k of Object.keys(sp)) {
          if (SPAN_KEYS.has(k)) continue;
          const alias = ({ fontSize: "size", fontWeight: "weight", fontFamily: "font", href: "link", url: "link", textDecoration: "decoration" } as Record<string, string>)[k];
          if (alias && sp[alias] === undefined) {
            sp[alias] = sp[k];
            delete sp[k];
            report(`${path}.spans[${i}]`, `span "${k}": read as ${alias}`);
          } else report(`${path}.spans[${i}]`, `unknown span property "${k}" ignored (text, font, weight, size, color, decoration, case, link)`);
        }
        color(sp, "color", `${path}.spans[${i}]`);
        number(sp, "size", `${path}.spans[${i}]`, "span size");
      });
    }

    // Mistakes the plugin would swallow without a word.
    const container = ["frame", "component", "slide"].includes(kind);
    if (container && !inVariants && !node.layout && !node.direction) {
      const needs = ["padding", "gap", "justify", "align", "wrap"].filter((f) => node[f] !== undefined);
      if (needs.length) report(path, `${needs.join(", ")} need layout:"row"|"column"|"grid" on the same frame; ignored without it`);
    }
    if (typeof node.color === "string" && node.fill === undefined && !["text", "icon", "sticky", "shape", "diagram"].includes(kind)) {
      report(path, `color only applies to text and icons: use fill for a ${kind} background`);
    }
    if (Array.isArray(node.children) && node.children.length && ["text", "icon", "svg", "image", "rect", "ellipse", "line", "instance"].includes(kind)) {
      report(path, `a ${kind} can't have children: they are ignored (wrap them in a frame)`);
    }

    if (Array.isArray(node.children)) node.children.forEach((c: unknown, i: number) => walk(c, `${path}.children[${i}]`));
    if (node.base) walk(node.base, `${path}.base`, true);
    if (Array.isArray(node.variants)) node.variants.forEach((v: unknown, i: number) => walk(v, `${path}.variants[${i}]`, true));
  };

  if (Array.isArray(spec)) spec.forEach((s, i) => walk(s, `spec[${i}]`));
  else if (spec && typeof spec === "object" && Array.isArray((spec as any).slides)) (spec as any).slides.forEach((s: unknown, i: number) => walk(s, `spec.slides[${i}]`));
  else walk(spec, "spec");

  const warnings: string[] = [];
  for (const [message, { path, n }] of seen) {
    if (warnings.length === 30) {
      warnings.push(`…and ${seen.size - 30} more spec issues`);
      break;
    }
    warnings.push(`${path}: ${message}${n > 1 ? ` (${n} layers)` : ""}`);
  }
  return { warnings };
}

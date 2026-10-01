// import_web: computed CSS values → build spec values (paints, shadows, borders, radii).
// Colors are already #RRGGBB[AA]: the in-page snapshot normalizes every color function.

type Css = Record<string, string>;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const px = (v: string | undefined) => parseFloat(v ?? "") || 0;
export const r1 = (n: number) => Math.round(n * 10) / 10;
export const isTransparent = (c: string | undefined) => !c || (c.length === 9 && c.endsWith("00"));

/** Splits on commas that are not inside parentheses. */
export function splitTop(v: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const HEX = /#[0-9A-F]{6}(?:[0-9A-F]{2})?/i;

/** CSS gradient angle (0deg = to top, clockwise) from "135deg", "0.25turn", "to bottom right"… */
export function gradientAngle(arg: string, box: Box): number | null {
  const a = arg.trim().toLowerCase();
  let m = /^(-?[\d.]+)(deg|turn|rad|grad)$/.exec(a);
  if (m) {
    const n = parseFloat(m[1]!);
    return m[2] === "turn" ? n * 360 : m[2] === "rad" ? (n * 180) / Math.PI : m[2] === "grad" ? n * 0.9 : n;
  }
  m = /^to\s+(top|bottom|left|right)(?:\s+(top|bottom|left|right))?$/.exec(a);
  if (!m) return null;
  const sides = [m[1], m[2]].filter(Boolean) as string[];
  const v = sides.find((s) => s === "top" || s === "bottom");
  const h = sides.find((s) => s === "left" || s === "right");
  if (!h) return v === "top" ? 0 : 180;
  if (!v) return h === "right" ? 90 : 270;
  // Corner: the gradient line is perpendicular to the diagonal between the other two corners.
  const dx = (h === "right" ? 1 : -1) * Math.max(box.h, 1);
  const dy = (v === "bottom" ? 1 : -1) * Math.max(box.w, 1);
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/** linear-/radial-gradient(...) → {gradient:[{color, at}], angle, type?}, or null if unsupported. */
export function gradientPaint(layer: string, box: Box): Record<string, unknown> | null {
  const m = /^(repeating-)?(linear|radial)-gradient\((.*)\)$/s.exec(layer.trim());
  if (!m || m[1]) return null;
  const parts = splitTop(m[3]!);
  let angle = 180;
  if (m[2] === "linear" && parts.length && !HEX.test(parts[0]!)) {
    const a = gradientAngle(parts.shift()!, box);
    if (a === null) return null;
    angle = a;
  } else if (m[2] === "radial" && parts.length && !HEX.test(parts[0]!)) {
    parts.shift(); // shape and position: Figma's radial gradient is centered
  }
  const rad = (angle * Math.PI) / 180;
  const length = Math.abs(box.w * Math.sin(rad)) + Math.abs(box.h * Math.cos(rad)) || 1;
  const stops: { color: string; at?: number }[] = [];
  for (const p of parts) {
    const color = HEX.exec(p)?.[0];
    if (!color) continue;
    const pos = p.replace(color, "").trim().split(/\s+/).filter(Boolean);
    for (const raw of pos.length ? pos : [""]) {
      const at = raw.endsWith("%") ? parseFloat(raw) / 100 : raw.endsWith("px") ? parseFloat(raw) / length : undefined;
      stops.push({ color: color.toUpperCase(), at });
    }
  }
  if (stops.length < 2) return stops.length === 1 ? { color: stops[0]!.color } : null;
  // Missing positions are spread evenly between their neighbours, like CSS.
  if (stops[0]!.at === undefined) stops[0]!.at = 0;
  if (stops[stops.length - 1]!.at === undefined) stops[stops.length - 1]!.at = 1;
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.at !== undefined) continue;
    let j = i;
    while (stops[j]!.at === undefined) j++;
    const from = stops[i - 1]!.at!;
    const to = stops[j]!.at!;
    for (let k = i; k < j; k++) stops[k]!.at = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }
  for (let i = 1; i < stops.length; i++) stops[i]!.at = Math.max(stops[i]!.at!, stops[i - 1]!.at!);
  const gradient = stops.map((s) => ({ color: s.color, at: Math.round(Math.min(1, Math.max(0, s.at!)) * 1000) / 1000 }));
  // build's angle 0 runs left → right, CSS 0deg runs bottom → top.
  return m[2] === "radial" ? { gradient, type: "radial" } : { gradient, angle: Math.round((angle - 90) * 10) / 10 };
}

/** Fill layers of an element, bottom first (Figma order). Unsupported layers are reported. */
export function backgroundPaints(css: Css, box: Box, warn: (msg: string) => void): unknown[] {
  const paints: unknown[] = [];
  if (!isTransparent(css.backgroundColor)) paints.push(css.backgroundColor);
  const image = css.backgroundImage;
  if (!image || image === "none") return paints;
  const sizes = splitTop(css.backgroundSize ?? "auto");
  const repeats = splitTop(css.backgroundRepeat ?? "repeat");
  const layers = splitTop(image);
  // CSS lists the top layer first.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    const url = /^url\("?(.*?)"?\)$/s.exec(layer);
    if (url) {
      const size = sizes[i % sizes.length] ?? "auto";
      const repeat = repeats[i % repeats.length] ?? "repeat";
      const fit = size === "contain" ? "fit" : size === "cover" || /100%/.test(size) ? "fill" : /no-repeat/.test(repeat) ? "fill" : "tile";
      paints.push({ image: url[1], fit });
      continue;
    }
    const g = gradientPaint(layer, box);
    if (g) paints.push(g.gradient ? g : g.color);
    else if (layer !== "none") warn(`background "${layer.slice(0, 40)}…" is not supported`);
  }
  return paints;
}

export function shadows(value: string | undefined): Record<string, unknown>[] {
  if (!value || value === "none") return [];
  const out: Record<string, unknown>[] = [];
  for (const s of splitTop(value)) {
    const color = HEX.exec(s)?.[0] ?? "#00000040";
    const inner = /\binset\b/.test(s);
    const nums = s
      .replace(color, "")
      .replace(/\binset\b/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(px);
    if (isTransparent(color)) continue;
    const [x = 0, y = 0, blur = 0, spread = 0] = nums;
    out.push({ x, y, blur, spread, color: color.toUpperCase(), ...(inner ? { inner: true } : {}) });
  }
  // The first CSS shadow is drawn on top; Figma draws the last effect on top.
  return out.reverse();
}

export function radius(css: Css, box: Box): number | number[] | undefined {
  const corner = (v: string | undefined) => {
    const first = (v ?? "0").split(/\s+/)[0]!;
    const n = first.endsWith("%") ? (parseFloat(first) / 100) * Math.min(box.w, box.h) : px(first);
    return r1(Math.min(n, Math.min(box.w, box.h) / 2));
  };
  const r = [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius].map(corner);
  if (r.every((v) => v === 0)) return undefined;
  return r.every((v) => v === r[0]) ? r[0] : r;
}

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;

export function borderWidths(css: Css): number[] {
  return SIDES.map((s) => (css[`border${s}Style`] === "none" || css[`border${s}Style`] === "hidden" ? 0 : px(css[`border${s}Width`])));
}

/** Borders → {stroke, strokeWidth, strokeDash}; per-side widths when they differ. */
export function border(css: Css, warn: (msg: string) => void): Record<string, unknown> {
  const widths = borderWidths(css);
  const visible = SIDES.map((s, i) => (widths[i]! > 0 && !isTransparent(css[`border${s}Color`]) ? i : -1)).filter((i) => i >= 0);
  if (!visible.length) return {};
  const colors = [...new Set(visible.map((i) => css[`border${SIDES[i]!}Color`]!))];
  if (colors.length > 1) warn(`borders of different colors (${colors.join(", ")}): used ${colors[0]}`);
  const w = SIDES.map((_, i) => (visible.includes(i) ? widths[i]! : 0));
  const out: Record<string, unknown> = { stroke: colors[0], strokeWidth: w.every((v) => v === w[0]) ? w[0] : w, strokeAlign: "inside" };
  const style = css[`border${SIDES[visible[0]!]!}Style`];
  const base = Math.max(...w);
  if (style === "dashed") out.strokeDash = [base * 3, base * 2];
  if (style === "dotted") out.strokeDash = [base, base];
  return out;
}

export function blurOf(filter: string | undefined): number | undefined {
  const m = /blur\(([\d.]+)px\)/.exec(filter ?? "");
  return m ? parseFloat(m[1]!) : undefined;
}

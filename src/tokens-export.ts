// design_tokens export: the file's variables (every mode, aliases kept as references) and styles
// → DTCG JSON, CSS custom properties, Tailwind v3 preset, Tailwind v4 @theme, SCSS, TypeScript, or
// Figma Bridge JSON (which design_tokens reads back as-is). Output is deterministic, so re-exporting
// an unchanged file gives identical files.
import { styleWeight } from "./web/fonts";

export interface AliasRef {
  collection: string;
  name: string;
  remote?: boolean;
  missing?: boolean;
}
export type XValue = string | number | boolean | { alias: AliasRef };
export interface XVariable {
  name: string;
  type: "color" | "number" | "string" | "boolean";
  values: Record<string, XValue>;
  description?: string;
  scopes?: string[];
  hidden?: boolean;
}
export interface XCollection {
  name: string;
  /** Default mode first. */
  modes: string[];
  variables: XVariable[];
}
export interface XPaintStyle {
  name: string;
  value: unknown;
  description?: string;
}
export interface XTextStyle {
  name: string;
  font: string;
  style: string;
  size: number;
  lineHeight?: number | string;
  letterSpacing?: number | string;
  case?: string;
  decoration?: string;
  paragraphSpacing?: number;
  variables?: Record<string, AliasRef>;
  description?: string;
}
export interface XEffectStyle {
  name: string;
  value: Record<string, any>[];
  description?: string;
}
export interface ExportData {
  fileName?: string;
  collections: XCollection[];
  styles: { colors: XPaintStyle[]; text: XTextStyle[]; effects: XEffectStyle[] };
  warnings?: string[];
}

export const FORMATS = ["dtcg", "css", "tailwind", "tailwind4", "scss", "ts", "json"] as const;
export type Format = (typeof FORMATS)[number];

export const FILE_NAMES: Record<Format, string> = {
  dtcg: "tokens.json",
  css: "tokens.css",
  tailwind: "tailwind.preset.js",
  tailwind4: "theme.css",
  scss: "_tokens.scss",
  ts: "tokens.ts",
  json: "figma-tokens.json",
};

export interface ExportOptions {
  /** CSS selector of a non-default mode; {mode} and {collection} are replaced (kebab case). */
  modeSelector?: string;
}

export interface GeneratedFile {
  format: Format;
  path: string;
  content: string;
}

type Category = "colors" | "spacing" | "borderRadius" | "fontSize" | "fontWeight" | "fontFamily" | "lineHeight" | "letterSpacing" | "opacity" | "other";

const isAlias = (v: XValue): v is { alias: AliasRef } => typeof v === "object" && v !== null && "alias" in v;
export const kebab = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const camel = (s: string) => kebab(s).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const num = (n: number) => String(Math.round(n * 1000) / 1000);
const quote = (s: string) => JSON.stringify(s);
const qualified = (collection: string, name: string) => `${collection}/${name}`;

/** Numbers that are not lengths: weights, opacities, ratios. */
function unitless(v: XVariable): boolean {
  if (v.scopes?.some((s) => ["FONT_WEIGHT", "OPACITY", "LAYER_OPACITY"].includes(s))) return true;
  return /weight|opacity|z-?index|ratio|scale|order|flex|duration|count|columns?\b/i.test(v.name);
}

function category(v: XVariable): Category {
  const s = v.scopes ?? [];
  const n = v.name.toLowerCase();
  if (v.type === "color") return "colors";
  if (v.type === "string") return s.includes("FONT_FAMILY") || /font|family|typeface/.test(n) ? "fontFamily" : "other";
  if (v.type !== "number") return "other";
  if (s.includes("CORNER_RADIUS") || /radius|rounded|corner/.test(n)) return "borderRadius";
  if (s.includes("FONT_SIZE") || /font-?size|text-?size|font\/size/.test(n)) return "fontSize";
  if (s.includes("FONT_WEIGHT") || /weight/.test(n)) return "fontWeight";
  if (s.includes("LINE_HEIGHT") || /line-?height|leading/.test(n)) return "lineHeight";
  if (s.includes("LETTER_SPACING") || /letter-?spacing|tracking/.test(n)) return "letterSpacing";
  if (s.includes("OPACITY") || /opacity/.test(n)) return "opacity";
  if (s.includes("GAP") || s.includes("WIDTH_HEIGHT") || /spac|gap|padding|margin|size|width|height|inset/.test(n)) return "spacing";
  return "other";
}

/** Path inside a category: "color/brand/primary" → ["brand", "primary"]. */
const CATEGORY_WORDS: Record<Category, RegExp> = {
  colors: /^(colou?rs?|palette)$/i,
  spacing: /^(spacing|space|spaces|sizes?|gap)$/i,
  borderRadius: /^(radius|radii|border-?radius|rounded|corner)$/i,
  fontSize: /^(font-?size|font-?sizes|text|size)$/i,
  fontWeight: /^(font-?weights?|weights?)$/i,
  fontFamily: /^(font-?famil(y|ies)|fonts?|family)$/i,
  lineHeight: /^(line-?heights?|leading)$/i,
  letterSpacing: /^(letter-?spacing|tracking)$/i,
  opacity: /^opacit(y|ies)$/i,
  other: /^$/,
};
function subPath(name: string, cat: Category): string[] {
  const parts = name.split("/").map(kebab).filter(Boolean);
  if (parts.length > 1 && (CATEGORY_WORDS[cat].test(parts[0]!) || (cat === "fontSize" && parts[0] === "font" && parts[1] === "size"))) {
    parts.shift();
    if (cat === "fontSize" && parts[0] === "size") parts.shift();
  }
  return parts.length ? parts : [kebab(name) || "default"];
}

function setPath(obj: Record<string, any>, path: string[], value: unknown) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    if (typeof o[k] !== "object" || o[k] === null) o[k] = o[k] === undefined ? {} : { DEFAULT: o[k] };
    o = o[k];
  }
  const last = path[path.length - 1]!;
  if (typeof o[last] === "object" && o[last] !== null) o[last].DEFAULT = value;
  else o[last] = value;
}

// ─── Index ──────────────────────────────────────────────────────────────────

class Model {
  vars = new Map<string, { v: XVariable; c: XCollection }>();
  cssName = new Map<string, string>();
  warnings: string[] = [];

  constructor(readonly data: ExportData) {
    const base = new Map<string, string[]>();
    for (const c of data.collections) {
      for (const v of c.variables) {
        const key = qualified(c.name, v.name);
        this.vars.set(key, { v, c });
        const b = kebab(v.name) || "token";
        base.set(b, [...(base.get(b) ?? []), key]);
      }
    }
    // Same name in two collections: both get their collection as a prefix.
    for (const [b, keys] of base) {
      for (const key of keys) this.cssName.set(key, keys.length > 1 ? `${kebab(this.vars.get(key)!.c.name)}-${b}` : b);
    }
  }

  target(a: AliasRef) {
    return this.vars.get(qualified(a.collection, a.name));
  }

  /** CSS custom property of an alias target (library variables keep their own name). */
  cssOf(a: AliasRef): string {
    const name = this.cssName.get(qualified(a.collection, a.name));
    if (name) return name;
    this.warn(`"${a.name}" comes from a library: it is referenced but not exported`);
    return kebab(a.name);
  }

  warn(msg: string) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  /** Literal value of a variable in a mode (aliases followed; other collections use their default mode). */
  resolve(v: XVariable, c: XCollection, mode: string, depth = 0): XValue | undefined {
    const raw = v.values[mode] ?? v.values[c.modes[0]!];
    if (raw === undefined || !isAlias(raw) || depth > 10) return raw;
    const t = this.target(raw.alias);
    if (!t) return undefined;
    return this.resolve(t.v, t.c, t.c.modes.includes(mode) ? mode : t.c.modes[0]!, depth + 1);
  }

  /** Default-mode values first, aliases after their targets (SCSS and TS need that order). */
  ordered(): { key: string; v: XVariable; c: XCollection }[] {
    const out: { key: string; v: XVariable; c: XCollection }[] = [];
    const state = new Map<string, number>();
    const visit = (key: string) => {
      if (state.get(key)) return;
      state.set(key, 1);
      const e = this.vars.get(key)!;
      const raw = e.v.values[e.c.modes[0]!];
      if (raw !== undefined && isAlias(raw)) {
        const tk = qualified(raw.alias.collection, raw.alias.name);
        if (this.vars.has(tk) && !state.get(tk)) visit(tk);
      }
      out.push({ key, ...e });
    };
    for (const key of this.vars.keys()) visit(key);
    return out;
  }
}

// ─── CSS values ─────────────────────────────────────────────────────────────

function cssLiteral(v: XVariable, value: XValue): string | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return unitless(v) ? num(value) : `${num(value)}px`;
  if (v.type === "string" && category(v) === "fontFamily") return /^[\w-]+$/.test(String(value)) ? String(value) : quote(String(value));
  if (v.type === "string") return quote(String(value));
  return String(value);
}

function gradientCss(g: any): string {
  const stops = (g.gradient as { color: string; at: number }[]).map((s) => `${s.color} ${num(s.at * 100)}%`).join(", ");
  if (g.type === "radial") return `radial-gradient(circle, ${stops})`;
  if (g.type) return `conic-gradient(${stops})`;
  return `linear-gradient(${num((g.angle ?? 0) + 90)}deg, ${stops})`;
}

function paintCss(value: unknown, ref: (a: AliasRef) => string): string {
  const one = (p: any): string => (typeof p === "string" ? p : p && p.alias ? ref(p.alias) : p && p.gradient ? gradientCss(p) : "transparent");
  if (!Array.isArray(value)) return one(value);
  // Figma lists paints bottom first; CSS backgrounds list the top layer first.
  return value
    .slice()
    .reverse()
    .map((p) => (typeof p === "string" || (p && p.alias) ? `linear-gradient(${one(p)}, ${one(p)})` : one(p)))
    .join(", ");
}

function shadowCss(effects: Record<string, any>[], ref: (a: AliasRef) => string): string | null {
  const list = effects
    .filter((e) => e.blur !== undefined && e.type === undefined)
    .reverse()
    .map((e) => `${e.inner ? "inset " : ""}${num(e.x)}px ${num(e.y)}px ${num(e.blur)}px ${num(e.spread ?? 0)}px ${e.colorVariable ? ref(e.colorVariable) : e.color}`);
  return list.length ? list.join(", ") : null;
}

const letterSpacingCss = (v: number | string | undefined) =>
  v === undefined ? undefined : typeof v === "string" && v.endsWith("%") ? `${num(parseFloat(v) / 100)}em` : `${num(Number(v))}px`;
const lineHeightCss = (v: number | string | undefined) => (v === undefined ? undefined : typeof v === "string" ? v : `${num(v)}px`);

function textDecls(t: XTextStyle, ref: (a: AliasRef) => string): [string, string][] {
  const w = styleWeight(t.style);
  const bound = t.variables ?? {};
  const d: [string, string][] = [
    ["font-family", bound.fontFamily ? ref(bound.fontFamily) : `${/^[\w-]+$/.test(t.font) ? t.font : quote(t.font)}, sans-serif`],
    ["font-weight", bound.fontWeight ? ref(bound.fontWeight) : String(w.weight)],
    ["font-size", bound.fontSize ? ref(bound.fontSize) : `${num(t.size)}px`],
  ];
  if (w.italic) d.push(["font-style", "italic"]);
  const lh = bound.lineHeight ? ref(bound.lineHeight) : lineHeightCss(t.lineHeight);
  if (lh) d.push(["line-height", lh]);
  const ls = bound.letterSpacing ? ref(bound.letterSpacing) : letterSpacingCss(t.letterSpacing);
  if (ls) d.push(["letter-spacing", ls]);
  if (t.case) d.push(["text-transform", t.case === "upper" ? "uppercase" : t.case === "lower" ? "lowercase" : "capitalize"]);
  if (t.decoration) d.push(["text-decoration", t.decoration === "underline" ? "underline" : "line-through"]);
  return d;
}

function modeSelector(opts: ExportOptions, mode: string, collection: string) {
  return (opts.modeSelector ?? '[data-theme="{mode}"]').replace(/\{mode\}/g, kebab(mode)).replace(/\{collection\}/g, kebab(collection));
}

function header(model: Model, comment: (s: string) => string) {
  return comment(`Design tokens exported by Figma Bridge${model.data.fileName ? ` from "${model.data.fileName}"` : ""}.`) + "\n";
}

/** Names for style custom properties that never clash with variables. */
function styleNames(model: Model, prefix: string, styles: { name: string }[]): Map<string, string> {
  const taken = new Set(model.cssName.values());
  const out = new Map<string, string>();
  for (const s of styles) {
    let n = kebab(s.name);
    if (!n.startsWith(`${prefix}-`)) n = `${prefix}-${n}`;
    while (taken.has(n)) n += "-style";
    taken.add(n);
    out.set(s.name, n);
  }
  return out;
}

// ─── CSS ────────────────────────────────────────────────────────────────────

function toCss(model: Model, opts: ExportOptions): string {
  const ref = (a: AliasRef) => `var(--${model.cssOf(a)})`;
  const blocks = new Map<string, string[]>();
  const add = (selector: string, line: string) => blocks.set(selector, [...(blocks.get(selector) ?? []), line]);
  for (const c of model.data.collections) {
    for (const [i, mode] of c.modes.entries()) {
      const selector = i === 0 ? ":root" : modeSelector(opts, mode, c.name);
      for (const v of c.variables) {
        const raw = v.values[mode];
        if (raw === undefined) continue;
        const value = isAlias(raw) ? ref(raw.alias) : cssLiteral(v, raw);
        if (value !== null) add(selector, `  --${model.cssName.get(qualified(c.name, v.name))}: ${value};`);
      }
    }
  }
  const s = model.data.styles;
  const paints = styleNames(model, "color", s.colors);
  for (const p of s.colors) add(":root", `  --${paints.get(p.name)}: ${paintCss(p.value, ref)};`);
  const shadows = styleNames(model, "shadow", s.effects);
  for (const e of s.effects) {
    const v = shadowCss(e.value, ref);
    if (v) add(":root", `  --${shadows.get(e.name)}: ${v};`);
  }
  let out = header(model, (t) => `/* ${t} */`);
  for (const [selector, lines] of blocks) out += `\n${selector} {\n${lines.join("\n")}\n}\n`;
  for (const t of s.text) out += `\n.text-${kebab(t.name).replace(/^text-/, "")} {\n${textDecls(t, ref).map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}\n`;
  return out;
}

// ─── Tailwind v3 preset ─────────────────────────────────────────────────────

const TW3_KEYS: Partial<Record<Category, string>> = {
  colors: "colors",
  spacing: "spacing",
  borderRadius: "borderRadius",
  fontSize: "fontSize",
  fontWeight: "fontWeight",
  fontFamily: "fontFamily",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  opacity: "opacity",
};

function toTailwind3(model: Model): string {
  const theme: Record<string, any> = {};
  for (const c of model.data.collections) {
    for (const v of c.variables) {
      const key = TW3_KEYS[category(v)];
      if (!key) continue;
      theme[key] ??= {};
      setPath(theme[key], subPath(v.name, category(v)), `var(--${model.cssName.get(qualified(c.name, v.name))})`);
    }
  }
  const s = model.data.styles;
  const paints = styleNames(model, "color", s.colors);
  for (const p of s.colors) {
    const isGradient = (Array.isArray(p.value) ? p.value : [p.value]).some((x: any) => x && x.gradient);
    const group = isGradient ? "backgroundImage" : "colors";
    theme[group] ??= {};
    setPath(theme[group], p.name.split("/").map(kebab), `var(--${paints.get(p.name)})`);
  }
  const ref = (a: AliasRef) => `var(--${model.cssOf(a)})`;
  for (const t of s.text) {
    theme.fontSize ??= {};
    const d = Object.fromEntries(textDecls(t, ref));
    const extra: Record<string, string> = {};
    if (d["line-height"]) extra.lineHeight = d["line-height"];
    if (d["letter-spacing"]) extra.letterSpacing = d["letter-spacing"];
    extra.fontWeight = d["font-weight"]!;
    setPath(theme.fontSize, [kebab(t.name).replace(/^text-/, "")], [d["font-size"], extra]);
    theme.fontFamily ??= {};
    const fam = kebab(t.font);
    if (!theme.fontFamily[fam]) theme.fontFamily[fam] = [t.font, "sans-serif"];
  }
  const shadows = styleNames(model, "shadow", s.effects);
  for (const e of s.effects) {
    if (!shadowCss(e.value, ref)) continue;
    theme.boxShadow ??= {};
    setPath(theme.boxShadow, e.name.split("/").map(kebab).filter((p, i, all) => !(i === 0 && all.length > 1 && /^(shadows?|elevation|effects?)$/.test(p))), `var(--${shadows.get(e.name)})`);
  }
  return (
    header(model, (t) => `// ${t}`) +
    "// Values are CSS variables defined in tokens.css (import it once; it carries every mode).\n" +
    "// Use it in tailwind.config.js: presets: [require(\"./tailwind.preset.js\")]\n" +
    `/** @type {import('tailwindcss').Config} */\nmodule.exports = ${JSON.stringify({ theme: { extend: theme } }, null, 2)};\n`
  );
}

// ─── Tailwind v4 @theme ─────────────────────────────────────────────────────

const TW4_NS: Partial<Record<Category, string>> = {
  colors: "color",
  spacing: "spacing",
  borderRadius: "radius",
  fontSize: "text",
  fontWeight: "font-weight",
  fontFamily: "font",
  lineHeight: "leading",
  letterSpacing: "tracking",
  opacity: "opacity",
};

function toTailwind4(model: Model, opts: ExportOptions): string {
  const names = new Map<string, string>();
  for (const [key, { v }] of model.vars) {
    const ns = TW4_NS[category(v)];
    names.set(key, ns ? `${ns}-${subPath(v.name, category(v)).join("-")}` : model.cssName.get(key)!);
  }
  const ref = (a: AliasRef) => `var(--${names.get(qualified(a.collection, a.name)) ?? model.cssOf(a)})`;
  const theme: string[] = [];
  const root: string[] = [];
  const modes = new Map<string, string[]>();
  for (const c of model.data.collections) {
    for (const [i, mode] of c.modes.entries()) {
      for (const v of c.variables) {
        const raw = v.values[mode];
        if (raw === undefined) continue;
        const value = isAlias(raw) ? ref(raw.alias) : cssLiteral(v, raw);
        if (value === null) continue;
        const line = `  --${names.get(qualified(c.name, v.name))}: ${value};`;
        if (i > 0) {
          const sel = modeSelector(opts, mode, c.name);
          modes.set(sel, [...(modes.get(sel) ?? []), line]);
        } else (TW4_NS[category(v)] ? theme : root).push(line);
      }
    }
  }
  const s = model.data.styles;
  for (const p of s.colors) theme.push(`  --${(Array.isArray(p.value) || (p.value as any)?.gradient ? "background-image-" : "color-") + kebab(p.name)}: ${paintCss(p.value, ref)};`);
  const families = new Set<string>();
  for (const t of s.text) {
    const n = kebab(t.name).replace(/^text-/, "");
    const d = Object.fromEntries(textDecls(t, ref));
    theme.push(`  --text-${n}: ${d["font-size"]};`);
    if (d["line-height"]) theme.push(`  --text-${n}--line-height: ${d["line-height"]};`);
    if (d["letter-spacing"]) theme.push(`  --text-${n}--letter-spacing: ${d["letter-spacing"]};`);
    theme.push(`  --text-${n}--font-weight: ${d["font-weight"]};`);
    if (!families.has(t.font)) {
      families.add(t.font);
      theme.push(`  --font-${kebab(t.font)}: ${d["font-family"]};`);
    }
  }
  for (const e of s.effects) {
    const v = shadowCss(e.value, ref);
    if (v) theme.push(`  --shadow-${kebab(e.name).replace(/^shadows?-/, "")}: ${v};`);
  }
  let out = header(model, (t) => `/* ${t} */`) + '/* Import after tailwindcss: @import "tailwindcss"; @import "./theme.css"; */\n';
  out += `\n@theme {\n${theme.join("\n")}\n}\n`;
  if (root.length) out += `\n:root {\n${root.join("\n")}\n}\n`;
  for (const [sel, lines] of modes) out += `\n${sel} {\n${lines.join("\n")}\n}\n`;
  return out;
}

// ─── SCSS ───────────────────────────────────────────────────────────────────

function toScss(model: Model): string {
  const ref = (a: AliasRef) => `$${model.cssOf(a)}`;
  let out = header(model, (t) => `// ${t}`);
  let current = "";
  for (const { key, v, c } of model.ordered()) {
    if (c.name !== current) {
      current = c.name;
      out += `\n// ${c.name}${c.modes.length > 1 ? ` (${c.modes[0]})` : ""}\n`;
    }
    const raw = v.values[c.modes[0]!];
    if (raw === undefined) continue;
    const value = isAlias(raw) ? ref(raw.alias) : cssLiteral(v, raw);
    if (value !== null) out += `$${model.cssName.get(key)}: ${value};\n`;
  }
  // Other modes as maps of literal values, e.g. map.get($theme-dark, "color-primary").
  for (const c of model.data.collections) {
    for (const mode of c.modes.slice(1)) {
      const lines: string[] = [];
      for (const v of c.variables) {
        const value = model.resolve(v, c, mode);
        if (value === undefined || isAlias(value)) continue;
        const css = cssLiteral(v, value);
        if (css !== null) lines.push(`  "${model.cssName.get(qualified(c.name, v.name))}": ${css},`);
      }
      if (lines.length) out += `\n$${kebab(c.name)}-${kebab(mode)}: (\n${lines.join("\n")}\n);\n`;
    }
  }
  const s = model.data.styles;
  if (s.colors.length) out += "\n// Paint styles\n";
  const paints = styleNames(model, "color", s.colors);
  for (const p of s.colors) out += `$${paints.get(p.name)}: ${paintCss(p.value, ref)};\n`;
  const shadows = styleNames(model, "shadow", s.effects);
  if (s.effects.length) out += "\n// Effect styles\n";
  for (const e of s.effects) {
    const v = shadowCss(e.value, ref);
    if (v) out += `$${shadows.get(e.name)}: ${v};\n`;
  }
  if (s.text.length) out += "\n// Text styles\n";
  for (const t of s.text) out += `@mixin text-${kebab(t.name).replace(/^text-/, "")} {\n${textDecls(t, ref).map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}\n`;
  return out;
}

// ─── TypeScript ─────────────────────────────────────────────────────────────

function tsLiteral(value: XValue): string {
  if (typeof value === "number") return num(value);
  if (typeof value === "boolean") return String(value);
  return quote(String(value));
}

function toTs(model: Model): string {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const key of model.vars.keys()) {
    let id = camel(model.cssName.get(key)!) || "token";
    if (/^\d/.test(id)) id = `_${id}`;
    while (used.has(id)) id += "_";
    used.add(id);
    ids.set(key, id);
  }
  let out = header(model, (t) => `// ${t}`) + "// Default-mode values; aliases stay references to the variable they point to.\n\n";
  for (const { key, v, c } of model.ordered()) {
    const raw = v.values[c.modes[0]!];
    if (raw === undefined) continue;
    let value: string;
    if (isAlias(raw)) {
      const tk = qualified(raw.alias.collection, raw.alias.name);
      value = ids.get(tk) ?? quote(`{${raw.alias.collection}/${raw.alias.name}}`);
    } else value = tsLiteral(raw);
    out += `const ${ids.get(key)} = ${value};\n`;
  }
  const tree: Record<string, any> = {};
  for (const [key, { v, c }] of model.vars) {
    const path = model.data.collections.length > 1 ? [c.name, ...v.name.split("/")] : v.name.split("/");
    setPath(tree, path, { __ref: ids.get(key) });
  }
  const render = (o: any, depth: number): string => {
    if (o && o.__ref) return o.__ref;
    const pad = "  ".repeat(depth + 1);
    const entries = Object.entries(o).map(([k, v]) => `${pad}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)}: ${render(v, depth + 1)},`);
    return `{\n${entries.join("\n")}\n${"  ".repeat(depth)}}`;
  };
  out += `\nexport const tokens = ${render(tree, 0)} as const;\n`;
  // Other modes: literal values by variable name.
  const modes: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const c of model.data.collections) {
    for (const mode of c.modes.slice(1)) {
      for (const v of c.variables) {
        const value = model.resolve(v, c, mode);
        if (value === undefined || isAlias(value)) continue;
        ((modes[c.name] ??= {})[mode] ??= {})[v.name] = value;
      }
    }
  }
  if (Object.keys(modes).length) out += `\nexport const modes = ${JSON.stringify(modes, null, 2)} as const;\n`;
  const s = model.data.styles;
  const resolved = (a: AliasRef) => {
    const t = model.target(a);
    const v = t && model.resolve(t.v, t.c, t.c.modes[0]!);
    return v === undefined || isAlias(v) ? `{${a.collection}/${a.name}}` : v;
  };
  if (s.text.length) {
    const text: Record<string, unknown> = {};
    for (const t of s.text) {
      const w = styleWeight(t.style);
      text[t.name] = {
        fontFamily: t.variables?.fontFamily ? resolved(t.variables.fontFamily) : t.font,
        fontWeight: w.weight,
        ...(w.italic ? { fontStyle: "italic" } : {}),
        fontSize: t.variables?.fontSize ? resolved(t.variables.fontSize) : t.size,
        ...(t.lineHeight !== undefined ? { lineHeight: t.lineHeight } : {}),
        ...(t.letterSpacing !== undefined ? { letterSpacing: t.letterSpacing } : {}),
        ...(t.case ? { textCase: t.case } : {}),
      };
    }
    out += `\nexport const textStyles = ${JSON.stringify(text, null, 2)} as const;\n`;
  }
  if (s.effects.length) {
    const ref = (a: AliasRef) => String(resolved(a));
    out += `\nexport const shadows = ${JSON.stringify(Object.fromEntries(s.effects.map((e) => [e.name, shadowCss(e.value, ref)]).filter(([, v]) => v)), null, 2)} as const;\n`;
  }
  if (s.colors.length) {
    const ref = (a: AliasRef) => String(resolved(a));
    out += `\nexport const paints = ${JSON.stringify(Object.fromEntries(s.colors.map((p) => [p.name, paintCss(p.value, ref)])), null, 2)} as const;\n`;
  }
  return out + "\nexport type Tokens = typeof tokens;\n";
}

// ─── DTCG ───────────────────────────────────────────────────────────────────

function dtcgType(v: XVariable): string {
  if (v.type === "color") return "color";
  if (v.type === "boolean") return "boolean";
  if (v.type === "string") return category(v) === "fontFamily" ? "fontFamily" : "string";
  if (category(v) === "fontWeight") return "fontWeight";
  return unitless(v) ? "number" : "dimension";
}

function toDtcg(model: Model): string {
  const out: Record<string, any> = {};
  const dtcgRef = (a: AliasRef) => `{${[a.collection, ...a.name.split("/")].join(".")}}`;
  const literal = (v: XVariable, x: XValue) => (isAlias(x) ? dtcgRef(x.alias) : dtcgType(v) === "dimension" ? `${num(Number(x))}px` : x);
  for (const c of model.data.collections) {
    const group: Record<string, any> = { $extensions: { "figma-bridge": { collection: true, modes: c.modes } } };
    for (const v of c.variables) {
      const token: Record<string, any> = { $type: dtcgType(v), $value: literal(v, v.values[c.modes[0]!]!) };
      if (v.description) token.$description = v.description;
      const others = c.modes.slice(1).filter((m) => v.values[m] !== undefined);
      const ext: Record<string, any> = {};
      if (others.length) ext.modes = Object.fromEntries(others.map((m) => [m, literal(v, v.values[m]!)]));
      if (v.scopes) ext["figma-bridge"] = { scopes: v.scopes };
      if (Object.keys(ext).length) token.$extensions = ext;
      setPath(group, v.name.split("/"), token);
    }
    out[c.name] = group;
  }
  const s = model.data.styles;
  if (s.colors.length || s.text.length || s.effects.length) {
    const styles: Record<string, any> = { $extensions: { "figma-bridge": { styles: true } } };
    for (const p of s.colors) {
      const v = Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value;
      const token: Record<string, any> =
        v && (v as any).gradient
          ? { $type: "gradient", $value: (v as any).gradient.map((g: any) => ({ color: g.color, position: g.at })), $extensions: { "figma-bridge": { style: "paint", ...("angle" in (v as any) ? { angle: (v as any).angle } : {}) } } }
          : { $type: "color", $value: typeof v === "string" ? v : dtcgRef((v as any).alias), $extensions: { "figma-bridge": { style: "paint" } } };
      if (p.description) token.$description = p.description;
      setPath(styles, p.name.split("/"), token);
    }
    for (const t of s.text) {
      const w = styleWeight(t.style);
      const value: Record<string, unknown> = { fontFamily: t.font, fontWeight: w.weight, fontSize: `${num(t.size)}px` };
      if (t.lineHeight !== undefined) value.lineHeight = typeof t.lineHeight === "number" ? `${num(t.lineHeight)}px` : t.lineHeight;
      if (t.letterSpacing !== undefined) value.letterSpacing = letterSpacingCss(t.letterSpacing);
      const token: Record<string, any> = { $type: "typography", $value: value, $extensions: { "figma-bridge": { style: t.style } } };
      if (t.description) token.$description = t.description;
      setPath(styles, t.name.split("/"), token);
    }
    for (const e of s.effects) {
      const shadows = e.value.filter((x) => x.type === undefined);
      if (!shadows.length) continue;
      const token: Record<string, any> = {
        $type: "shadow",
        $value: shadows.map((x) => ({ color: x.color, offsetX: `${num(x.x)}px`, offsetY: `${num(x.y)}px`, blur: `${num(x.blur)}px`, spread: `${num(x.spread ?? 0)}px`, ...(x.inner ? { inset: true } : {}) })),
      };
      if (e.description) token.$description = e.description;
      setPath(styles, e.name.split("/"), token);
    }
    out.styles = styles;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

// ─── Figma Bridge JSON (design_tokens reads it back unchanged) ───────────────

function toJson(model: Model): string {
  const collections = model.data.collections.map((c) => ({
    name: c.name,
    modes: c.modes,
    variables: Object.fromEntries(
      c.variables.map((v) => {
        const values = Object.fromEntries(
          Object.entries(v.values).map(([m, x]) => [m, isAlias(x) ? `{${x.alias.collection === c.name ? x.alias.name : `${x.alias.collection}/${x.alias.name}`}}` : x]),
        );
        return [v.name, { type: v.type, values, ...(v.description ? { description: v.description } : {}), ...(v.scopes ? { scopes: v.scopes } : {}) }];
      }),
    ),
  }));
  const s = model.data.styles;
  const paint = (p: any): unknown => (p && p.alias ? `var:${p.alias.collection}/${p.alias.name}` : p);
  const styles = {
    colors: Object.fromEntries(s.colors.map((p) => [p.name, Array.isArray(p.value) ? p.value.map(paint) : paint(p.value)])),
    text: Object.fromEntries(
      s.text.map((t) => {
        const { name, font, style, variables, ...rest } = t;
        return [name, { font: `${font}:${style}`, ...rest }];
      }),
    ),
    effects: Object.fromEntries(s.effects.map((e) => [e.name, e.value.map(({ colorVariable, ...x }) => x)])),
  };
  return JSON.stringify({ collections, styles }, null, 2) + "\n";
}

export function exportTokenFiles(data: ExportData, formats: Format[], opts: ExportOptions = {}): { files: GeneratedFile[]; warnings: string[] } {
  const model = new Model(data);
  const files: GeneratedFile[] = [];
  const wanted = new Set(formats);
  // The Tailwind v3 preset points at CSS variables: tokens.css comes with it.
  if (wanted.has("tailwind")) wanted.add("css");
  for (const f of FORMATS) {
    if (!wanted.has(f)) continue;
    const content =
      f === "css" ? toCss(model, opts) : f === "tailwind" ? toTailwind3(model) : f === "tailwind4" ? toTailwind4(model, opts) : f === "scss" ? toScss(model) : f === "ts" ? toTs(model) : f === "dtcg" ? toDtcg(model) : toJson(model);
    files.push({ format: f, path: FILE_NAMES[f], content });
  }
  return { files, warnings: [...(data.warnings ?? []), ...model.warnings] };
}

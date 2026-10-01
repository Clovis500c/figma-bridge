// Normalizes design tokens (simple JSON, W3C design tokens, Tailwind theme) into the
// flat shape the plugin writes: collections of variables with per-mode values, plus styles.

export type TokenValue = string | number | boolean | { alias: string };

export interface VariableSpec {
  name: string;
  type?: "color" | "number" | "string" | "boolean";
  /** Values by mode name; "*" applies to every mode of the collection. */
  values: Record<string, TokenValue>;
  description?: string;
  scopes?: string[];
}

export interface CollectionSpec {
  name: string;
  modes: string[];
  variables: VariableSpec[];
}

export interface NamedStyle {
  name: string;
  [key: string]: unknown;
}

export interface TokenSet {
  collections: CollectionSpec[];
  styles: { colors: NamedStyle[]; text: NamedStyle[]; effects: NamedStyle[] };
  warnings: string[];
}

export type TokenFormat = "auto" | "simple" | "w3c" | "tailwind";

export interface NormalizeOptions {
  format?: TokenFormat;
  /** Collection that receives W3C or Tailwind variables. */
  collection?: string;
  /** Mode that receives single-mode values (W3C, Tailwind). */
  mode?: string;
}

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// ─── Colors ─────────────────────────────────────────────────────────────────

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0").toUpperCase();

function rgbHex(r: number, g: number, b: number, a = 1): string {
  return "#" + hex2(r) + hex2(g) + hex2(b) + (a < 0.999 ? hex2(a * 255) : "");
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** CSS color (hex, rgb(), hsl(), transparent) → "#RRGGBB[AA]", or null. */
export function cssColor(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return "#00000000";
  if (s === "white") return "#FFFFFF";
  if (s === "black") return "#000000";
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = h.split("").map((c) => c + c).join("");
    return ("#" + (h.endsWith("ff") && h.length === 8 ? h.slice(0, 6) : h)).toUpperCase();
  }
  const num = (v: string, scale: number) => (v.endsWith("%") ? (parseFloat(v) / 100) * scale : parseFloat(v));
  const alpha = (v: string | undefined) => (v === undefined ? 1 : v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v));
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) return rgbHex(num(m[1]!, 255), num(m[2]!, 255), num(m[3]!, 255), alpha(m[4]));
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const [r, g, b] = hslToRgb(parseFloat(m[1]!), parseFloat(m[2]!) / 100, parseFloat(m[3]!) / 100);
    return rgbHex(r, g, b, alpha(m[4]));
  }
  return null;
}

/** W3C color: a CSS string or {colorSpace, components, alpha, hex}. */
function w3cColor(v: unknown): string | null {
  if (typeof v === "string") return cssColor(v);
  if (!isObj(v)) return null;
  const a = typeof v.alpha === "number" ? v.alpha : 1;
  if (typeof v.hex === "string") {
    const hex = cssColor(v.hex);
    return hex && a < 0.999 ? hex.slice(0, 7) + hex2(a * 255) : hex;
  }
  if (Array.isArray(v.components) && (!v.colorSpace || v.colorSpace === "srgb")) {
    const [r, g, b] = v.components.map(Number);
    return rgbHex(r! * 255, g! * 255, b! * 255, a);
  }
  if (Array.isArray(v.components) && v.colorSpace === "hsl") {
    const [h, s, l] = v.components.map(Number);
    const [r, g, b] = hslToRgb(h!, s! / 100, l! / 100);
    return rgbHex(r, g, b, a);
  }
  return null;
}

/** "16px", "1rem", 16, {value, unit} → pixels (rem/em = 16 px). */
export function dimension(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (isObj(v) && typeof v.value === "number") return v.unit === "rem" || v.unit === "em" ? v.value * 16 : v.value;
  if (typeof v !== "string") return null;
  const m = /^(-?[\d.]+)\s*(px|rem|em)?$/.exec(v.trim());
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return m[2] === "rem" || m[2] === "em" ? n * 16 : n;
}

// Figma variable names cannot contain "." "{" or "}".
const cleanName = (s: string) => s.replace(/[.{}]/g, "_");

function aliasOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\{([^{}]+)\}$/.exec(v.trim()) ?? /^var:(.+)$/.exec(v.trim());
  return m ? m[1]!.replace(/\./g, "/") : null;
}

// ─── Format detection ───────────────────────────────────────────────────────

function hasW3cTokens(v: unknown, depth = 0): boolean {
  if (!isObj(v) || depth > 12) return false;
  if ("$value" in v) return true;
  return Object.values(v).some((x) => hasW3cTokens(x, depth + 1));
}

const TAILWIND_KEYS = ["colors", "spacing", "borderRadius", "fontSize"];

export function detectFormat(input: Obj): Exclude<TokenFormat, "auto"> {
  if (Array.isArray(input.collections) || isObj(input.styles)) return "simple";
  if (hasW3cTokens(input)) return "w3c";
  const theme = isObj(input.theme) ? input.theme : input;
  if (TAILWIND_KEYS.some((k) => k in theme) || isObj(theme.extend)) return "tailwind";
  return "simple";
}

export function normalizeTokens(input: Obj, opts: NormalizeOptions = {}): TokenSet {
  const format = !opts.format || opts.format === "auto" ? detectFormat(input) : opts.format;
  if (format === "w3c") return fromW3c(input, opts);
  if (format === "tailwind") return fromTailwind(input, opts);
  return fromSimple(input);
}

// ─── Simple JSON ────────────────────────────────────────────────────────────

const DETAIL_KEYS = ["type", "value", "values", "description", "scopes", "$value", "$type"];

function scalar(v: unknown, type: VariableSpec["type"] | undefined, warn: (s: string) => void, where: string): TokenValue | null {
  const alias = aliasOf(v);
  if (alias) return { alias };
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (type === "string") return v;
    const color = cssColor(v);
    if (color) return color;
    if (type === "number") {
      const n = dimension(v);
      if (n !== null) return n;
    }
    return v;
  }
  warn(`${where}: unsupported value ${JSON.stringify(v)}`);
  return null;
}

function inferType(values: TokenValue[]): VariableSpec["type"] | undefined {
  for (const v of values) {
    if (typeof v === "number") return "number";
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "string") return /^#[0-9A-F]{6,8}$/.test(v) ? "color" : "string";
  }
  return undefined; // only aliases: the plugin uses the target's type
}

function simpleVariable(name: string, raw: unknown, warn: (s: string) => void): VariableSpec | null {
  let type: VariableSpec["type"];
  let byMode: Obj;
  let description: string | undefined;
  let scopes: string[] | undefined;
  if (isObj(raw) && !("alias" in raw) && Object.keys(raw).some((k) => DETAIL_KEYS.includes(k))) {
    const t = String(raw.type ?? raw.$type ?? "").toLowerCase();
    type = t === "float" || t === "dimension" ? "number" : (["color", "number", "string", "boolean"].includes(t) ? t : undefined) as VariableSpec["type"];
    byMode = isObj(raw.values) ? raw.values : { "*": raw.value ?? raw.$value };
    description = typeof raw.description === "string" ? raw.description : undefined;
    scopes = Array.isArray(raw.scopes) ? raw.scopes.map(String) : undefined;
  } else if (isObj(raw) && !("alias" in raw)) {
    byMode = raw;
  } else {
    byMode = { "*": isObj(raw) ? `{${raw.alias}}` : raw };
  }
  const values: Record<string, TokenValue> = {};
  for (const [mode, v] of Object.entries(byMode)) {
    const out = scalar(v, type, warn, name);
    if (out !== null) values[mode] = out;
  }
  if (!Object.keys(values).length) return null;
  return { name: cleanName(name), type: type ?? inferType(Object.values(values)), values, description, scopes };
}

function styleList(v: unknown): NamedStyle[] {
  if (Array.isArray(v)) return v.filter((x) => isObj(x) && typeof x.name === "string") as NamedStyle[];
  if (!isObj(v)) return [];
  return Object.entries(v).map(([name, value]) => (isObj(value) && !Array.isArray(value) && !("gradient" in value) ? { ...value, name } : { name, value }));
}

function colorStyles(v: unknown): NamedStyle[] {
  return styleList(v).map((s) => {
    const value = "value" in s ? s.value : s.color ?? s.fill;
    const hex = typeof value === "string" && !aliasOf(value) && !value.startsWith("var:") ? cssColor(value) : null;
    return { ...s, value: hex ?? value };
  });
}

function fromSimple(input: Obj): TokenSet {
  const warnings: string[] = [];
  const warn = (s: string) => void warnings.push(s);
  const collections: CollectionSpec[] = [];
  for (const c of Array.isArray(input.collections) ? input.collections : []) {
    if (!isObj(c) || typeof c.name !== "string") {
      warn("collection without a name, skipped");
      continue;
    }
    const modes: string[] = Array.isArray(c.modes) && c.modes.length ? c.modes.map(String) : [];
    const variables: VariableSpec[] = [];
    const entries = Array.isArray(c.variables)
      ? c.variables.filter(isObj).map((v: Obj) => [String(v.name), v] as const)
      : Object.entries(isObj(c.variables) ? c.variables : {});
    for (const [name, raw] of entries) {
      const spec = simpleVariable(name, raw, warn);
      if (!spec) continue;
      for (const m of Object.keys(spec.values)) if (m !== "*" && !modes.includes(m)) modes.push(m);
      variables.push(spec);
    }
    collections.push({ name: c.name, modes: modes.length ? modes : ["Default"], variables });
  }
  const styles = isObj(input.styles) ? input.styles : {};
  return {
    collections,
    styles: { colors: colorStyles(styles.colors ?? styles.paint), text: styleList(styles.text), effects: styleList(styles.effects ?? styles.effect) },
    warnings,
  };
}

// ─── W3C design tokens ──────────────────────────────────────────────────────

interface W3cToken {
  path: string[];
  type: string;
  value: unknown;
  description?: string;
  modes?: Obj;
}

function flattenW3c(node: Obj, path: string[], inherited: string, out: W3cToken[]) {
  const type = typeof node.$type === "string" ? node.$type : inherited;
  if ("$value" in node) {
    const ext = isObj(node.$extensions) ? node.$extensions : {};
    const modes = isObj(ext.modes) ? ext.modes : isObj(ext.mode) ? ext.mode : undefined;
    out.push({ path, type, value: node.$value, description: typeof node.$description === "string" ? node.$description : undefined, modes });
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$") || !isObj(child)) continue;
    flattenW3c(child, [...path, key], type, out);
  }
}

function fromW3c(input: Obj, opts: NormalizeOptions): TokenSet {
  const warnings: string[] = [];
  const collection = opts.collection || "Tokens";
  const defaultMode = opts.mode || "Default";
  const tokens: W3cToken[] = [];
  flattenW3c(input, [], "", tokens);
  const byPath = new Map(tokens.map((t) => [t.path.join("/"), t]));

  // Composite tokens are styles: their aliases are resolved to literal values here.
  const resolve = (v: unknown, depth = 0): unknown => {
    const alias = aliasOf(v);
    if (!alias || depth > 10) return v;
    const target = byPath.get(alias);
    return target ? resolve(target.value, depth + 1) : v;
  };

  const variables: VariableSpec[] = [];
  const modes = new Set<string>([defaultMode]);
  const styles: TokenSet["styles"] = { colors: [], text: [], effects: [] };

  for (const t of tokens) {
    const name = cleanName(t.path.join("/"));
    const convert = (v: unknown): TokenValue | null => {
      const alias = aliasOf(v);
      if (alias) return { alias: cleanName(alias) };
      switch (t.type) {
        case "color":
          return w3cColor(v);
        case "dimension":
        case "fontSize":
        case "letterSpacing":
        case "lineHeight":
          return dimension(v);
        case "number":
        case "fontWeight":
          return typeof v === "number" ? v : typeof v === "string" ? v : null;
        case "duration":
          return dimension(typeof v === "string" ? v.replace(/ms$/, "") : isObj(v) ? (v.unit === "s" ? v.value * 1000 : v.value) : v);
        case "fontFamily":
          return Array.isArray(v) ? String(v[0]) : typeof v === "string" ? v : null;
        case "boolean":
          return typeof v === "boolean" ? v : null;
        case "string":
          return typeof v === "string" ? v : null;
        default:
          if (typeof v === "number" || typeof v === "boolean") return v;
          if (typeof v === "string") return w3cColor(v) ?? dimension(v) ?? v;
          return null;
      }
    };

    if (t.type === "typography") {
      const v = resolve(t.value);
      if (!isObj(v)) continue;
      const r = (x: unknown) => resolve(x);
      const family = r(v.fontFamily);
      styles.text.push({
        name,
        font: Array.isArray(family) ? String(family[0]) : family,
        weight: r(v.fontWeight),
        size: dimension(r(v.fontSize)) ?? undefined,
        lineHeight: typeof r(v.lineHeight) === "number" ? r(v.lineHeight) : dimension(r(v.lineHeight)) ?? undefined,
        letterSpacing: dimension(r(v.letterSpacing)) ?? undefined,
        description: t.description,
      });
      continue;
    }
    if (t.type === "shadow") {
      const v = resolve(t.value);
      const list = (Array.isArray(v) ? v : [v]).map((x) => resolve(x)).filter(isObj);
      styles.effects.push({
        name,
        value: list.map((s) => ({
          x: dimension(resolve(s.offsetX)) ?? 0,
          y: dimension(resolve(s.offsetY)) ?? 0,
          blur: dimension(resolve(s.blur)) ?? 0,
          spread: dimension(resolve(s.spread)) ?? 0,
          color: w3cColor(resolve(s.color)) ?? "#00000040",
          inner: !!s.inset,
        })),
        description: t.description,
      });
      continue;
    }
    if (t.type === "gradient") {
      const v = resolve(t.value);
      if (!Array.isArray(v)) continue;
      const stops = v.filter(isObj).map((s) => ({ color: w3cColor(resolve(s.color)) ?? "#000000", at: Number(resolve(s.position)) || 0 }));
      styles.colors.push({ name, value: { gradient: stops }, description: t.description });
      continue;
    }
    if (["border", "transition", "cubicBezier", "strokeStyle"].includes(t.type)) {
      warnings.push(`${name}: $type "${t.type}" has no Figma equivalent, skipped`);
      continue;
    }

    const values: Record<string, TokenValue> = {};
    const main = convert(t.value);
    if (main !== null) values[defaultMode] = main;
    for (const [mode, v] of Object.entries(t.modes ?? {})) {
      const out = convert(v);
      if (out !== null) {
        values[mode] = out;
        modes.add(mode);
      }
    }
    if (!Object.keys(values).length) {
      warnings.push(`${name}: unsupported ${t.type || "untyped"} value ${JSON.stringify(t.value)}`);
      continue;
    }
    const type =
      t.type === "color" ? "color" : t.type === "boolean" ? "boolean" : t.type === "string" || t.type === "fontFamily" ? "string" : inferType(Object.values(values));
    variables.push({ name, type, values, description: t.description });
  }
  return { collections: variables.length ? [{ name: collection, modes: [...modes], variables }] : [], styles, warnings };
}

// ─── Tailwind theme ─────────────────────────────────────────────────────────

function tailwindTheme(input: Obj): Obj {
  const theme = isObj(input.theme) ? input.theme : input;
  const extend = isObj(theme.extend) ? theme.extend : {};
  const merged: Obj = {};
  for (const key of TAILWIND_KEYS.concat("fontFamily")) {
    const base = isObj(theme[key]) ? theme[key] : {};
    const more = isObj(extend[key]) ? extend[key] : {};
    merged[key] = { ...base, ...more };
  }
  return merged;
}

const twKey = (k: string) => cleanName(k === "DEFAULT" ? "default" : k);

function fromTailwind(input: Obj, opts: NormalizeOptions): TokenSet {
  const warnings: string[] = [];
  const mode = opts.mode || "Default";
  const theme = tailwindTheme(input);
  const variables: VariableSpec[] = [];
  const add = (name: string, type: VariableSpec["type"], value: TokenValue) => variables.push({ name, type, values: { [mode]: value } });

  const walkColors = (node: Obj, path: string[]) => {
    for (const [k, v] of Object.entries(node)) {
      if (isObj(v)) walkColors(v, [...path, twKey(k)]);
      else if (typeof v === "string") {
        const hex = cssColor(v);
        if (hex) add(["color", ...path, twKey(k)].join("/"), "color", hex);
        else if (!["inherit", "current", "currentColor"].includes(v)) warnings.push(`colors.${[...path, k].join(".")}: unsupported color "${v}"`);
      }
    }
  };
  walkColors(theme.colors, []);

  for (const [k, v] of Object.entries(theme.spacing as Obj)) {
    const px = dimension(v);
    if (px !== null) add(`spacing/${twKey(k)}`, "number", px);
  }
  for (const [k, v] of Object.entries(theme.borderRadius as Obj)) {
    const px = /^9999px$|^50%$/.test(String(v)) ? 9999 : dimension(v);
    if (px !== null) add(`radius/${twKey(k)}`, "number", px);
  }

  const families = theme.fontFamily as Obj;
  const sans = families.sans ?? Object.values(families)[0];
  const font = Array.isArray(sans) ? String(sans[0]) : typeof sans === "string" ? sans.split(",")[0]!.replace(/["']/g, "").trim() : "Inter";
  const text: NamedStyle[] = [];
  for (const [k, v] of Object.entries(theme.fontSize as Obj)) {
    const [size, extra] = Array.isArray(v) ? v : [v, undefined];
    const px = dimension(size);
    if (px === null) continue;
    add(`font-size/${twKey(k)}`, "number", px);
    const lh = isObj(extra) ? extra.lineHeight : typeof extra === "string" ? extra : undefined;
    const lineHeight = lh === undefined ? undefined : /^[\d.]+$/.test(String(lh)) ? Number(lh) : dimension(lh) ?? undefined;
    const ls = isObj(extra) ? extra.letterSpacing : undefined;
    text.push({
      name: `text/${twKey(k)}`,
      font,
      size: px,
      lineHeight,
      letterSpacing: typeof ls === "string" && ls.endsWith("em") ? `${parseFloat(ls) * 100}%` : dimension(ls) ?? undefined,
      weight: isObj(extra) ? extra.fontWeight : undefined,
    });
  }
  return {
    collections: variables.length ? [{ name: opts.collection || "Tailwind", modes: [mode], variables }] : [],
    styles: { colors: [], text, effects: [] },
    warnings,
  };
}

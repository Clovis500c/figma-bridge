// export_code projectPath: the project's existing design tokens (CSS custom properties, Tailwind v4
// @theme, shadcn's HSL/oklch variables, Tailwind v3 config colors), indexed by value so generated code
// can say bg-primary or var(--color-primary) instead of #0D99FF.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssColor } from "../tokens";
import type { Stack } from "./detect";

export interface ProjectToken {
  /** Custom property without "--", e.g. "color-primary"; empty for config-only Tailwind colors. */
  cssVar: string;
  kind: "color" | "length" | "other";
  /** "#RRGGBB[AA]" for colors, px number as text for lengths. */
  value: string;
  /** Tailwind name usable after bg-/text-/border- (colors), p-/gap- (spacing) or rounded- (radius). */
  tw?: string;
  twKind?: "color" | "spacing" | "radius" | "text";
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const hex2 = (n: number) => Math.round(clamp(n) * 255).toString(16).padStart(2, "0").toUpperCase();

/** oklch(L C H [/ a]) → sRGB hex. */
function oklch(l: number, c: number, h: number, a: number): string {
  const hr = (h * Math.PI) / 180;
  return oklab(l, c * Math.cos(hr), c * Math.sin(hr), a);
}

function oklab(L: number, A: number, B: number, alpha: number): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const [r, g, b] = lin.map(gamma) as [number, number, number];
  return "#" + hex2(r) + hex2(g) + hex2(b) + (alpha < 0.999 ? hex2(alpha) : "");
}

const pct = (v: string, scale = 1) => (v.endsWith("%") ? (parseFloat(v) / 100) * scale : parseFloat(v));

/** Any CSS color, plus shadcn's bare "222.2 47.4% 11.2%" HSL triplets → hex, or null. */
export function anyColor(raw: string): string | null {
  const v = raw.trim().replace(/\s*!important$/, "");
  const known = cssColor(v);
  if (known) return known;
  let m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) return oklch(pct(m[1]!), pct(m[2]!, 0.4), parseFloat(m[3]!), m[4] ? pct(m[4]) : 1);
  m = /^oklab\(\s*([\d.]+%?)\s+(-?[\d.]+%?)\s+(-?[\d.]+%?)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) return oklab(pct(m[1]!), pct(m[2]!, 0.4), pct(m[3]!, 0.4), m[4] ? pct(m[4]) : 1);
  m = /^([\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+%?))?$/.exec(v);
  if (m) return cssColor(`hsl(${m[1]}, ${m[2]}%, ${m[3]}%${m[4] ? `, ${m[4]}` : ""})`);
  return null;
}

function length(raw: string): string | null {
  const m = /^(-?[\d.]+)(px|rem)?$/.exec(raw.trim());
  if (!m) return null;
  return String(m[2] === "rem" ? parseFloat(m[1]!) * 16 : parseFloat(m[1]!));
}

const TW4_NAMESPACES: [RegExp, ProjectToken["twKind"]][] = [
  [/^color-(.+)$/, "color"],
  [/^spacing-(.+)$/, "spacing"],
  [/^radius-(.+)$/, "radius"],
  [/^text-([^-]+(?:-[^-]+)*?)$/, "text"],
];

/** --name: value pairs of a stylesheet, with the block they were declared in. */
function declarations(css: string): { name: string; value: string; block: string }[] {
  const out: { name: string; value: string; block: string }[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let b: RegExpExecArray | null;
  while ((b = blockRe.exec(clean))) {
    const selector = b[1]!.trim().split(/\n/).pop()!.trim();
    const declRe = /--([\w-]+)\s*:\s*([^;]+);/g;
    let d: RegExpExecArray | null;
    while ((d = declRe.exec(b[2]!))) out.push({ name: d[1]!, value: d[2]!.trim(), block: selector });
  }
  return out;
}

export class TokenIndex {
  tokens: ProjectToken[] = [];
  sources: string[] = [];

  add(t: ProjectToken) {
    if (!this.tokens.some((x) => x.cssVar === t.cssVar && x.tw === t.tw && x.value === t.value)) this.tokens.push(t);
  }

  get size() {
    return this.tokens.length;
  }

  /** Best token for a color: same hex (alpha included). Theme tokens first, then plain variables. */
  color(hex: string): ProjectToken | null {
    const h = hex.toUpperCase();
    return this.tokens.find((t) => t.kind === "color" && t.value === h && t.tw) ?? this.tokens.find((t) => t.kind === "color" && t.value === h) ?? null;
  }

  /** A Figma variable name ("color/primary") matched to a project token by name. */
  byName(figmaName: string): ProjectToken | null {
    const k = figmaName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const tail = k.replace(/^(colou?rs?|color)-/, "");
    const tests: ((t: ProjectToken) => boolean)[] = [(t) => t.cssVar === k, (t) => t.cssVar === `color-${tail}`, (t) => t.tw === tail, (t) => t.cssVar === tail];
    for (const test of tests) {
      const hit = this.tokens.find((t) => test(t) && t.tw) ?? this.tokens.find(test);
      if (hit) return hit;
    }
    return null;
  }

  length(px: number, kind: "spacing" | "radius"): ProjectToken | null {
    return this.tokens.find((t) => t.twKind === kind && t.value === String(px)) ?? null;
  }
}

export function loadTokens(stack: Stack): TokenIndex {
  const index = new TokenIndex();
  const values = new Map<string, string>();
  const decls: { name: string; value: string; block: string }[] = [];
  for (const file of stack.cssFiles) {
    let css: string;
    try {
      css = readFileSync(join(stack.root, file), "utf8");
    } catch {
      continue;
    }
    const found = declarations(css);
    if (found.length) index.sources.push(file);
    decls.push(...found);
  }
  // Light (default) values win: dark-mode blocks only fill names that have no default.
  const isDark = (block: string) => /dark/i.test(block);
  for (const d of decls) if (!values.has(d.name) || !isDark(d.block)) values.set(d.name, d.value);
  const resolve = (v: string, depth = 0): string => {
    const m = /^var\(--([\w-]+)(?:\s*,\s*(.+))?\)$/.exec(v.trim());
    if (!m || depth > 6) return v;
    const target = values.get(m[1]!);
    return target !== undefined ? resolve(target, depth + 1) : m[2] ? resolve(m[2], depth + 1) : v;
  };
  const shadcnHsl = stack.ui.includes("shadcn") && stack.tailwind === 3;
  for (const [name, raw] of values) {
    const value = resolve(raw);
    const color = anyColor(value.replace(/^hsl\(var\(--[\w-]+\)\)$/, ""));
    const len = color ? null : length(value);
    const token: ProjectToken = { cssVar: name, kind: color ? "color" : len ? "length" : "other", value: color ?? len ?? value };
    // Tailwind v4: --color-x, --spacing-x, --radius-x and --text-x are theme keys.
    if (stack.tailwind === 4) {
      for (const [re, kind] of TW4_NAMESPACES) {
        const m = re.exec(name);
        if (m && !/--/.test(name)) {
          token.tw = m[1];
          token.twKind = kind;
        }
      }
    }
    // shadcn on Tailwind v3 maps every --x color variable to a theme color of the same name.
    if (shadcnHsl && color) {
      token.tw = name;
      token.twKind = "color";
    }
    if (token.kind !== "other") index.add(token);
  }
  if (stack.tailwind === 3 && stack.tailwindConfig) {
    try {
      for (const t of tailwind3Colors(readFileSync(join(stack.root, stack.tailwindConfig), "utf8"))) index.add(t);
      index.sources.push(stack.tailwindConfig);
    } catch {}
  }
  return index;
}

/** Literal colors in a Tailwind v3 config's theme.colors / theme.extend.colors (read, never executed). */
export function tailwind3Colors(config: string): ProjectToken[] {
  const out: ProjectToken[] = [];
  const start = /colors\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(config))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const begin = i;
    while (i < config.length && depth) {
      if (config[i] === "{") depth++;
      else if (config[i] === "}") depth--;
      i++;
    }
    walk(config.slice(begin, i - 1), []);
  }
  function walk(body: string, path: string[]) {
    const re = /["']?([\w-]+)["']?\s*:\s*(\{|["'`]([^"'`]+)["'`])/g;
    let e: RegExpExecArray | null;
    while ((e = re.exec(body))) {
      if (e[2] === "{") {
        let depth = 1;
        let i = e.index + e[0].length;
        const begin = i;
        while (i < body.length && depth) {
          if (body[i] === "{") depth++;
          else if (body[i] === "}") depth--;
          i++;
        }
        walk(body.slice(begin, i - 1), [...path, e[1]!]);
        re.lastIndex = i;
        continue;
      }
      const hex = anyColor(e[3]!);
      if (!hex) continue;
      const key = e[1] === "DEFAULT" ? path.join("-") : [...path, e[1]!].join("-");
      out.push({ cssVar: "", kind: "color", value: hex, tw: key, twKind: "color" });
    }
  }
  return out;
}

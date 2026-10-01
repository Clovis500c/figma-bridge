// import_web: maps CSS font stacks to fonts installed in Figma, and weights to style names.

export interface FigmaFamily {
  family: string;
  styles: string[];
}

export interface FontChoice {
  family: string;
  style: string;
  /** The web font that was asked for, when another family had to be used. */
  substituted?: string;
}

const GENERIC: Record<string, string[]> = {
  "sans-serif": ["Inter", "Roboto", "Arial", "Helvetica"],
  "system-ui": ["Inter", "SF Pro Text", "Segoe UI", "Roboto", "Arial"],
  "-apple-system": ["SF Pro Text", "Inter", "Roboto", "Arial"],
  blinkmacsystemfont: ["SF Pro Text", "Inter", "Roboto", "Arial"],
  "ui-sans-serif": ["Inter", "Roboto", "Arial"],
  serif: ["Georgia", "Times New Roman", "Noto Serif", "Merriweather"],
  "ui-serif": ["Georgia", "Times New Roman", "Noto Serif"],
  monospace: ["Roboto Mono", "JetBrains Mono", "Source Code Pro", "Courier New"],
  "ui-monospace": ["SF Mono", "Roboto Mono", "JetBrains Mono", "Courier New"],
  cursive: ["Comic Sans MS", "Inter"],
  fantasy: ["Impact", "Inter"],
};

const STYLE_WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/, 100],
  [/(extra|ultra)[\s-]?light/, 200],
  [/light/, 300],
  [/(semi|demi)[\s-]?bold/, 600],
  [/(extra|ultra)[\s-]?bold/, 800],
  [/black|heavy/, 900],
  [/bold/, 700],
  [/medium/, 500],
];

export function styleWeight(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase();
  const hit = STYLE_WEIGHTS.find(([re]) => re.test(s));
  return { weight: hit ? hit[1] : 400, italic: /italic|oblique/.test(s) };
}

/** The installed style closest to a CSS weight, preferring the same slant. */
export function closestStyle(styles: string[], weight: number, italic: boolean): string {
  let best = styles[0] ?? "Regular";
  let score = Infinity;
  for (const s of styles) {
    const w = styleWeight(s);
    // Ties go to the heavier style for bold text and the lighter one otherwise, like browsers do.
    const d = Math.abs(w.weight - weight) + (w.italic !== italic ? 1000 : 0) + (w.weight > weight === weight >= 500 ? 0 : 0.5);
    if (d < score) {
      score = d;
      best = s;
    }
  }
  return best;
}

export class FontIndex {
  private byName = new Map<string, FigmaFamily>();

  constructor(families: FigmaFamily[]) {
    for (const f of families) this.byName.set(f.family.toLowerCase(), f);
  }

  get size() {
    return this.byName.size;
  }

  has(family: string) {
    return this.byName.has(family.toLowerCase());
  }

  /** First family of the stack that Figma has; generic families map to common installed fonts. */
  resolve(stack: string, weight: number, italic: boolean): FontChoice {
    const names = stack
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    const wanted = names[0] ?? "sans-serif";
    const generic = (n: string) => GENERIC[n.toLowerCase()] !== undefined;
    for (const n of names) {
      const candidates = GENERIC[n.toLowerCase()] ?? [n];
      for (const c of candidates) {
        const f = this.byName.get(c.toLowerCase());
        if (!f) continue;
        const out: FontChoice = { family: f.family, style: closestStyle(f.styles, weight, italic) };
        if (n !== wanted && !generic(wanted)) out.substituted = wanted;
        return out;
      }
    }
    const fallback = this.byName.get("inter") ?? this.byName.values().next().value;
    const out: FontChoice = fallback ? { family: fallback.family, style: closestStyle(fallback.styles, weight, italic) } : { family: "Inter", style: "Regular" };
    if (!generic(wanted)) out.substituted = wanted;
    return out;
  }
}

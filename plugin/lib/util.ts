// Shared helpers for the plugin main thread.
// Syntax stays ES2017 (no ?. ?? object spread or optional catch binding): the sandbox parser is conservative.

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function codeError(message: string, code: string): Error {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

// ─── Cancellation (Cancel button in the plugin UI) ──────────────────────────

const cancelled: { [requestId: string]: boolean } = {};

export function markCancelled(id: string) {
  cancelled[id] = true;
}

export function clearCancelled(id: string) {
  delete cancelled[id];
}

/** Long commands check this between steps; run_script cannot be interrupted. */
export function checkCancelled(id?: string) {
  if (id && cancelled[id]) throw codeError("Cancelled from the Figma plugin", "CANCELLED");
}

// ─── Colors ─────────────────────────────────────────────────────────────────

export function parseHex(hex: string): RGBA {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) {
    h = h
      .split("")
      .map(function (c) {
        return c + c;
      })
      .join("");
  }
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw codeError("Invalid hex color: " + hex, "BAD_ARGS");
  const n = function (i: number) {
    return parseInt(h.slice(i, i + 2), 16) / 255;
  };
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

export function toHex(c: RGB | RGBA, opacity?: number): string {
  const part = function (v: number) {
    const s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
    return s.length === 1 ? "0" + s : s;
  };
  const a = (c as RGBA).a === undefined ? 1 : (c as RGBA).a;
  const alpha = a * (opacity === undefined ? 1 : opacity);
  return ("#" + part(c.r) + part(c.g) + part(c.b) + (alpha < 0.999 ? part(alpha) : "")).toUpperCase();
}

/** WCAG relative luminance. */
export function luminance(c: RGB): number {
  const ch = function (v: number) {
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ─── Nodes ──────────────────────────────────────────────────────────────────

export async function getNode(id: string): Promise<BaseNode> {
  const node = await figma.getNodeByIdAsync(String(id));
  if (!node) throw codeError("Node not found: " + id, "NOT_FOUND");
  return node;
}

export async function parentFor(parentId?: string): Promise<BaseNode & ChildrenMixin> {
  if (!parentId) return figma.currentPage;
  const parent: any = await getNode(parentId);
  if (!("appendChild" in parent)) throw codeError("Node " + parentId + " (" + parent.type + ") cannot have children", "BAD_ARGS");
  return parent;
}

/** Positions a node at x/y, or centered in the viewport when both are missing. */
export function place(node: SceneNode, x?: number, y?: number) {
  const c = figma.viewport.center;
  node.x = typeof x === "number" ? x : Math.round(c.x - node.width / 2);
  node.y = typeof y === "number" ? y : Math.round(c.y - node.height / 2);
}

export function isAutoLayout(node: any): boolean {
  return !!node && "layoutMode" in node && node.layoutMode !== "NONE";
}

export function isNode(v: any): boolean {
  return v && typeof v === "object" && typeof v.id === "string" && typeof v.type === "string" && "removed" in v;
}

// ─── JSON-safe results ──────────────────────────────────────────────────────

/** Converts script results to plain JSON-safe data (nodes → {id,name,type}). */
export function toSafe(v: any, depth: number, seen: any[]): any {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "number") return isFinite(v) ? v : String(v);
  if (t === "string" || t === "boolean") return v;
  if (t === "bigint" || t === "symbol") return String(v);
  if (t === "function") return "[Function]";
  if (v instanceof Uint8Array) return { type: "Uint8Array", length: v.length };
  if (isNode(v)) return v.removed ? { id: v.id, removed: true } : { id: v.id, name: v.name, type: v.type };
  if (v instanceof Error) return { error: v.message };
  if (depth > 12) return "[MaxDepth]";
  if (seen.indexOf(v) !== -1) return "[Circular]";
  seen.push(v);
  let out: any;
  if (Array.isArray(v)) {
    out = v.slice(0, 5000).map(function (x) {
      return toSafe(x, depth + 1, seen);
    });
    if (v.length > 5000) out.push("… " + (v.length - 5000) + " more");
  } else if (v instanceof Map) {
    out = {};
    v.forEach(function (val: any, key: any) {
      out[String(key)] = toSafe(val, depth + 1, seen);
    });
  } else if (v instanceof Set) {
    out = toSafe(Array.from(v), depth + 1, seen);
  } else {
    out = {};
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) out[keys[i]] = toSafe(v[keys[i]], depth + 1, seen);
  }
  seen.pop();
  return out;
}

export function safeStringify(v: any): string {
  try {
    return JSON.stringify(toSafe(v, 0, []));
  } catch (e) {
    return String(v);
  }
}

// ─── Fonts ──────────────────────────────────────────────────────────────────

const WEIGHTS: { [w: string]: string } = {
  "100": "Thin",
  "200": "Extra Light",
  "300": "Light",
  "400": "Regular",
  "500": "Medium",
  "600": "Semi Bold",
  "700": "Bold",
  "800": "Extra Bold",
  "900": "Black",
};

/** "Inter:Bold", "Inter", {family, style} or a weight number/name → FontName. */
export function parseFont(font: any, weight?: any, fallbackFamily?: string): FontName {
  let family = fallbackFamily || "Inter";
  let style = "Regular";
  if (typeof font === "string" && font) {
    const i = font.indexOf(":");
    family = i === -1 ? font : font.slice(0, i);
    if (i !== -1) style = font.slice(i + 1);
  } else if (font && typeof font.family === "string") {
    family = font.family;
    style = font.style || "Regular";
  }
  if (weight !== undefined && weight !== null) style = WEIGHTS[String(weight)] || String(weight);
  return { family: family, style: style };
}

const fontLoads: { [key: string]: Promise<void> } = {};

export function loadFont(n: FontName): Promise<void> {
  const key = n.family + "\u0000" + n.style;
  if (!fontLoads[key]) {
    fontLoads[key] = figma.loadFontAsync(n).catch(function (e) {
      delete fontLoads[key];
      throw codeError('Font "' + n.family + " " + n.style + '" is not available: ' + (e && e.message ? e.message : e), "FONT");
    });
  }
  return fontLoads[key];
}

export function fontNamesOf(f: any): FontName[] {
  if (typeof f === "string" || (f && typeof f.family === "string")) return [parseFont(f)];
  if (isNode(f) && f.type === "TEXT") {
    const text = f as TextNode;
    if (text.characters.length) return text.getRangeAllFontNames(0, text.characters.length);
    return text.fontName === figma.mixed ? [] : [text.fontName as FontName];
  }
  if (Array.isArray(f)) {
    let all: FontName[] = [];
    for (let i = 0; i < f.length; i++) all = all.concat(fontNamesOf(f[i]));
    return all;
  }
  throw codeError("loadFonts: expected 'Family:Style', FontName or TextNode, got " + safeStringify(f), "BAD_ARGS");
}

// ─── Styles and variables (cached per request burst) ────────────────────────

let styleCache: { at: number; paint: PaintStyle[]; text: TextStyle[]; effect: EffectStyle[] } | null = null;
let variableCache: { at: number; vars: Variable[]; collections: VariableCollection[] } | null = null;
const CACHE_MS = 5000;

export async function localStyles() {
  if (!styleCache || Date.now() - styleCache.at > CACHE_MS) {
    const res = await Promise.all([figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync()]);
    styleCache = { at: Date.now(), paint: res[0], text: res[1], effect: res[2] };
  }
  return styleCache;
}

export async function localVariables() {
  if (!variableCache || Date.now() - variableCache.at > CACHE_MS) {
    const res = await Promise.all([figma.variables.getLocalVariablesAsync(), figma.variables.getLocalVariableCollectionsAsync()]);
    variableCache = { at: Date.now(), vars: res[0], collections: res[1] };
  }
  return variableCache;
}

export function invalidateCaches() {
  styleCache = null;
  variableCache = null;
}

// ─── Responsiveness ─────────────────────────────────────────────────────────

// The plugin shares Figma's thread: long synchronous work freezes the canvas until it ends.
// Measured on a 2000-layer build: a yield every 250 ms costs nothing; every 100 ms costs ~10% (Figma
// relayouts the growing tree at each yield). Hiding the tree while it builds did not help.
const BREATH_MS = 250;
let lastBreath = Date.now();

/** Starts a command's busy clock (the idle time before it is not work). */
export function markBusy() {
  lastBreath = Date.now();
}

/** Yields one macrotask to Figma after 250 ms of work, so it repaints and takes input; free in between. */
export function breathe(): Promise<void> {
  if (Date.now() - lastBreath < BREATH_MS) return Promise.resolve();
  return new Promise(function (resolve) {
    setTimeout(function () {
      lastBreath = Date.now();
      resolve();
    }, 0);
  });
}

/** Finds a variable by "name" or "Collection/name". */
export async function findVariable(ref: string): Promise<Variable> {
  const cache = await localVariables();
  const byId: { [id: string]: string } = {};
  for (let i = 0; i < cache.collections.length; i++) byId[cache.collections[i].id] = cache.collections[i].name;
  for (let i = 0; i < cache.vars.length; i++) {
    const v = cache.vars[i];
    if (v.name === ref || byId[v.variableCollectionId] + "/" + v.name === ref) return v;
  }
  throw codeError('Variable not found: "' + ref + '". Use get_design_system to list them.', "NOT_FOUND");
}

export async function findStyle(kind: "paint" | "text" | "effect", name: string): Promise<BaseStyle> {
  const cache = await localStyles();
  const list: BaseStyle[] = kind === "paint" ? cache.paint : kind === "text" ? cache.text : cache.effect;
  for (let i = 0; i < list.length; i++) if (list[i].name === name || list[i].id === name) return list[i];
  throw codeError("No local " + kind + ' style named "' + name + '". Use get_design_system to list them.', "NOT_FOUND");
}

const styleNames: { [id: string]: string } = {};

export async function styleName(id: any): Promise<string | null> {
  if (!id || typeof id !== "string") return null;
  if (styleNames[id] === undefined) {
    const s = await figma.getStyleByIdAsync(id);
    styleNames[id] = s ? s.name : "";
  }
  return styleNames[id] || null;
}

// ─── Components index (needs all pages loaded) ──────────────────────────────

let componentCache: { at: number; list: (ComponentNode | ComponentSetNode)[] } | null = null;

export async function localComponents(): Promise<(ComponentNode | ComponentSetNode)[]> {
  if (!componentCache || Date.now() - componentCache.at > 15000) {
    await figma.loadAllPagesAsync();
    const all = figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] }) as (ComponentNode | ComponentSetNode)[];
    const list = all.filter(function (n) {
      return !(n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET");
    });
    componentCache = { at: Date.now(), list: list };
  }
  return componentCache.list;
}

export function pageOf(node: BaseNode): PageNode | null {
  let p: BaseNode | null = node;
  while (p && p.type !== "PAGE") p = p.parent;
  return p as PageNode | null;
}

// ─── Color difference (CIEDE2000) ───────────────────────────────────────────

function toLab(c: RGB): number[] {
  const lin = function (v: number) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = lin(c.r);
  const g = lin(c.g);
  const b = lin(c.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = function (t: number) {
    return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  };
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Perceptual distance between two colors; below 2 is hard to tell apart. */
export function deltaE(a: RGB, b: RGB): number {
  const l1 = toLab(a);
  const l2 = toLab(b);
  const rad = Math.PI / 180;
  const c1 = Math.sqrt(l1[1] * l1[1] + l1[2] * l1[2]);
  const c2 = Math.sqrt(l2[1] * l2[1] + l2[2] * l2[2]);
  const cm = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(Math.pow(cm, 7) / (Math.pow(cm, 7) + Math.pow(25, 7))));
  const a1 = l1[1] * (1 + g);
  const a2 = l2[1] * (1 + g);
  const cp1 = Math.sqrt(a1 * a1 + l1[2] * l1[2]);
  const cp2 = Math.sqrt(a2 * a2 + l2[2] * l2[2]);
  const hue = function (x: number, y: number) {
    if (x === 0 && y === 0) return 0;
    const h = Math.atan2(y, x) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1 = hue(a1, l1[2]);
  const h2 = hue(a2, l2[2]);
  const dl = l2[0] - l1[0];
  const dc = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * rad);
  const lm = (l1[0] + l2[0]) / 2;
  const cpm = (cp1 + cp2) / 2;
  let hm = h1 + h2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(h1 - h2) > 180) hm += h1 + h2 < 360 ? 360 : -360;
    hm /= 2;
  }
  const t = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const sl = 1 + (0.015 * Math.pow(lm - 50, 2)) / Math.sqrt(20 + Math.pow(lm - 50, 2));
  const sc = 1 + 0.045 * cpm;
  const sh = 1 + 0.015 * cpm * t;
  const rt = -2 * Math.sqrt(Math.pow(cpm, 7) / (Math.pow(cpm, 7) + Math.pow(25, 7))) * Math.sin(60 * Math.exp(-Math.pow((hm - 275) / 25, 2)) * rad);
  return Math.sqrt(Math.pow(dl / sl, 2) + Math.pow(dc / sc, 2) + Math.pow(dH / sh, 2) + rt * (dc / sc) * (dH / sh));
}

// export_roblox: maps the layer tree from the plugin to a Roblox instance tree (ScreenGui → Frames,
// TextLabels, ImageLabels with UI modifiers). Native Roblox UI wherever it can match the design; pictures
// (rasterized at 2×) for what Roblox can't draw. docs/roblox.md describes every rule.
import { endsWithWord, inferRoles, pascalName, ROLE_WORDS, type RoleNode, uniqueSiblingNames } from "../../plugin/lib/naming";
import { robloxFamily, robloxWeight } from "./fonts";

// ─── Input (plugin) ─────────────────────────────────────────────────────────

export interface RPaint {
  type: string;
  opacity: number;
  color?: string;
  angle?: number;
  stops?: { color: string; alpha: number; at: number }[];
  imageHash?: string;
  scaleMode?: string;
}
export interface REffect {
  type: string;
  x?: number;
  y?: number;
  blur: number;
  spread?: number;
  color?: string;
  alpha?: number;
}
export interface RSegment {
  text: string;
  family: string;
  style: string;
  weight: number;
  size: number;
  color?: string;
  alpha?: number;
  decoration?: string;
  textCase?: string;
  letterSpacing?: number;
  lineHeight?: number;
}
export interface RNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hidden?: boolean;
  opacity?: number;
  rotation?: number;
  clip?: boolean;
  constraints?: { h: string; v: string };
  absolute?: boolean;
  grow?: boolean;
  stretch?: boolean;
  sizing?: { h: string; v: string };
  render?: { x: number; y: number; w: number; h: number };
  fills?: RPaint[];
  strokes?: RPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  dashed?: boolean;
  radius?: number[];
  effects?: REffect[];
  clickable?: boolean;
  vector?: boolean;
  /** The plugin could not read an image fill: picture the layer as it looks. */
  rasterize?: boolean;
  text?: { characters: string; align: string; valign: string; autoResize: string; maxLines: number; segments: RSegment[] };
  layout?: { mode: string; padding: number[]; gap: number; primary: string; counter: string; wrap?: boolean; counterGap?: number; columns?: number; rows?: number; columnGap?: number; rowGap?: number };
  children?: RNode[];
}

// ─── Output (Roblox) ────────────────────────────────────────────────────────

export type RbxValue =
  | { t: "string"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: number }
  | { t: "float"; v: number }
  | { t: "Color3"; r: number; g: number; b: number }
  | { t: "UDim"; s: number; o: number }
  | { t: "UDim2"; xs: number; xo: number; ys: number; yo: number }
  | { t: "Vector2"; x: number; y: number }
  | { t: "Rect"; x0: number; y0: number; x1: number; y1: number }
  | { t: "enum"; e: string; v: string }
  | { t: "Content"; url: string }
  | { t: "ColorSequence"; keys: { time: number; r: number; g: number; b: number }[] }
  | { t: "NumberSequence"; keys: { time: number; value: number }[] }
  | { t: "Font"; family: string; weight: number; weightName: string; style: "Normal" | "Italic" };

export interface RbxInstance {
  className: string;
  name: string;
  props: [string, RbxValue][];
  children: RbxInstance[];
  /** Figma layer it comes from (comments in Luau, asset lookups). */
  source?: string;
}

export interface RobloxOptions {
  /** scale (default): no offsets at all; offset: pixels; hybrid: pixels inside auto-layout. */
  mode: "scale" | "offset" | "hybrid";
  targetResolution: [number, number];
  rasterize: "auto" | "none" | "all";
  asRootFrame?: boolean;
  textScaled?: boolean;
  /** Figma family → Roblox family name or rbxasset URL. */
  fonts?: Record<string, string>;
  /** Picture scale (default 2). */
  scale?: number;
}

/** A picture to take in Figma: "full" (as it looks), "panel" (own fill and stroke, for a 9-slice background). */
export interface PictureRequest {
  id: string;
  mode: "full" | "panel";
}

/** Asset reference resolved by the caller: picture key `${id}:${mode}` or `image:${hash}` → URL and picture geometry. */
export interface AssetRef {
  url: string;
  /** Picture bounds relative to the layer box, in design px. */
  offset?: { x: number; y: number };
  size?: { w: number; h: number };
  /** Picture pixels per design px (pictures are kept under Roblox's 1024 px limit). */
  scale?: number;
  /** The picture's size in pixels. */
  px?: { w: number; h: number };
}

const num = (v: number) => Math.round(v * 10000) / 10000;
const S = (v: string): RbxValue => ({ t: "string", v });
const B = (v: boolean): RbxValue => ({ t: "bool", v });
const I = (v: number): RbxValue => ({ t: "int", v: Math.round(v) });
const F = (v: number): RbxValue => ({ t: "float", v: num(v) });
const E = (e: string, v: string): RbxValue => ({ t: "enum", e, v });
const U = (s: number, o: number): RbxValue => ({ t: "UDim", s: num(s), o: Math.round(o) });
const U2 = (xs: number, xo: number, ys: number, yo: number): RbxValue => ({ t: "UDim2", xs: num(xs), xo: Math.round(xo), ys: num(ys), yo: Math.round(yo) });
const V2 = (x: number, y: number): RbxValue => ({ t: "Vector2", x: num(x), y: num(y) });

export function color3(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const c = (i: number) => num(parseInt(h.slice(i, i + 2), 16) / 255);
  return { r: c(0), g: c(2), b: c(4) };
}
const C3 = (hex: string): RbxValue => ({ t: "Color3", ...color3(hex) });


// Layers that act as buttons by their name: "Buy button", "Close", "Back"...
const BUTTON_NAME = /button|btn|\bcta\b|^(close|back|buy|confirm|cancel|next|previous|prev|exit|play|claim|equip|purchase)$/i;
const VECTOR_TYPES = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"];
const ICON_WORDS = ["Icon", "Logo", "Image", "Illustration", "Avatar", "Emoji"];
const IMAGE_WORDS = ["Image", "Icon", "Avatar", "Logo", "Thumbnail", "Picture", "Photo", "Banner", "Background", "Illustration", "Art", "Cover"];

// ─── Decisions shared by both passes ────────────────────────────────────────

type Kind = "text" | "image" | "picture" | "panel" | "frame";

interface Decision {
  kind: Kind;
  approximations: string[];
}

function visible(list?: RPaint[]) {
  return (list ?? []).filter((p) => p.opacity > 0);
}

export function decide(n: RNode, opts: RobloxOptions): Decision {
  const approximations: string[] = [];
  if (n.text) return { kind: "text", approximations };
  const raster = opts.rasterize;
  const fills = visible(n.fills);
  const strokes = visible(n.strokes);
  // Drop shadows are native (UIShadow); other effects are not.
  const other = (n.effects ?? []).filter((e) => e.type !== "DROP_SHADOW");
  const hasChildren = !!n.children?.some((c) => !c.hidden);

  if (n.rasterize && raster !== "none") return { kind: "picture", approximations: ["image file unreadable: pictured as it looks"] };
  if (n.vector || VECTOR_TYPES.includes(n.type)) {
    return raster === "none" ? { kind: "frame", approximations: ["vector shape skipped (rasterize is none)"] } : { kind: "picture", approximations };
  }
  const image = fills.length === 1 && fills[0]!.type === "IMAGE";
  if (image && !hasChildren && !strokes.length && !other.length && raster !== "all") return { kind: "image", approximations };

  // What Roblox draws natively: one solid or linear-gradient fill, one solid stroke, corners, drop shadows.
  const reasons: string[] = [];
  if (fills.length > 1) reasons.push("several fills");
  if (fills.length === 1 && !["SOLID", "GRADIENT_LINEAR", "IMAGE"].includes(fills[0]!.type)) reasons.push(`${fills[0]!.type.toLowerCase().replace("_", " ")} fill`);
  if (image && (strokes.length || other.length)) reasons.push("image with stroke or effects");
  if (strokes.length > 1 || (strokes[0] && strokes[0].type !== "SOLID")) reasons.push("complex stroke");
  if (n.dashed) reasons.push("dashed stroke");
  if (other.length) reasons.push(other.map((e) => e.type.toLowerCase().replace(/_/g, " ")).join(", "));
  if (n.type === "ELLIPSE" && Math.abs(n.w - n.h) > 0.5) reasons.push("oval");
  const styled = fills.length + strokes.length + (n.effects ?? []).length > 0;
  if ((reasons.length || (raster === "all" && styled)) && raster !== "none") {
    return { kind: hasChildren ? "panel" : "picture", approximations };
  }
  if (reasons.length) approximations.push(`${reasons.join(", ")}: approximated (rasterize is none)`);
  const r = n.radius ?? [];
  if (r.length && r.some((v) => Math.abs(v - r[0]!) > 0.5)) approximations.push("different corner radii: used the largest");
  return { kind: "frame", approximations };
}

/** Every picture the export needs, so the caller can take them in one plugin call. */
export function pictureRequests(root: RNode, opts: RobloxOptions): PictureRequest[] {
  const out: PictureRequest[] = [];
  const walk = (n: RNode) => {
    if (n.hidden) return;
    const d = decide(n, opts);
    if (d.kind === "picture") out.push({ id: n.id, mode: "full" });
    if (d.kind === "panel") out.push({ id: n.id, mode: "panel" });
    if (d.kind !== "picture") for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

export function imageHashes(root: RNode): string[] {
  const out = new Set<string>();
  const walk = (n: RNode) => {
    for (const f of n.fills ?? []) if (f.imageHash) out.add(f.imageHash);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return [...out];
}

// ─── Names ──────────────────────────────────────────────────────────────────

type Flavor = "text" | "button" | "icon" | "image" | "container" | "frame";

/** Roblox-style instance name: PascalCase, ending with what the instance is (TitleLabel, BuyButton, CoinIcon, ShopFrame). */
export function robloxName(base: string, flavor: Flavor): string {
  switch (flavor) {
    case "text":
      return /Label$/.test(base) ? base : `${base}Label`;
    case "button": {
      const b = base.replace(/Btn$/, "Button");
      return /Button$/.test(b) ? b : `${b}Button`;
    }
    case "icon":
      return endsWithWord(base, ICON_WORDS) ? base : `${base}Icon`;
    case "image":
      return endsWithWord(base, IMAGE_WORDS) ? base : `${base}Image`;
    default:
      return endsWithWord(base, ROLE_WORDS) ? base : `${base}${flavor === "frame" ? "Frame" : "Container"}`;
  }
}

function roleTree(n: RNode): RoleNode & { id: string } {
  const fills = visible(n.fills);
  const kind: RoleNode["kind"] = n.text
    ? "text"
    : n.vector || VECTOR_TYPES.includes(n.type)
      ? "vector"
      : fills.length === 1 && fills[0]!.type === "IMAGE" && !n.children?.length
        ? "image"
        : n.children?.length || n.layout
          ? "frame"
          : "shape";
  return {
    id: n.id,
    kind,
    name: n.name,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    hidden: n.hidden,
    text: n.text?.characters,
    fontSize: n.text ? Math.max(0, ...n.text.segments.map((s) => s.size)) : undefined,
    layout: n.layout?.mode,
    wrap: n.layout?.wrap,
    background: fills.length > 0 || visible(n.strokes).length > 0,
    radius: Math.max(0, ...(n.radius ?? [])),
    ellipse: n.type === "ELLIPSE",
    clickable: n.clickable,
    absolute: n.absolute,
    children: (n.children ?? []).map(roleTree),
  };
}

/** Numbers instances that share a name under the same parent (Card1, Card2), modifiers aside. */
function dedupe(i: RbxInstance) {
  const layers = i.children.filter((c) => !/^UI/.test(c.className));
  const names = uniqueSiblingNames(layers.map((c) => c.name));
  layers.forEach((c, k) => {
    c.name = names[k]!;
    c.props[0] = ["Name", S(c.name)];
  });
  for (const c of i.children) dedupe(c);
}

// ─── Mapping ────────────────────────────────────────────────────────────────

interface Parent {
  w: number;
  h: number;
  layout?: RNode["layout"];
}

class Mapper {
  warnings = new Set<string>();
  fontSubstitutions = new Map<string, string>();
  counts = { instances: 0, pictures: 0, skippedHidden: 0 };
  private textFactor = 1;
  /** Layer id → PascalCase name (the layer's own, or its role when Figma named it). */
  private names = new Map<string, string>();
  private roles = new Map<string, string>();

  constructor(
    private opts: RobloxOptions,
    private assets: (key: string) => AssetRef | undefined,
  ) {}

  /** Scale mode: every size, position, padding, gap, radius, stroke and shadow is relative; no offsets. */
  private get scaleOnly() {
    return this.opts.mode === "scale";
  }

  warn(n: RNode | null, msg: string) {
    if (this.warnings.size < 60) this.warnings.add(n ? `${n.name}: ${msg}` : msg);
  }

  private nameLayers(root: RNode) {
    const tree = roleTree(root);
    inferRoles(tree);
    const walk = (r: RoleNode & { id: string }) => {
      const base = pascalName(r.role ?? r.name) || pascalName(r.role ?? "") || "Layer";
      this.names.set(r.id, base);
      if (r.role) this.roles.set(r.id, r.role);
      for (const c of r.children) walk(c as RoleNode & { id: string });
    };
    walk(tree);
  }

  private label(n: RNode, flavor: Flavor): string {
    return robloxName(this.names.get(n.id) ?? (pascalName(n.name) || "Layer"), flavor);
  }

  private isButton(n: RNode) {
    return !!n.clickable || BUTTON_NAME.test(n.name) || this.roles.get(n.id) === "Button";
  }

  map(root: RNode): RbxInstance {
    this.nameLayers(root);
    const [tw, th] = this.opts.targetResolution;
    const fullScreen = Math.abs(root.w / root.h - tw / th) < 0.1 * (tw / th) && root.w >= tw * 0.4;
    // A screen designed at another size: text grows or shrinks with it (scale and hybrid modes).
    if (fullScreen && this.opts.mode !== "offset") this.textFactor = tw / root.w;
    const top = this.node(root, null, 0)!;
    // The root: centered, keeping its proportions.
    const geo: [string, RbxValue][] =
      this.opts.mode === "offset"
        ? [["AnchorPoint", V2(0.5, 0.5)], ["Position", U2(0.5, 0, 0.5, 0)], ["Size", U2(0, root.w, 0, root.h)]]
        : fullScreen
          ? [["AnchorPoint", V2(0.5, 0.5)], ["Position", U2(0.5, 0, 0.5, 0)], ["Size", U2(1, 0, 1, 0)]]
          : [["AnchorPoint", V2(0.5, 0.5)], ["Position", U2(0.5, 0, 0.5, 0)], ["Size", U2(root.w / tw, 0, root.h / th, 0)]];
    top.props = top.props.filter(([k]) => !["AnchorPoint", "Position", "Size", "LayoutOrder", "ZIndex", "AutomaticSize"].includes(k));
    top.props.splice(1, 0, ...geo);
    // Not full screen: sized from the screen height (on phones the width varies most); the width follows the design ratio.
    const ratio: [string, RbxValue][] = [["AspectRatio", F(root.w / root.h)]];
    if (this.opts.mode !== "offset" && !fullScreen) ratio.push(["DominantAxis", E("DominantAxis", "Height")]);
    top.children.push(this.inst("UIAspectRatioConstraint", "UIAspectRatioConstraint", ratio));
    const out = this.opts.asRootFrame
      ? top
      : this.inst("ScreenGui", `${(this.names.get(root.id) ?? "Ui").replace(/Gui$/, "")}Gui`, [["ResetOnSpawn", B(false)], ["ZIndexBehavior", E("ZIndexBehavior", "Sibling")], ["IgnoreGuiInset", B(true)]], [top]);
    dedupe(out);
    return out;
  }

  private inst(className: string, name: string, props: [string, RbxValue][] = [], children: RbxInstance[] = [], source?: string): RbxInstance {
    this.counts.instances++;
    return { className, name, props: [["Name", S(name)], ...props], children, ...(source ? { source } : {}) };
  }

  /** Whether the layer is placed with scale, and the box that scale is relative to (the parent's content box in a layout). */
  private frameOf(n: RNode, parent: Parent): { scale: boolean; w: number; h: number; inFlow: boolean } {
    const inFlow = !!parent.layout && !n.absolute;
    const scale = this.opts.mode === "scale" || (this.opts.mode === "hybrid" && !inFlow);
    if (!inFlow) return { scale, w: Math.max(1, parent.w), h: Math.max(1, parent.h), inFlow };
    const p = parent.layout!.padding;
    return { scale, w: Math.max(1, parent.w - (p[1] ?? 0) - (p[3] ?? 0)), h: Math.max(1, parent.h - (p[0] ?? 0) - (p[2] ?? 0)), inFlow };
  }

  private hugs(n: RNode, d: Decision): { w: boolean; h: boolean } {
    // Scale mode keeps the designed proportions instead of sizing from content (AutomaticSize is pixels).
    if (this.scaleOnly) return { w: false, h: false };
    const content = d.kind === "text" || !!n.layout;
    return { w: n.sizing?.h === "HUG" && content, h: n.sizing?.v === "HUG" && content };
  }

  /** Size and position from the parent's layout or the layer's constraints. */
  private geometry(n: RNode, parent: Parent | null, index: number, d: Decision): [string, RbxValue][] {
    const out: [string, RbxValue][] = [];
    if (!parent) return out;
    const f = this.frameOf(n, parent);
    const hug = this.hugs(n, d);
    if (f.inFlow) {
      const horizontal = parent.layout!.mode === "HORIZONTAL";
      // Cross-axis fill stretches (scale 1); main-axis fill is a UIFlexItem; hug sizes from content.
      const crossFill = horizontal ? n.sizing?.v === "FILL" || n.stretch : n.sizing?.h === "FILL" || n.stretch;
      const w = !horizontal && crossFill ? U(1, 0) : hug.w ? U(0, 0) : f.scale ? U(n.w / f.w, 0) : U(0, n.w);
      const h = horizontal && crossFill ? U(1, 0) : hug.h ? U(0, 0) : f.scale ? U(n.h / f.h, 0) : U(0, n.h);
      out.push(["Size", { t: "UDim2", xs: (w as any).s, xo: (w as any).o, ys: (h as any).s, yo: (h as any).o }]);
      out.push(["LayoutOrder", I(index + 1)]);
      return out;
    }
    const c = { ...(n.constraints ?? { h: "MIN", v: "MIN" }) };
    // Content-sized layers centered in their parent stay centered: Roblox fonts measure differently than Figma's.
    const centered = this.centered(n, parent);
    if (centered.x && c.h === "MIN") c.h = "CENTER";
    if (centered.y && c.v === "MIN") c.v = "CENTER";
    const axis = (pos: number, size: number, total: number, k: string): { anchor: number; p: [number, number]; s: [number, number] } => {
      const end = total - pos - size;
      if (k === "SCALE" || f.scale) {
        if (k === "MAX") return { anchor: 1, p: [(pos + size) / total, 0], s: [size / total, 0] };
        if (k === "CENTER") return { anchor: 0.5, p: [(pos + size / 2) / total, 0], s: [size / total, 0] };
        return { anchor: 0, p: [pos / total, 0], s: [size / total, 0] };
      }
      if (k === "MAX") return { anchor: 1, p: [1, -end], s: [0, size] };
      if (k === "CENTER") return { anchor: 0.5, p: [0.5, pos + size / 2 - total / 2], s: [0, size] };
      if (k === "STRETCH") return { anchor: 0, p: [0, pos], s: [1, -(pos + end)] };
      return { anchor: 0, p: [0, pos], s: [0, size] };
    };
    const x = axis(n.x, n.w, f.w, c.h);
    const y = axis(n.y, n.h, f.h, c.v);
    if (x.anchor || y.anchor) out.push(["AnchorPoint", V2(x.anchor, y.anchor)]);
    out.push(["Position", U2(x.p[0], x.p[1], y.p[0], y.p[1])]);
    out.push(["Size", U2(hug.w ? 0 : x.s[0], hug.w ? 0 : x.s[1], hug.h ? 0 : y.s[0], hug.h ? 0 : y.s[1])]);
    out.push(["ZIndex", I(index + 1)]);
    return out;
  }

  /** Axes on which a layer sized by its content (text, hug frame) sits at its parent's center. */
  private centered(n: RNode, parent: Parent | null): { x: boolean; y: boolean } {
    if (!parent || (parent.layout && !n.absolute)) return { x: false, y: false };
    const t = n.text?.autoResize;
    const hugX = t === "WIDTH_AND_HEIGHT" || (!n.text && n.sizing?.h === "HUG");
    const hugY = t === "WIDTH_AND_HEIGHT" || t === "HEIGHT" || (!n.text && n.sizing?.v === "HUG");
    const near = (pos: number, size: number, total: number) => Math.abs(pos + size / 2 - total / 2) <= 1.5 && size < total;
    return { x: hugX && near(n.x, n.w, parent.w), y: hugY && near(n.y, n.h, parent.h) };
  }

  private automaticSize(n: RNode, d: Decision): [string, RbxValue][] {
    const hug = this.hugs(n, d);
    if (!hug.w && !hug.h) return [];
    return [["AutomaticSize", E("AutomaticSize", hug.w && hug.h ? "XY" : hug.w ? "X" : "Y")]];
  }

  private corner(n: RNode): RbxInstance | null {
    const r = Math.max(0, ...(n.radius ?? []));
    if (!r && !(n.type === "ELLIPSE")) return null;
    // Full pills and circles: a fractional radius stays round at any size. Scale is relative to the shortest side.
    const short = Math.max(1, Math.min(n.w, n.h));
    const pill = n.type === "ELLIPSE" || r >= short / 2 - 0.5;
    return this.inst("UICorner", "UICorner", [["CornerRadius", pill ? U(0.5, 0) : this.scaleOnly ? U(r / short, 0) : U(0, r)]]);
  }

  private stroke(n: RNode): RbxInstance | null {
    const s = visible(n.strokes)[0];
    if (!s || s.type !== "SOLID" || !n.strokeWeight) return null;
    const short = Math.max(1, Math.min(n.w, n.h));
    const props: [string, RbxValue][] = [
      ["ApplyStrokeMode", E("ApplyStrokeMode", "Border")],
      ["Color", C3(s.color!)],
      ["Thickness", F(this.scaleOnly ? n.strokeWeight / short : n.strokeWeight)],
      ["Transparency", F(1 - s.opacity)],
      ["LineJoinMode", E("LineJoinMode", "Round")],
      ["BorderStrokePosition", E("BorderStrokePosition", n.strokeAlign === "OUTSIDE" ? "Outer" : n.strokeAlign === "CENTER" ? "Center" : "Inner")],
    ];
    // ScaledSize: Thickness is a fraction of the shortest side, so the outline follows the frame's size.
    if (this.scaleOnly) props.push(["StrokeSizingMode", E("StrokeSizingMode", "ScaledSize")]);
    return this.inst("UIStroke", "UIStroke", props);
  }

  /** Drop shadow: a native UIShadow (the largest one when Figma has several). */
  private shadow(n: RNode): RbxInstance | null {
    const list = (n.effects ?? []).filter((e) => e.type === "DROP_SHADOW");
    if (!list.length) return null;
    if (list.length > 1) this.warn(n, "several drop shadows: kept the largest");
    const e = list.reduce((a, b) => (b.blur + (b.spread ?? 0) > a.blur + (a.spread ?? 0) ? b : a));
    const w = Math.max(1, n.w);
    const h = Math.max(1, n.h);
    const spread = (e.spread ?? 0) * 2;
    const s = this.scaleOnly;
    return this.inst("UIShadow", "UIShadow", [
      ["Color", C3(e.color ?? "#000000")],
      ["Transparency", F(1 - (e.alpha ?? 0.25))],
      ["BlurRadius", s ? U(e.blur / Math.min(w, h), 0) : U(0, e.blur)],
      ["Offset", s ? U2((e.x ?? 0) / w, 0, (e.y ?? 0) / h, 0) : U2(0, e.x ?? 0, 0, e.y ?? 0)],
      ["Spread", s ? U2(spread / w, 0, spread / h, 0) : U2(0, spread, 0, spread)],
    ]);
  }

  private gradient(p: RPaint): RbxInstance {
    let stops = [...(p.stops ?? [])].sort((a, b) => a.at - b.at);
    if (stops.length > 20) {
      this.warn(null, "a gradient has more than 20 stops: kept 20");
      stops = stops.filter((_, i) => i % Math.ceil(stops.length / 20) === 0);
    }
    if (stops[0]!.at > 0) stops.unshift({ ...stops[0]!, at: 0 });
    if (stops[stops.length - 1]!.at < 1) stops.push({ ...stops[stops.length - 1]!, at: 1 });
    stops[0] = { ...stops[0]!, at: 0 };
    stops[stops.length - 1] = { ...stops[stops.length - 1]!, at: 1 };
    return this.inst("UIGradient", "UIGradient", [
      ["Color", { t: "ColorSequence", keys: stops.map((s) => ({ time: num(s.at), ...color3(s.color) })) }],
      ["Transparency", { t: "NumberSequence", keys: stops.map((s) => ({ time: num(s.at), value: num(1 - s.alpha * p.opacity) })) }],
      ["Rotation", F(p.angle ?? 0)],
    ]);
  }

  /** UIListLayout / UIGridLayout and UIPadding for an auto-layout frame. */
  private layoutChildren(n: RNode): RbxInstance[] {
    const l = n.layout!;
    const s = this.scaleOnly;
    const out: RbxInstance[] = [];
    const [t = 0, r = 0, b = 0, lft = 0] = l.padding;
    const w = Math.max(1, n.w);
    const h = Math.max(1, n.h);
    // The content box: what children's scale sizes, cells and gaps are relative to.
    const cw = Math.max(1, w - r - lft);
    const ch = Math.max(1, h - t - b);
    const pad = (v: number, total: number) => (s ? U(v / total, 0) : U(0, v));
    if (t || r || b || lft) out.push(this.inst("UIPadding", "UIPadding", [["PaddingTop", pad(t, h)], ["PaddingRight", pad(r, w)], ["PaddingBottom", pad(b, h)], ["PaddingLeft", pad(lft, w)]]));
    if (l.mode === "GRID") {
      const kids = (n.children ?? []).filter((c) => !c.hidden && !c.absolute);
      const first = kids[0];
      if (kids.some((k) => Math.abs(k.w - (first?.w ?? 0)) > 1 || Math.abs(k.h - (first?.h ?? 0)) > 1)) this.warn(n, "grid cells of different sizes: UIGridLayout uses the first cell's size");
      const fw = first?.w ?? 100;
      const fh = first?.h ?? 100;
      out.push(
        this.inst("UIGridLayout", "UIGridLayout", [
          ["CellSize", s ? U2(fw / cw, 0, fh / ch, 0) : U2(0, fw, 0, fh)],
          ["CellPadding", s ? U2((l.columnGap ?? 0) / cw, 0, (l.rowGap ?? 0) / ch, 0) : U2(0, l.columnGap ?? 0, 0, l.rowGap ?? 0)],
          ["FillDirectionMaxCells", I(l.columns ?? 0)],
          ["SortOrder", E("SortOrder", "LayoutOrder")],
        ]),
      );
      return out;
    }
    const horizontal = l.mode === "HORIZONTAL";
    const main = l.primary === "CENTER" ? "Center" : l.primary === "MAX" ? (horizontal ? "Right" : "Bottom") : horizontal ? "Left" : "Top";
    const cross = l.counter === "CENTER" ? "Center" : l.counter === "MAX" ? (horizontal ? "Bottom" : "Right") : horizontal ? "Top" : "Left";
    const gap = l.primary === "SPACE_BETWEEN" ? 0 : l.gap;
    const props: [string, RbxValue][] = [
      ["FillDirection", E("FillDirection", horizontal ? "Horizontal" : "Vertical")],
      ["SortOrder", E("SortOrder", "LayoutOrder")],
      ["Padding", pad(gap, horizontal ? cw : ch)],
      ["HorizontalAlignment", E("HorizontalAlignment", horizontal ? (main === "Right" ? "Right" : main === "Center" ? "Center" : "Left") : cross === "Right" ? "Right" : cross === "Center" ? "Center" : "Left")],
      ["VerticalAlignment", E("VerticalAlignment", horizontal ? (cross === "Bottom" ? "Bottom" : cross === "Center" ? "Center" : "Top") : main === "Bottom" ? "Bottom" : main === "Center" ? "Center" : "Top")],
    ];
    if (l.primary === "SPACE_BETWEEN") props.push([horizontal ? "HorizontalFlex" : "VerticalFlex", E("UIFlexAlignment", "SpaceBetween")]);
    if (l.wrap) props.push(["Wraps", B(true)]);
    if (l.counter === "BASELINE") this.warn(n, "baseline alignment: aligned to the top");
    out.push(this.inst("UIListLayout", "UIListLayout", props));
    return out;
  }

  private assetUrl(key: string, n: RNode): AssetRef {
    const a = this.assets(key);
    if (!a) {
      this.warn(n, "picture missing: left empty");
      return { url: "" };
    }
    return a;
  }

  private textProps(n: RNode): [string, RbxValue][] {
    const t = n.text!;
    const segs = t.segments.length ? t.segments : [{ text: t.characters, family: "Inter", style: "Regular", weight: 400, size: 14 } as RSegment];
    const base = segs.reduce((a, s) => (s.text.length > a.text.length ? s : a), segs[0]!);
    const family = robloxFamily(base.family, this.opts.fonts);
    if (family.substituted) this.fontSubstitutions.set(base.family, family.url.replace(/^.*\/(\w+)\.json$/, "$1"));
    const weight = robloxWeight(base.weight);
    const italic = /italic|oblique/i.test(base.style);
    const size = Math.max(1, Math.round(base.size * this.textFactor));
    const props: [string, RbxValue][] = [
      ["BackgroundTransparency", F(1)],
      ["FontFace", { t: "Font", family: family.url, weight: weight.value, weightName: weight.name, style: italic ? "Italic" : "Normal" }],
      ["TextSize", I(size)],
      ["TextColor3", C3(base.color ?? "#000000")],
    ];
    const alpha = (base.alpha ?? 1) * (n.opacity ?? 1);
    if (alpha < 1) props.push(["TextTransparency", F(1 - alpha)]);
    const rich = segs.length > 1 && segs.some((s) => s.color !== base.color || s.weight !== base.weight || s.size !== base.size || s.family !== base.family || s.decoration || s.textCase || /italic/i.test(s.style) !== italic);
    const text = segs.map((s) => s.text).join("");
    if (rich) {
      props.push(["RichText", B(true)], ["Text", S(segs.map((s) => this.richRun(s, base)).join(""))]);
    } else {
      let value = text;
      if (base.textCase === "UPPER") value = value.toUpperCase();
      else if (base.textCase === "LOWER") value = value.toLowerCase();
      if (base.decoration) props.push(["RichText", B(true)], ["Text", S(this.richRun({ ...base, text: value, textCase: undefined }, { ...base, decoration: undefined }))]);
      else props.push(["Text", S(value)]);
    }
    props.push(["TextXAlignment", E("TextXAlignment", t.align === "CENTER" ? "Center" : t.align === "RIGHT" ? "Right" : "Left")]);
    props.push(["TextYAlignment", E("TextYAlignment", t.valign === "CENTER" ? "Center" : t.valign === "BOTTOM" ? "Bottom" : "Top")]);
    // Fixed-width text wraps; hugging text grows with AutomaticSize.
    if (t.autoResize !== "WIDTH_AND_HEIGHT") props.push(["TextWrapped", B(true)]);
    if (base.lineHeight) props.push(["LineHeight", F(Math.max(1, Math.min(3, base.lineHeight / (base.size * 1.2))))]);
    if (t.maxLines) props.push(["TextTruncate", E("TextTruncate", "AtEnd")]);
    // Scale mode: the text follows its box (TextScaled), within the UITextSizeConstraint limits.
    if (this.opts.textScaled || this.scaleOnly) props.push(["TextScaled", B(true)]);
    if (segs.some((s) => s.letterSpacing)) this.warn(n, "letter spacing has no Roblox equivalent: ignored");
    if (rich && this.scaleOnly && segs.some((s) => s.size !== base.size)) this.warn(n, "several text sizes with TextScaled: the size tags may not scale with the label");
    return props;
  }

  /** One rich-text run, only with what differs from the label's own style. */
  private richRun(s: RSegment, base: RSegment): string {
    let text = s.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    const attrs: string[] = [];
    if (s.color && s.color !== base.color) attrs.push(`color="${s.color}"`);
    if (s.size !== base.size) attrs.push(`size="${Math.round(s.size * this.textFactor)}"`);
    if (s.weight !== base.weight) attrs.push(`weight="${robloxWeight(s.weight).value}"`);
    if (s.family !== base.family) attrs.push(`family="${robloxFamily(s.family, this.opts.fonts).url}"`);
    if (s.alpha !== undefined && s.alpha < 1) attrs.push(`transparency="${num(1 - s.alpha)}"`);
    if (attrs.length) text = `<font ${attrs.join(" ")}>${text}</font>`;
    if (/italic/i.test(s.style) && !/italic/i.test(base.style)) text = `<i>${text}</i>`;
    if (s.decoration === "UNDERLINE") text = `<u>${text}</u>`;
    if (s.decoration === "STRIKETHROUGH") text = `<s>${text}</s>`;
    if (s.textCase === "UPPER") text = `<uc>${text}</uc>`;
    if (s.textCase === "SMALL_CAPS" || s.textCase === "SMALL_CAPS_FORCED") text = `<sc>${text}</sc>`;
    return text;
  }

  node(n: RNode, parent: Parent | null, index: number): RbxInstance | null {
    if (n.hidden) {
      this.counts.skippedHidden++;
      return null;
    }
    const d = decide(n, this.opts);
    for (const a of d.approximations) this.warn(n, a);
    const button = !!parent && this.isButton(n) && d.kind !== "text";
    const geo = this.geometry(n, parent, index, d);
    const common: [string, RbxValue][] = [...geo, ...this.automaticSize(n, d)];
    if (n.rotation) common.push(["Rotation", F(n.rotation)]);
    const children: RbxInstance[] = [];
    let className = "Frame";
    let props: [string, RbxValue][] = [];

    if (d.kind === "text") {
      const isButton = !!n.clickable || BUTTON_NAME.test(n.name);
      className = isButton ? "TextButton" : "TextLabel";
      props = this.textProps(n);
      // A content-sized label: center the glyphs in its box when it is centered, and vertically always.
      const centered = this.centered(n, parent);
      const auto = n.text!.autoResize === "WIDTH_AND_HEIGHT" || n.text!.autoResize === "HEIGHT";
      props = props.map(([k, v]): [string, RbxValue] =>
        k === "TextXAlignment" && centered.x ? [k, E("TextXAlignment", "Center")] : k === "TextYAlignment" && auto && n.text!.valign === "TOP" ? [k, E("TextYAlignment", "Center")] : [k, v],
      );
      if (isButton) props.push(["AutoButtonColor", B(false)]);
      if ((n.effects ?? []).some((e) => e.type === "DROP_SHADOW")) this.warn(n, "text shadow has no Roblox equivalent: ignored");
      const size = (props.find(([k]) => k === "TextSize")![1] as { v: number }).v;
      // Text sized to its content can grow with the screen; text in a fixed box stays at its design size at most.
      const tight = n.text!.autoResize === "WIDTH_AND_HEIGHT" || n.text!.autoResize === "HEIGHT";
      const max = this.scaleOnly && tight ? size * 2 : size;
      children.push(this.inst("UITextSizeConstraint", "UITextSizeConstraint", [["MaxTextSize", I(max)], ["MinTextSize", I(Math.max(1, Math.round(size * 0.5)))]]));
      return this.inst(className, this.label(n, isButton ? "button" : "text"), [...common, ...props], children, n.id);
    }

    if (d.kind === "picture") {
      this.counts.pictures++;
      const a = this.assetUrl(`${n.id}:full`, n);
      className = button ? "ImageButton" : "ImageLabel";
      // The picture may extend past the layer (shadows): place it on its own bounds.
      const pic = parent ? this.pictureGeometry(n, a, geo, parent) : geo;
      props = [["BackgroundTransparency", F(1)], ["Image", { t: "Content", url: a.url }], ["ScaleType", E("ScaleType", "Stretch")]];
      if (n.opacity !== undefined && n.opacity < 1) props.push(["ImageTransparency", F(1 - n.opacity)]);
      if (button) props.push(["AutoButtonColor", B(false)]);
      children.push(this.inst("UIAspectRatioConstraint", "UIAspectRatioConstraint", [["AspectRatio", F((a.size?.w ?? n.w) / Math.max(1, a.size?.h ?? n.h))]]));
      const flavor: Flavor = button ? "button" : n.vector || VECTOR_TYPES.includes(n.type) ? "icon" : "image";
      return this.inst(className, this.label(n, flavor), [...pic, ...props], children, n.id);
    }

    const fills = visible(n.fills);
    const opacity = n.opacity ?? 1;
    const hasKids = !!n.children?.some((c) => !c.hidden);
    if (d.kind === "image") {
      const f = fills[0]!;
      const a = this.assetUrl(`image:${f.imageHash}`, n);
      className = button ? "ImageButton" : "ImageLabel";
      const scaleType = f.scaleMode === "FIT" ? "Fit" : f.scaleMode === "TILE" ? "Tile" : "Crop";
      props = [["BackgroundTransparency", F(1)], ["Image", { t: "Content", url: a.url }], ["ScaleType", E("ScaleType", scaleType)]];
      if (f.opacity * opacity < 1) props.push(["ImageTransparency", F(1 - f.opacity * opacity)]);
      if (button) props.push(["AutoButtonColor", B(false)]);
      const corner = this.corner(n);
      if (corner) children.push(corner);
      const shadow = this.shadow(n);
      if (shadow) children.push(shadow);
      children.push(this.inst("UIAspectRatioConstraint", "UIAspectRatioConstraint", [["AspectRatio", F(n.w / Math.max(1, n.h))]]));
      return this.inst(className, this.label(n, button ? "button" : "image"), [...common, ...props], children, n.id);
    }

    if (d.kind === "panel") {
      // Background Roblox can't draw: a 9-slice picture that stays crisp when resized, content on top.
      this.counts.pictures++;
      const a = this.assetUrl(`${n.id}:panel`, n);
      const scale = a.scale ?? this.opts.scale ?? 2;
      const inset = Math.ceil((Math.max(0, ...(n.radius ?? [0])) + (n.strokeWeight ?? 0) + 2) * scale);
      const pw = a.px?.w ?? Math.round((a.size?.w ?? n.w) * scale);
      const ph = a.px?.h ?? Math.round((a.size?.h ?? n.h) * scale);
      const ix = Math.min(inset, Math.floor(pw / 2) - 1);
      const iy = Math.min(inset, Math.floor(ph / 2) - 1);
      className = button ? "ImageButton" : "ImageLabel";
      props = [["BackgroundTransparency", F(1)], ["Image", { t: "Content", url: a.url }], ...this.imageScaling(n, ix, iy, pw, ph, scale)];
      if (opacity < 1) props.push(["ImageTransparency", F(1 - opacity)]);
      if (button) props.push(["AutoButtonColor", B(false)]);
      // Rounded like the picture, so the native shadow follows the same corners.
      const shadow = this.shadow(n);
      if (shadow) {
        const corner = this.corner(n);
        if (corner) children.push(corner);
        children.push(shadow);
      }
    } else {
      // A native frame.
      className = button ? "TextButton" : hasKids && opacity < 1 ? "CanvasGroup" : "Frame";
      const f = fills[0];
      if (!f) props.push(["BackgroundTransparency", F(1)]);
      else if (f.type === "SOLID") {
        props.push(["BackgroundColor3", C3(f.color!)]);
        const t = 1 - f.opacity * (className === "CanvasGroup" ? 1 : opacity);
        if (t > 0) props.push(["BackgroundTransparency", F(t)]);
      } else if (f.type === "GRADIENT_LINEAR") {
        props.push(["BackgroundColor3", C3("#FFFFFF")]);
        children.push(this.gradient(f));
      } else if (f.type === "IMAGE") {
        // Image behind children: an ImageLabel filling the frame, under everything else.
        props.push(["BackgroundTransparency", F(1)]);
        const a = this.assetUrl(`image:${f.imageHash}`, n);
        const bg = this.inst("ImageLabel", "BackgroundImage", [["Size", U2(1, 0, 1, 0)], ["ZIndex", I(0)], ["BackgroundTransparency", F(1)], ["Image", { t: "Content", url: a.url }], ["ScaleType", E("ScaleType", f.scaleMode === "FIT" ? "Fit" : "Crop")]]);
        const corner = this.corner(n);
        if (corner) bg.children.push(corner);
        children.push(bg);
      }
      if (className === "CanvasGroup") props.push(["GroupTransparency", F(1 - opacity)]);
      if (button) props.push(["Text", S("")], ["AutoButtonColor", B(false)]);
      const corner = this.corner(n);
      if (corner) children.push(corner);
      const stroke = this.stroke(n);
      if (stroke) children.push(stroke);
      const shadow = this.shadow(n);
      if (shadow) children.push(shadow);
    }
    props.push(["BorderSizePixel", I(0)]);
    if (n.clip) props.push(["ClipsDescendants", B(true)]);

    // Children: auto-layout children in the layout; absolute ones in an overlay so the layout ignores them.
    const kids = n.children ?? [];
    const flow = n.layout ? kids.filter((k) => !k.absolute) : kids;
    const loose = n.layout ? kids.filter((k) => k.absolute) : [];
    const me: Parent = { w: n.w, h: n.h, layout: n.layout };
    const flowMapped = flow.map((k, i) => this.node(k, me, i)).filter((x): x is RbxInstance => !!x);
    // layoutGrow → UIFlexItem Fill on the child.
    if (n.layout && n.layout.mode !== "GRID") {
      for (const k of flow) {
        const target = k.grow && !k.hidden ? flowMapped.find((c) => c.source === k.id) : undefined;
        if (target) target.children.push(this.inst("UIFlexItem", "UIFlexItem", [["FlexMode", E("UIFlexMode", "Fill")]]));
      }
    }
    if (n.layout && loose.length) {
      // The overlay keeps the Figma stacking order: layers listed before the flow stay behind it.
      const contentZ = kids.findIndex((k) => !k.absolute) + 1;
      const content = this.inst("Frame", "Content", [["Size", U2(1, 0, 1, 0)], ["ZIndex", I(contentZ)], ["BackgroundTransparency", F(1)], ["BorderSizePixel", I(0)]], [...this.layoutChildren(n), ...flowMapped]);
      const overlay = loose.map((k) => this.node(k, { w: n.w, h: n.h }, kids.indexOf(k))).filter((x): x is RbxInstance => !!x);
      children.push(content, ...overlay);
    } else {
      if (n.layout) children.push(...this.layoutChildren(n));
      children.push(...flowMapped);
    }
    const flavor: Flavor = button ? "button" : fills.length || visible(n.strokes).length || d.kind === "panel" ? "frame" : "container";
    return this.inst(className, this.label(n, flavor), [...common, ...props], children, n.id);
  }

  /** How a panel picture resizes: stretched when its box keeps the design proportions, 9-slice otherwise. */
  private imageScaling(n: RNode, ix: number, iy: number, pw: number, ph: number, scale: number): [string, RbxValue][] {
    // Scale mode: the whole UI resizes in proportion, so a stretched picture stays exact (a 9-slice would keep pixel corners).
    if (this.scaleOnly) return [["ScaleType", E("ScaleType", "Stretch")]];
    const resizes = n.grow || n.stretch || n.sizing?.h === "FILL" || n.sizing?.v === "FILL" || n.sizing?.h === "HUG" || n.sizing?.v === "HUG";
    if (this.opts.mode === "offset" && !resizes) return [["ScaleType", E("ScaleType", "Stretch")]];
    return [
      ["ScaleType", E("ScaleType", "Slice")],
      ["SliceCenter", { t: "Rect", x0: ix, y0: iy, x1: pw - ix, y1: ph - iy }],
      ["SliceScale", F(1 / scale)],
    ];
  }

  /** Grows a picture's box by its overflow (shadows, outside strokes), keeping it aligned with the layer. */
  private pictureGeometry(n: RNode, a: AssetRef, geo: [string, RbxValue][], parent: Parent): [string, RbxValue][] {
    if (!a.offset || !a.size || (Math.abs(a.offset.x) < 0.5 && Math.abs(a.offset.y) < 0.5 && Math.abs(a.size.w - n.w) < 0.5 && Math.abs(a.size.h - n.h) < 0.5)) return geo;
    const f = this.frameOf(n, parent);
    const dw = a.size.w - n.w;
    const dh = a.size.h - n.h;
    // The position moves the anchor point: shift it by the anchor's share of the growth too.
    const anchor = geo.find(([k]) => k === "AnchorPoint")?.[1] as { x: number; y: number } | undefined;
    const ox = a.offset.x + (anchor?.x ?? 0) * dw;
    const oy = a.offset.y + (anchor?.y ?? 0) * dh;
    return geo.map(([k, v]) => {
      if (v.t !== "UDim2" || (k !== "Size" && k !== "Position")) return [k, v];
      if (f.scale) {
        return k === "Size"
          ? [k, { ...v, xs: num(v.xs + dw / f.w), ys: num(v.ys + dh / f.h) }]
          : [k, { ...v, xs: num(v.xs + ox / f.w), ys: num(v.ys + oy / f.h) }];
      }
      return k === "Size" ? [k, { ...v, xo: Math.round(v.xo + dw), yo: Math.round(v.yo + dh) }] : [k, { ...v, xo: Math.round(v.xo + ox), yo: Math.round(v.yo + oy) }];
    });
  }
}

export interface MapResult {
  root: RbxInstance;
  warnings: string[];
  fontSubstitutions: Record<string, string>;
  counts: { instances: number; pictures: number; skippedHidden: number };
}

export function mapToRoblox(root: RNode, opts: RobloxOptions, assets: (key: string) => AssetRef | undefined): MapResult {
  const m = new Mapper(opts, assets);
  const out = m.map(root);
  if (m.counts.skippedHidden) m.warn(null, `${m.counts.skippedHidden} hidden layer(s) skipped`);
  return { root: out, warnings: [...m.warnings], fontSubstitutions: Object.fromEntries(m.fontSubstitutions), counts: m.counts };
}

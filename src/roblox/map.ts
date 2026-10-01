// export_roblox: maps the layer tree from the plugin to a Roblox instance tree (ScreenGui → Frames,
// TextLabels, ImageLabels with UI modifiers). Native Roblox UI wherever it can match the design; pictures
// (rasterized at 2×) for what Roblox can't draw. docs/roblox.md describes every rule.
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
  | { t: "Font"; family: string; weight: number; weightName: string; style: "Normal" | "Italic" }
  | { t: "Source"; v: string };

export interface RbxInstance {
  className: string;
  name: string;
  props: [string, RbxValue][];
  children: RbxInstance[];
  /** Figma layer it comes from (comments in Luau, asset lookups). */
  source?: string;
}

export interface RobloxOptions {
  mode: "fit" | "scale" | "offset" | "hybrid";
  targetResolution: [number, number];
  rasterize: "auto" | "none" | "all";
  asRootFrame?: boolean;
  textScaled?: boolean;
  /** Figma family → Roblox family name or rbxasset URL. */
  fonts?: Record<string, string>;
  /** Picture scale (default 2). */
  scale?: number;
}

/** A picture to take in Figma: "full" (as it looks), "panel" (own fill and stroke), "shadow" (drop shadows). */
export interface PictureRequest {
  id: string;
  mode: "full" | "panel" | "shadow";
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

const num = (v: number) => Math.round(v * 1000) / 1000;
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
const BUTTON_NAME = /\b(button|btn|cta)\b|^(close|back|buy|confirm|cancel|next|previous|prev|exit|play|claim|equip|purchase)$/i;

// ─── Decisions shared by both passes ────────────────────────────────────────

type Kind = "text" | "image" | "picture" | "panel" | "frame";

interface Decision {
  kind: Kind;
  /** Drop shadows drawn by a separate picture behind a native panel. */
  shadow: boolean;
  approximations: string[];
}

function visible(list?: RPaint[]) {
  return (list ?? []).filter((p) => p.opacity > 0);
}

export function decide(n: RNode, opts: RobloxOptions): Decision {
  const approximations: string[] = [];
  if (n.text) return { kind: "text", shadow: false, approximations };
  const raster = opts.rasterize;
  const fills = visible(n.fills);
  const strokes = visible(n.strokes);
  const effects = n.effects ?? [];
  const drop = effects.filter((e) => e.type === "DROP_SHADOW");
  const other = effects.filter((e) => e.type !== "DROP_SHADOW");
  const hasChildren = !!n.children?.some((c) => !c.hidden);

  if (n.rasterize && raster !== "none") return { kind: "picture", shadow: false, approximations: ["image file unreadable: pictured as it looks"] };
  if (n.vector || ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"].includes(n.type)) {
    return raster === "none" ? { kind: "frame", shadow: false, approximations: ["vector shape skipped (rasterize is none)"] } : { kind: "picture", shadow: false, approximations };
  }
  const image = fills.length === 1 && fills[0]!.type === "IMAGE";
  if (image && !hasChildren && !strokes.length && !effects.length && raster !== "all") return { kind: "image", shadow: false, approximations };

  // What Roblox draws natively: one solid or linear-gradient fill, one solid stroke, corners, drop shadows (as a picture).
  const reasons: string[] = [];
  if (fills.length > 1) reasons.push("several fills");
  if (fills.length === 1 && !["SOLID", "GRADIENT_LINEAR", "IMAGE"].includes(fills[0]!.type)) reasons.push(`${fills[0]!.type.toLowerCase().replace("_", " ")} fill`);
  if (image && (strokes.length || effects.length)) reasons.push("image with stroke or effects");
  if (strokes.length > 1 || (strokes[0] && strokes[0].type !== "SOLID")) reasons.push("complex stroke");
  if (n.dashed) reasons.push("dashed stroke");
  if (other.length) reasons.push(other.map((e) => e.type.toLowerCase().replace(/_/g, " ")).join(", "));
  if (n.type === "ELLIPSE" && Math.abs(n.w - n.h) > 0.5) reasons.push("oval");
  const styled = fills.length + strokes.length + effects.length > 0;
  if ((reasons.length || (raster === "all" && styled)) && raster !== "none") {
    // A panel picture has no effects: its drop shadows are a separate picture, as for native frames.
    return { kind: hasChildren ? "panel" : "picture", shadow: hasChildren && drop.length > 0, approximations };
  }
  if (reasons.length) approximations.push(`${reasons.join(", ")}: approximated (rasterize is none)`);
  const r = n.radius ?? [];
  if (r.length && r.some((v) => Math.abs(v - r[0]!) > 0.5)) approximations.push("different corner radii: used the largest");
  if (drop.length && raster === "none") approximations.push("drop shadow skipped (rasterize is none)");
  return { kind: "frame", shadow: drop.length > 0 && raster !== "none", approximations };
}

/** Every picture the export needs, so the caller can take them in one plugin call. */
export function pictureRequests(root: RNode, opts: RobloxOptions): PictureRequest[] {
  const out: PictureRequest[] = [];
  const walk = (n: RNode) => {
    if (n.hidden) return;
    const d = decide(n, opts);
    if (d.kind === "picture") out.push({ id: n.id, mode: "full" });
    if (d.kind === "panel") out.push({ id: n.id, mode: "panel" });
    if (d.shadow) out.push({ id: n.id, mode: "shadow" });
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

/** LocalScript for "fit" mode: sizes the UI as designed for a target screen, never larger than the player's screen. */
export function fitScript(w: number, h: number, tw: number, th: number): string {
  return [
    "-- Generated by Figma Bridge (export_roblox, fit mode).",
    `-- The UI keeps its Figma size (${Math.round(w)}×${Math.round(h)} px, designed for a ${tw}×${th} screen) and is scaled as a whole.`,
    "local root = script.Parent",
    'local scale = root:WaitForChild("FitScale")',
    "local camera = workspace.CurrentCamera",
    `local TARGET = Vector2.new(${tw}, ${th})`,
    `local SIZE = Vector2.new(${Math.round(w)}, ${Math.round(h)})`,
    "local MARGIN = 0.96",
    "",
    "local function fit()",
    "	local viewport = camera.ViewportSize",
    "	local s = math.min(viewport.X / TARGET.X, viewport.Y / TARGET.Y)",
    "	s = math.min(s, viewport.X * MARGIN / SIZE.X, viewport.Y * MARGIN / SIZE.Y)",
    "	scale.Scale = math.max(s, 0.1)",
    "end",
    "",
    'camera:GetPropertyChangedSignal("ViewportSize"):Connect(fit)',
    "fit()",
    "",
  ].join("\n");
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

  constructor(
    private opts: RobloxOptions,
    private assets: (key: string) => AssetRef | undefined,
  ) {}

  warn(n: RNode | null, msg: string) {
    if (this.warnings.size < 60) this.warnings.add(n ? `${n.name}: ${msg}` : msg);
  }

  map(root: RNode): RbxInstance {
    const [tw, th] = this.opts.targetResolution;
    const fullScreen = Math.abs(root.w / root.h - tw / th) < 0.1 * (tw / th) && root.w >= tw * 0.4;
    // A screen designed at another size: text grows or shrinks with it (scale and hybrid modes).
    if (fullScreen && (this.opts.mode === "scale" || this.opts.mode === "hybrid")) this.textFactor = tw / root.w;
    const top = this.node(root, null, 0)!;
    // The root: centered, keeping its proportions.
    const pixelExact = this.opts.mode === "offset" || this.opts.mode === "fit";
    const geo: [string, RbxValue][] =
      pixelExact
        ? [["AnchorPoint", V2(0.5, 0.5)], ["Position", U2(0.5, 0, 0.5, 0)], ["Size", U2(0, root.w, 0, root.h)]]
        : fullScreen
          ? [["AnchorPoint", V2(0.5, 0.5)], ["Position", U2(0.5, 0, 0.5, 0)], ["Size", U2(1, 0, 1, 0)]]
          : [["AnchorPoint", V2(0.5, 0.5)], ["Position", U2(0.5, 0, 0.5, 0)], ["Size", U2(root.w / tw, 0, root.h / th, 0)]];
    top.props = top.props.filter(([k]) => !["AnchorPoint", "Position", "Size", "LayoutOrder", "ZIndex"].includes(k));
    top.props.splice(1, 0, ...geo);
    if (this.opts.mode === "fit") {
      // Pixel-exact layout, scaled as a whole: same proportions as Figma on every screen, text included.
      top.children.push(this.inst("UIScale", "FitScale", [["Scale", F(1)]]));
      top.children.push(this.inst("LocalScript", "FitToScreen", [["Source", { t: "Source", v: fitScript(root.w, root.h, tw, th) }]]));
    } else if (!pixelExact) {
      // Sized from the screen height (as on phones the width varies most); the width follows the design ratio.
      const ratio: [string, RbxValue][] = [["AspectRatio", F(root.w / root.h)]];
      if (!fullScreen) ratio.push(["DominantAxis", E("DominantAxis", "Height")]);
      top.children.push(this.inst("UIAspectRatioConstraint", "UIAspectRatioConstraint", ratio));
    }
    uniqueNames(top);
    if (this.opts.asRootFrame) return top;
    return this.inst("ScreenGui", `${baseName(root.name) || "Main"}Gui`, [["ResetOnSpawn", B(false)], ["ZIndexBehavior", E("ZIndexBehavior", "Sibling")], ["IgnoreGuiInset", B(true)]], [top]);
  }

  private inst(className: string, name: string, props: [string, RbxValue][] = [], children: RbxInstance[] = [], source?: string): RbxInstance {
    this.counts.instances++;
    return { className, name, props: [["Name", S(name)], ...props], children, ...(source ? { source } : {}) };
  }

  /** Size and position from the parent's layout or the layer's constraints. */
  private geometry(n: RNode, parent: Parent | null, index: number, d: Decision): [string, RbxValue][] {
    const out: [string, RbxValue][] = [];
    if (!parent) return out;
    const inFlow = !!parent.layout && !n.absolute;
    const useScale = this.opts.mode === "scale" || (this.opts.mode === "hybrid" && !inFlow);
    // fit and offset keep Figma's pixels; fit scales the whole UI with one UIScale.
    // scale: every size is a share of the parent, nothing in pixels, so no AutomaticSize either.
    const hugW = !this.scaled && n.sizing?.h === "HUG" && (d.kind === "text" || !!n.layout);
    const hugH = !this.scaled && n.sizing?.v === "HUG" && (d.kind === "text" || !!n.layout);
    if (inFlow) {
      const l = parent.layout!;
      const horizontal = l.mode === "HORIZONTAL";
      const pw = parent.w - (l.padding[1] ?? 0) - (l.padding[3] ?? 0);
      const ph = parent.h - (l.padding[0] ?? 0) - (l.padding[2] ?? 0);
      // Cross-axis fill stretches (scale 1); main-axis fill is a UIFlexItem; hug sizes from content.
      const crossFill = horizontal ? n.sizing?.v === "FILL" || n.stretch : n.sizing?.h === "FILL" || n.stretch;
      const w = (horizontal ? false : crossFill) ? U(1, 0) : hugW ? U(0, 0) : useScale ? U(n.w / Math.max(1, pw), 0) : U(0, n.w);
      const h = (horizontal ? crossFill : false) ? U(1, 0) : hugH ? U(0, 0) : useScale ? U(n.h / Math.max(1, ph), 0) : U(0, n.h);
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
      if (k === "SCALE" || useScale) {
        if (k === "MAX") return { anchor: 1, p: [(pos + size) / total, 0], s: [size / total, 0] };
        if (k === "CENTER") return { anchor: 0.5, p: [(pos + size / 2) / total, 0], s: [size / total, 0] };
        return { anchor: 0, p: [pos / total, 0], s: [size / total, 0] };
      }
      if (k === "MAX") return { anchor: 1, p: [1, -end], s: [0, size] };
      if (k === "CENTER") return { anchor: 0.5, p: [0.5, pos + size / 2 - total / 2], s: [0, size] };
      if (k === "STRETCH") return { anchor: 0, p: [0, pos], s: [1, -(pos + end)] };
      return { anchor: 0, p: [0, pos], s: [0, size] };
    };
    const x = axis(n.x, n.w, Math.max(1, parent.w), c.h);
    const y = axis(n.y, n.h, Math.max(1, parent.h), c.v);
    if (x.anchor || y.anchor) out.push(["AnchorPoint", V2(x.anchor, y.anchor)]);
    out.push(["Position", U2(x.p[0], x.p[1], y.p[0], y.p[1])]);
    out.push(["Size", U2(hugW ? 0 : x.s[0], hugW ? 0 : x.s[1], hugH ? 0 : y.s[0], hugH ? 0 : y.s[1])]);
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

  private get scaled() {
    return this.opts.mode === "scale";
  }

  private automaticSize(n: RNode, d: Decision): [string, RbxValue][] {
    if (this.scaled) return [];
    const hugW = n.sizing?.h === "HUG" && (d.kind === "text" || !!n.layout);
    const hugH = n.sizing?.v === "HUG" && (d.kind === "text" || !!n.layout);
    if (!hugW && !hugH) return [];
    return [["AutomaticSize", E("AutomaticSize", hugW && hugH ? "XY" : hugW ? "X" : "Y")]];
  }

  private corner(n: RNode): RbxInstance | null {
    const r = Math.max(0, ...(n.radius ?? []));
    if (!r && !(n.type === "ELLIPSE")) return null;
    // Full pills and circles: a fractional radius stays round at any size.
    const pill = n.type === "ELLIPSE" || r >= Math.min(n.w, n.h) / 2 - 0.5;
    // Scale radii are a share of the shorter side, so corners keep their shape at any size.
    const radius = pill ? U(0.5, 0) : this.scaled ? U(r / Math.max(1, Math.min(n.w, n.h)), 0) : U(0, r);
    return this.inst("UICorner", "UICorner", [["CornerRadius", radius]]);
  }

  private stroke(n: RNode): RbxInstance | null {
    const s = visible(n.strokes)[0];
    if (!s || s.type !== "SOLID" || !n.strokeWeight) return null;
    return this.inst("UIStroke", "UIStroke", [
      ["ApplyStrokeMode", E("ApplyStrokeMode", "Border")],
      ["Color", C3(s.color!)],
      ["Thickness", F(n.strokeWeight)],
      ["Transparency", F(1 - s.opacity)],
      ["LineJoinMode", E("LineJoinMode", "Round")],
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
    const out: RbxInstance[] = [];
    const [t, r, b, lft] = l.padding;
    const sx = (v: number) => (this.scaled ? U(v / Math.max(1, n.w), 0) : U(0, v));
    const sy = (v: number) => (this.scaled ? U(v / Math.max(1, n.h), 0) : U(0, v));
    if (t || r || b || lft) out.push(this.inst("UIPadding", "UIPadding", [["PaddingTop", sy(t!)], ["PaddingRight", sx(r!)], ["PaddingBottom", sy(b!)], ["PaddingLeft", sx(lft!)]]));
    const cw = Math.max(1, n.w - (lft ?? 0) - (r ?? 0));
    const ch = Math.max(1, n.h - (t ?? 0) - (b ?? 0));
    if (l.mode === "GRID") {
      const kids = (n.children ?? []).filter((c) => !c.hidden && !c.absolute);
      const first = kids[0];
      if (kids.some((k) => Math.abs(k.w - (first?.w ?? 0)) > 1 || Math.abs(k.h - (first?.h ?? 0)) > 1)) this.warn(n, "grid cells of different sizes: UIGridLayout uses the first cell's size");
      out.push(
        this.inst("UIGridLayout", "UIGridLayout", [
          ["CellSize", this.scaled ? U2((first?.w ?? 100) / cw, 0, (first?.h ?? 100) / ch, 0) : U2(0, first?.w ?? 100, 0, first?.h ?? 100)],
          ["CellPadding", this.scaled ? U2((l.columnGap ?? 0) / cw, 0, (l.rowGap ?? 0) / ch, 0) : U2(0, l.columnGap ?? 0, 0, l.rowGap ?? 0)],
          ["FillDirectionMaxCells", I(l.columns ?? 0)],
          ["SortOrder", E("SortOrder", "LayoutOrder")],
        ]),
      );
      return out;
    }
    const horizontal = l.mode === "HORIZONTAL";
    const main = l.primary === "CENTER" ? "Center" : l.primary === "MAX" ? (horizontal ? "Right" : "Bottom") : horizontal ? "Left" : "Top";
    const cross = l.counter === "CENTER" ? "Center" : l.counter === "MAX" ? (horizontal ? "Bottom" : "Right") : horizontal ? "Top" : "Left";
    const props: [string, RbxValue][] = [
      ["FillDirection", E("FillDirection", horizontal ? "Horizontal" : "Vertical")],
      ["SortOrder", E("SortOrder", "LayoutOrder")],
      ["Padding", l.primary === "SPACE_BETWEEN" ? U(0, 0) : this.scaled ? U(l.gap / (horizontal ? cw : ch), 0) : U(0, l.gap)],
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
    if (this.opts.textScaled || this.scaled) props.push(["TextScaled", B(true)]);
    if (segs.some((s) => s.letterSpacing)) this.warn(n, "letter spacing has no Roblox equivalent: ignored");
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
    const button = !!parent && (n.clickable || BUTTON_NAME.test(n.name)) && d.kind !== "text";
    const geo = this.geometry(n, parent, index, d);
    const common: [string, RbxValue][] = [...geo, ...this.automaticSize(n, d)];
    if (n.rotation) common.push(["Rotation", F(n.rotation)]);
    const children: RbxInstance[] = [];
    let className = "Frame";
    let props: [string, RbxValue][] = [];

    if (d.kind === "text") {
      className = n.clickable || BUTTON_NAME.test(n.name) ? "TextButton" : "TextLabel";
      props = this.textProps(n);
      // A content-sized label: center the glyphs in its box when it is centered, and vertically always.
      const centered = this.centered(n, parent);
      const auto = n.text!.autoResize === "WIDTH_AND_HEIGHT" || n.text!.autoResize === "HEIGHT";
      props = props.map(([k, v]): [string, RbxValue] =>
        k === "TextXAlignment" && centered.x ? [k, E("TextXAlignment", "Center")] : k === "TextYAlignment" && auto && n.text!.valign === "TOP" ? [k, E("TextYAlignment", "Center")] : [k, v],
      );
      if (className === "TextButton") props.push(["AutoButtonColor", B(false)]);
      const size = (props.find(([k]) => k === "TextSize")![1] as { v: number }).v;
      // Scaled text follows its box; the cap keeps it from growing past twice the design size on big screens.
      children.push(
        this.inst(
          "UITextSizeConstraint",
          "UITextSizeConstraint",
          this.scaled ? [["MaxTextSize", I(size * 2)], ["MinTextSize", I(1)]] : [["MaxTextSize", I(size)], ["MinTextSize", I(Math.max(1, Math.round(size * 0.5)))]],
        ),
      );
      return this.inst(className, robloxName(n, className), [...common, ...props], children, n.id);
    }

    if (d.kind === "picture") {
      this.counts.pictures++;
      const a = this.assetUrl(`${n.id}:full`, n);
      className = button ? "ImageButton" : "ImageLabel";
      // The picture may extend past the layer (shadows): place it on its own bounds.
      const pic = this.pictureGeometry(n, a, geo);
      props = [["BackgroundTransparency", F(1)], ["Image", { t: "Content", url: a.url }], ["ScaleType", E("ScaleType", "Stretch")]];
      if (n.opacity !== undefined && n.opacity < 1) props.push(["ImageTransparency", F(1 - n.opacity)]);
      if (button) props.push(["AutoButtonColor", B(false)]);
      children.push(this.inst("UIAspectRatioConstraint", "UIAspectRatioConstraint", [["AspectRatio", F((a.size?.w ?? n.w) / Math.max(1, a.size?.h ?? n.h))]]));
      return this.inst(className, robloxName(n, className), [...pic, ...props], children, n.id);
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
      children.push(this.inst("UIAspectRatioConstraint", "UIAspectRatioConstraint", [["AspectRatio", F(n.w / Math.max(1, n.h))]]));
      return this.inst(className, robloxName(n, className), [...common, ...props], children, n.id);
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
        const bg = this.inst("ImageLabel", "Background", [["Size", U2(1, 0, 1, 0)], ["ZIndex", I(0)], ["BackgroundTransparency", F(1)], ["Image", { t: "Content", url: a.url }], ["ScaleType", E("ScaleType", f.scaleMode === "FIT" ? "Fit" : "Crop")]]);
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
    }
    props.push(["BorderSizePixel", I(0)]);
    if (n.clip) props.push(["ClipsDescendants", B(true)]);

    // Children: auto-layout children in the layout; absolute ones in an overlay so the layout ignores them.
    const kids = n.children ?? [];
    const flow = n.layout ? kids.filter((k) => !k.absolute) : kids;
    const loose = n.layout ? kids.filter((k) => k.absolute) : [];
    const me: Parent = { w: n.w, h: n.h, layout: n.layout };
    const mapped = (list: RNode[], p: Parent) => list.map((k, i) => this.node(k, p, i)).filter((x): x is RbxInstance => !!x);
    const flowMapped = mapped(flow, me);
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

    const self = this.inst(className, robloxName(n, className), [...common, ...props], children, n.id);
    if (!d.shadow) return self;
    // Drop shadow: a 9-slice picture behind the frame, both inside a wrapper that takes the frame's place.
    this.counts.pictures++;
    const a = this.assetUrl(`${n.id}:shadow`, n);
    const scale = a.scale ?? this.opts.scale ?? 2;
    const sh = (n.effects ?? []).filter((e) => e.type === "DROP_SHADOW");
    const reach = Math.max(...sh.map((e) => e.blur + (e.spread ?? 0) + Math.max(Math.abs(e.x ?? 0), Math.abs(e.y ?? 0))));
    const off = a.offset ?? { x: 0, y: 0 };
    const size = a.size ?? { w: n.w, h: n.h };
    const inset = Math.ceil((Math.max(0, ...(n.radius ?? [0])) + reach) * scale);
    const pw = a.px?.w ?? Math.round(size.w * scale);
    const ph = a.px?.h ?? Math.round(size.h * scale);
    const ix = Math.min(inset, Math.floor(pw / 2) - 1);
    const iy = Math.min(inset, Math.floor(ph / 2) - 1);
    const shadow = this.inst("ImageLabel", "Shadow", [
      ["Position", this.scaled ? U2(off.x / Math.max(1, n.w), 0, off.y / Math.max(1, n.h), 0) : U2(0, off.x, 0, off.y)],
      ["Size", this.scaled ? U2(size.w / Math.max(1, n.w), 0, size.h / Math.max(1, n.h), 0) : U2(1, size.w - n.w, 1, size.h - n.h)],
      ["ZIndex", I(1)],
      ["BackgroundTransparency", F(1)],
      ["Image", { t: "Content", url: a.url }],
      ...this.imageScaling(n, ix, iy, pw, ph, scale),
    ]);
    // The frame fills the wrapper; the wrapper carries the layout properties.
    self.props = self.props.filter(([k]) => !["AnchorPoint", "Position", "Size", "LayoutOrder", "AutomaticSize", "ZIndex"].includes(k));
    self.props.splice(1, 0, ["Size", U2(1, 0, 1, 0)], ["ZIndex", I(2)]);
    // Wrapper: the layer's name; the frame inside: what it is.
    self.name = className.endsWith("Button") ? "Button" : "Panel";
    self.props[0] = ["Name", S(self.name)];
    return this.inst("Frame", robloxName(n, "Frame"), [...common.filter(([k]) => k !== "AutomaticSize"), ["BackgroundTransparency", F(1)], ["BorderSizePixel", I(0)]], [shadow, self], n.id);
  }

  /** Pixel-exact layers keep their Figma size: a stretched picture is exact. Layers that resize get a 9-slice. */
  private imageScaling(n: RNode, ix: number, iy: number, pw: number, ph: number, scale: number): [string, RbxValue][] {
    // scale: the whole UI resizes in proportion, so a stretched picture stays exact (a 9-slice would keep pixel corners).
    if (this.scaled) return [["ScaleType", E("ScaleType", "Stretch")]];
    const pixelExact = this.opts.mode === "fit" || this.opts.mode === "offset";
    const resizes = n.grow || n.stretch || n.sizing?.h === "FILL" || n.sizing?.v === "FILL" || n.sizing?.h === "HUG" || n.sizing?.v === "HUG";
    if (pixelExact && !resizes) return [["ScaleType", E("ScaleType", "Stretch")]];
    return [
      ["ScaleType", E("ScaleType", "Slice")],
      ["SliceCenter", { t: "Rect", x0: ix, y0: iy, x1: pw - ix, y1: ph - iy }],
      ["SliceScale", F(1 / scale)],
    ];
  }

  private pictureGeometry(n: RNode, a: AssetRef, geo: [string, RbxValue][]): [string, RbxValue][] {
    if (!a.offset || !a.size || (Math.abs(a.offset.x) < 0.5 && Math.abs(a.offset.y) < 0.5 && Math.abs(a.size.w - n.w) < 0.5 && Math.abs(a.size.h - n.h) < 0.5)) return geo;
    // Grow the box by the picture's overflow so it stays aligned with the layer (in the units the box already uses).
    const anchor = geo.find(([k]) => k === "AnchorPoint")?.[1] as { x: number; y: number } | undefined;
    const size = geo.find(([k]) => k === "Size")?.[1] as { xs: number; xo: number; ys: number; yo: number } | undefined;
    const dw = a.size.w - n.w;
    const dh = a.size.h - n.h;
    const dx = a.offset.x + (anchor?.x ?? 0) * dw;
    const dy = a.offset.y + (anchor?.y ?? 0) * dh;
    // Parent pixels per scale unit, from the layer's own scale size.
    const px = size && size.xs ? n.w / size.xs : 0;
    const py = size && size.ys ? n.h / size.ys : 0;
    return geo.map(([k, v]) => {
      if (v.t !== "UDim2" || (k !== "Size" && k !== "Position")) return [k, v];
      const [ax, ay] = k === "Size" ? [dw, dh] : [dx, dy];
      const x = px ? { xs: num(v.xs + ax / px), xo: v.xo } : { xs: v.xs, xo: Math.round(v.xo + ax) };
      const y = py ? { ys: num(v.ys + ay / py), yo: v.yo } : { ys: v.ys, yo: Math.round(v.yo + ay) };
      return [k, { ...v, ...x, ...y }];
    });
  }
}

// ─── Names ──────────────────────────────────────────────────────────────────
// Roblox instances get PascalCase names that say what they are (TitleLabel, CloseButton, SearchIcon), so scripts
// can reach them as script.Parent.CloseButton.

const GENERIC = /^(frame|group|rectangle|rect|ellipse|vector|line|polygon|star|union|subtract|intersect|exclude|auto ?layout|component|instance|image|text|layer|shape|copy)( ?\d+)?$/i;
const ROLE_WORDS = ["Button", "Icon", "Image", "Pill", "Badge", "Chip", "Tag", "Card", "Player", "Avatar", "Input", "Tab", "Item", "Row", "Label", "Title", "Panel", "Popup", "Modal", "Header", "Footer", "List", "Toggle", "Logo", "Section"];
const TEXT_ENDINGS = /(Label|Title|Text|Subtitle|Heading|Caption|Hint|Description)$/;

/** "Gift popup v2.2" → "GiftPopup", "GIFT FOR 899" → "GiftFor899". */
export function baseName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bv\d+(\.\d+)*\b/gi, " ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]+$/.test(w) && w.length > 1 ? w[0] + w.slice(1).toLowerCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join("");
}

export function robloxName(n: RNode, className: string): string {
  const raw = n.name.trim();
  let base = "";
  if (n.text && (raw === n.text.characters.trim() || GENERIC.test(raw))) {
    // Named after its own text (Figma's default): the first words, then what it is.
    base = baseName(n.text.characters.split(/\s+/).slice(0, 3).join(" "));
    if (/^\d/.test(base)) base = "Value" + base;
  } else {
    // "Icon · search", "Button / Primary": role first in Figma, last in Roblox (SearchIcon, PrimaryButton).
    const parts = raw.split(/\s*[·•|/]\s*/).filter(Boolean);
    const role = parts.length > 1 ? baseName(parts[0]!) : "";
    base = role && ROLE_WORDS.includes(role) ? baseName(parts.slice(1).join(" ")) + role : baseName(raw);
    if (!raw || GENERIC.test(raw)) base = "";
  }
  if (!base) {
    if (n.text) base = "Text";
    else if (n.layout?.mode === "HORIZONTAL") base = "Row";
    else if (n.layout?.mode === "VERTICAL") base = "Column";
    else if (n.layout?.mode === "GRID") base = "Grid";
    else if (n.children?.length) base = "Container";
    else if (n.vector || /VECTOR|BOOLEAN|STAR|POLYGON/.test(n.type)) base = "Icon";
    else if (n.fills?.some((f) => f.type === "IMAGE")) base = "Image";
    else if (n.type === "ELLIPSE") base = "Circle";
    else base = "Shape";
  }
  if (/^\d/.test(base)) base = "Item" + base;
  if (className.endsWith("Button") && !base.endsWith("Button")) base += "Button";
  else if (className === "TextLabel" && !TEXT_ENDINGS.test(base)) base += "Label";
  return base;
}

/** Siblings with the same name get 2, 3… so each one can be found by name. */
function uniqueNames(i: RbxInstance) {
  const seen = new Map<string, number>();
  for (const c of i.children) {
    const nameProp = c.props.find(([k]) => k === "Name");
    if (nameProp && nameProp[1].t === "string" && !/^UI[A-Z]/.test(c.className)) {
      const name = nameProp[1].v;
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      if (count > 1) {
        c.name = name + count;
        nameProp[1] = { t: "string", v: c.name };
      }
    }
    uniqueNames(c);
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

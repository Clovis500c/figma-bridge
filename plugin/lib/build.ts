// Declarative builder: turns a JSON layout spec into Figma nodes in one pass.
import {
  codeError,
  findStyle,
  findVariable,
  isAutoLayout,
  loadFont,
  localComponents,
  parentFor,
  parseFont,
  parseHex,
  place,
} from "./util";
import { applyModes } from "./tokens";

interface Ctx {
  warnings: string[];
  ids: { [name: string]: string };
  count: number;
  images: { [key: string]: Uint8Array };
  fonts: { [key: string]: FontName };
  defaults: { font: string; color: string; size: number };
}

const MAX_NODES = 3000;
const SHADOW_DEFAULT = { x: 0, y: 4, blur: 16, spread: 0, color: "#0000001F" };

export async function build(p: any) {
  const spec = p.spec;
  if (!spec || typeof spec !== "object") throw codeError("`spec` must be a node object or an array of node objects", "BAD_ARGS");
  const roots: any[] = Array.isArray(spec) ? spec : [spec];
  const d = p.defaults || {};
  const ctx: Ctx = {
    warnings: [],
    ids: {},
    count: 0,
    images: p.imageBytes || {},
    fonts: {},
    defaults: { font: d.font || "Inter", color: d.color || "#111111", size: d.size || 14 },
  };
  await preloadFonts(roots, ctx);

  const parent = await parentFor(p.parentId);
  const made: SceneNode[] = [];
  let cursorX: number | null = null;
  for (let i = 0; i < roots.length; i++) {
    const node = await createNode(roots[i], parent, ctx, "spec" + (roots.length > 1 ? "[" + i + "]" : ""));
    if (!node) continue;
    if (!isAutoLayout(parent) && roots[i].x === undefined && roots[i].y === undefined) {
      if (cursorX === null) {
        place(node, p.x, p.y);
      } else {
        node.x = cursorX;
        node.y = made[0].y;
      }
      cursorX = node.x + node.width + 80;
    }
    made.push(node);
  }
  if (p.select !== false && made.length && parent.type === "PAGE" && parent === figma.currentPage) {
    figma.currentPage.selection = made;
    figma.viewport.scrollAndZoomIntoView(made);
  }
  const out: any = {
    rootId: made.length ? made[0].id : null,
    rootIds: made.map(function (n) {
      return n.id;
    }),
    created: ctx.count,
    ids: ctx.ids,
  };
  if (ctx.warnings.length) out.warnings = ctx.warnings.slice(0, 50);
  return out;
}

// ─── Fonts ──────────────────────────────────────────────────────────────────

function fontKey(s: any, ctx: Ctx): FontName {
  return parseFont(s.font || ctx.defaults.font, s.weight, ctx.defaults.font);
}

/** Loads every font of the spec in parallel, with fallbacks when one is missing. */
async function preloadFonts(roots: any[], ctx: Ctx) {
  const wanted: { [key: string]: FontName } = {};
  const walk = function (s: any) {
    if (!s || typeof s !== "object") return;
    if (nodeType(s) === "text") {
      const f = fontKey(s, ctx);
      wanted[f.family + ":" + f.style] = f;
    }
    if (Array.isArray(s.children)) s.children.forEach(walk);
  };
  roots.forEach(walk);
  const keys = Object.keys(wanted);
  await Promise.all(
    keys.map(async function (key) {
      const f = wanted[key];
      const candidates: FontName[] = [f, { family: f.family, style: "Regular" }, { family: "Inter", style: f.style }, { family: "Inter", style: "Regular" }];
      for (let i = 0; i < candidates.length; i++) {
        try {
          await loadFont(candidates[i]);
          ctx.fonts[key] = candidates[i];
          if (i > 0) ctx.warnings.push('Font "' + f.family + " " + f.style + '" unavailable, used "' + candidates[i].family + " " + candidates[i].style + '"');
          return;
        } catch (e) {}
      }
    }),
  );
}

// ─── Node creation ──────────────────────────────────────────────────────────

function nodeType(s: any): string {
  if (s.type) {
    const t = String(s.type).toLowerCase();
    return t === "rectangle" ? "rect" : t === "circle" ? "ellipse" : t;
  }
  if (s.text !== undefined) return "text";
  if (s.svg) return "svg";
  if (s.icon) return "icon";
  if (s.imageKey || s.src) return "image";
  if (s.component) return "instance";
  return "frame";
}

async function createNode(s: any, parent: BaseNode & ChildrenMixin, ctx: Ctx, path: string): Promise<SceneNode | null> {
  if (!s || typeof s !== "object") {
    ctx.warnings.push(path + ": not an object, skipped");
    return null;
  }
  if (ctx.count >= MAX_NODES) throw codeError("Spec is too large (max " + MAX_NODES + " nodes). Split it into several build calls.", "TOO_LARGE");
  const type = nodeType(s);
  let node: SceneNode;
  switch (type) {
    case "frame":
    case "component":
      node = type === "component" ? figma.createComponent() : figma.createFrame();
      break;
    case "text":
      node = figma.createText();
      break;
    case "rect":
      node = figma.createRectangle();
      break;
    case "ellipse":
      node = figma.createEllipse();
      break;
    case "line":
      node = figma.createLine();
      break;
    case "svg":
    case "icon":
      if (!s.svg) throw codeError(path + ": icons must be created with the build tool (the server fetches the SVG)", "BAD_ARGS");
      node = figma.createNodeFromSvg(String(s.svg));
      break;
    case "image":
      node = figma.createRectangle();
      break;
    case "instance":
      node = await createInstance(s, path);
      break;
    default:
      throw codeError(path + ': unknown type "' + s.type + '"', "BAD_ARGS");
  }
  ctx.count++;
  parent.appendChild(node);
  const parentAuto = isAutoLayout(parent);

  if (s.name) node.name = String(s.name);
  else if (type === "icon") node.name = "icon/" + s.icon;

  if (type === "frame" || type === "component") await setupFrame(node as FrameNode, s, ctx, path);
  else if (type === "text") await setupText(node as TextNode, s, ctx);
  else if (type === "image") await setupImage(node as RectangleNode, s, ctx, path);
  else if (type === "line") {
    (node as LineNode).resize(num(s.w, s.width, 100), 0);
    if (s.stroke === undefined) (node as LineNode).strokes = [solid(ctx.defaults.color)];
  } else if ((type === "rect" || type === "ellipse") && s.w === undefined && s.width === undefined && s.size === undefined) {
    (node as RectangleNode).resize(100, 100);
  }
  if (type === "instance" && s.text && typeof s.text === "object") await overrideTexts(node as InstanceNode, s.text, ctx);

  await applyVisuals(node, s, ctx, type);
  applySize(node, s, parentAuto, type, ctx, path);

  if (s.absolute && parentAuto) (node as any).layoutPositioning = "ABSOLUTE";
  if (!parentAuto || s.absolute) {
    if (typeof s.x === "number") node.x = s.x;
    if (typeof s.y === "number") node.y = s.y;
  }
  if (s.grow && parentAuto) (node as any).layoutGrow = 1;
  if (typeof s.rotation === "number") node.rotation = s.rotation;
  if (s.visible === false) node.visible = false;
  if (s.locked) node.locked = true;
  if (s.modes) await applyModes(node, s.modes, ctx.warnings, path);

  if (s.name) {
    let key = String(s.name);
    for (let n = 2; ctx.ids[key]; n++) key = s.name + " #" + n;
    if (Object.keys(ctx.ids).length < 300) ctx.ids[key] = node.id;
  }
  return node;
}

async function setupFrame(f: FrameNode, s: any, ctx: Ctx, path: string) {
  f.fills = [];
  const layout = String(s.layout || s.direction || "").toLowerCase();
  const mode = layout === "row" || layout === "horizontal" ? "HORIZONTAL" : layout === "column" || layout === "col" || layout === "vertical" ? "VERTICAL" : "NONE";
  f.clipsContent = !!s.clip;
  if (mode !== "NONE") {
    f.layoutMode = mode;
    f.primaryAxisSizingMode = "AUTO";
    f.counterAxisSizingMode = "AUTO";
    if (s.gap !== undefined) {
      if (s.gap === "auto") f.primaryAxisAlignItems = "SPACE_BETWEEN";
      else await setNumber(f, "itemSpacing", s.gap);
    }
    if (s.padding !== undefined) await setPadding(f, s.padding);
    const justify: any = { start: "MIN", center: "CENTER", end: "MAX", between: "SPACE_BETWEEN" };
    const align: any = { start: "MIN", center: "CENTER", end: "MAX", baseline: "BASELINE" };
    if (s.justify && justify[s.justify]) f.primaryAxisAlignItems = justify[s.justify];
    if (s.align && align[s.align]) f.counterAxisAlignItems = align[s.align];
    if (s.wrap && mode === "HORIZONTAL") {
      f.layoutWrap = "WRAP";
      if (s.rowGap !== undefined) await setNumber(f, "counterAxisSpacing", s.rowGap);
    }
  } else if (s.w === undefined && s.width === undefined && s.size === undefined) {
    f.resize(100, 100);
  }
  const children: any[] = Array.isArray(s.children) ? s.children : [];
  for (let i = 0; i < children.length; i++) {
    try {
      await createNode(children[i], f, ctx, path + ".children[" + i + "]");
    } catch (e) {
      if ((e as any).code === "TOO_LARGE") throw e;
      ctx.warnings.push(path + ".children[" + i + "]: " + ((e as Error).message || e));
    }
  }
}

async function setupText(t: TextNode, s: any, ctx: Ctx) {
  const wanted = fontKey(s, ctx);
  t.fontName = ctx.fonts[wanted.family + ":" + wanted.style] || { family: "Inter", style: "Regular" };
  t.characters = String(s.text === undefined ? "" : s.text);
  t.fontSize = typeof s.size === "number" ? s.size : ctx.defaults.size;
  if (s.lineHeight !== undefined) t.lineHeight = lineHeight(s.lineHeight);
  if (s.letterSpacing !== undefined) {
    const ls = String(s.letterSpacing);
    t.letterSpacing = /%$/.test(ls) ? { value: parseFloat(ls), unit: "PERCENT" } : { value: Number(s.letterSpacing), unit: "PIXELS" };
  }
  const halign: any = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" };
  if (s.align && halign[s.align]) t.textAlignHorizontal = halign[s.align];
  const valign: any = { top: "TOP", center: "CENTER", bottom: "BOTTOM" };
  if (s.valign && valign[s.valign]) t.textAlignVertical = valign[s.valign];
  if (s.decoration === "underline") t.textDecoration = "UNDERLINE";
  if (s.decoration === "strike" || s.decoration === "strikethrough") t.textDecoration = "STRIKETHROUGH";
  const cases: any = { upper: "UPPER", lower: "LOWER", title: "TITLE" };
  if (s.case && cases[s.case]) t.textCase = cases[s.case];
  if (typeof s.maxLines === "number") {
    t.textTruncation = "ENDING";
    t.maxLines = s.maxLines;
  }
  if (s.fill === undefined && s.color === undefined && !s.textStyle) t.fills = [solid(ctx.defaults.color)];
  if (s.textStyle) {
    const style = (await findStyle("text", stripPrefix(s.textStyle))) as TextStyle;
    await loadFont(style.fontName);
    await t.setTextStyleIdAsync(style.id);
  }
}

async function setupImage(r: RectangleNode, s: any, ctx: Ctx, path: string) {
  const bytes = ctx.images[s.imageKey];
  if (!bytes) throw codeError(path + ": image data missing (use `src` with the build tool)", "BAD_ARGS");
  const image = figma.createImage(bytes);
  const size = await image.getSizeAsync();
  let w = num(s.w, s.width, 0);
  let h = num(s.h, s.height, 0);
  if (!w && !h) {
    w = size.width;
    h = size.height;
  } else if (!h) h = (w * size.height) / size.width;
  else if (!w) w = (h * size.width) / size.height;
  r.resize(Math.max(1, w), Math.max(1, h));
  const modes: any = { fill: "FILL", fit: "FIT", crop: "CROP", tile: "TILE" };
  r.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: modes[String(s.fit || "fill").toLowerCase()] || "FILL" }];
  if (!s.name) r.name = "Image";
}

async function createInstance(s: any, path: string): Promise<InstanceNode> {
  const ref = String(s.component);
  let comp: ComponentNode | ComponentSetNode | null = null;
  if (/^[\dI;:]+$/.test(ref)) {
    const n = await figma.getNodeByIdAsync(ref);
    if (n && (n.type === "COMPONENT" || n.type === "COMPONENT_SET")) comp = n;
  } else if (/^[0-9a-f]{40}$/i.test(ref)) {
    comp = await figma.importComponentByKeyAsync(ref);
  } else {
    const list = await localComponents();
    for (let i = 0; i < list.length && !comp; i++) if (list[i].name === ref) comp = list[i];
    for (let i = 0; i < list.length && !comp; i++) if (list[i].name.toLowerCase() === ref.toLowerCase()) comp = list[i];
  }
  if (!comp) throw codeError(path + ': component "' + ref + '" not found. Use get_design_system to list components.', "NOT_FOUND");
  const main = comp.type === "COMPONENT_SET" ? comp.defaultVariant : comp;
  const inst = main.createInstance();
  if (s.props && typeof s.props === "object") {
    const defs = inst.componentProperties;
    const out: { [key: string]: string | boolean } = {};
    const keys = Object.keys(s.props);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      let real = defs[k] ? k : "";
      if (!real) {
        const all = Object.keys(defs);
        for (let j = 0; j < all.length && !real; j++) if (all[j].split("#")[0] === k) real = all[j];
      }
      if (real) out[real] = s.props[k];
    }
    if (Object.keys(out).length) inst.setProperties(out);
  }
  return inst;
}

/** Sets the text of named text layers inside an instance: { "Label": "Buy now" }. */
async function overrideTexts(inst: InstanceNode, texts: any, ctx: Ctx) {
  const names = Object.keys(texts);
  for (let i = 0; i < names.length; i++) {
    const t = inst.findOne(function (n) {
      return n.type === "TEXT" && n.name === names[i];
    }) as TextNode | null;
    if (!t) {
      ctx.warnings.push('No text layer "' + names[i] + '" in instance "' + inst.name + '"');
      continue;
    }
    const fonts = t.characters.length ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName as FontName];
    await Promise.all(fonts.map(loadFont));
    t.characters = String(texts[names[i]]);
  }
}

// ─── Visual properties ──────────────────────────────────────────────────────

async function applyVisuals(node: any, s: any, ctx: Ctx, type: string) {
  const fill = s.fill !== undefined ? s.fill : type === "text" ? s.color : undefined;
  if (fill !== undefined && "fills" in node && type !== "image") await setPaints(node, "fills", fill);
  if (s.stroke !== undefined && "strokes" in node) {
    await setPaints(node, "strokes", s.stroke);
    node.strokeWeight = typeof s.strokeWidth === "number" ? s.strokeWidth : 1;
    if ("strokeAlign" in node && type !== "line" && type !== "text") {
      node.strokeAlign = String(s.strokeAlign || "inside").toUpperCase();
    }
  }
  if (s.radius !== undefined && "cornerRadius" in node) {
    if (Array.isArray(s.radius)) {
      const r = s.radius;
      await setNumber(node, "topLeftRadius", r[0]);
      await setNumber(node, "topRightRadius", r[1] === undefined ? r[0] : r[1]);
      await setNumber(node, "bottomRightRadius", r[2] === undefined ? r[0] : r[2]);
      await setNumber(node, "bottomLeftRadius", r[3] === undefined ? (r[1] === undefined ? r[0] : r[1]) : r[3]);
    } else if (typeof s.radius === "string" && s.radius.indexOf("var:") === 0) {
      const fields = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
      for (let i = 0; i < fields.length; i++) await setNumber(node, fields[i], s.radius);
    } else {
      node.cornerRadius = Number(s.radius);
    }
  }
  if (typeof s.opacity === "number") node.opacity = s.opacity;
  if ("effects" in node && (s.shadow !== undefined || s.blur !== undefined)) {
    if (typeof s.shadow === "string" && s.shadow.indexOf("style:") === 0) {
      const style = await findStyle("effect", stripPrefix(s.shadow));
      await node.setEffectStyleIdAsync(style.id);
    } else {
      const effects: Effect[] = [];
      const shadows = s.shadow === true ? [SHADOW_DEFAULT] : Array.isArray(s.shadow) ? s.shadow : s.shadow ? [s.shadow] : [];
      for (let i = 0; i < shadows.length; i++) effects.push(shadowEffect(shadows[i]));
      if (typeof s.blur === "number") effects.push({ type: "LAYER_BLUR", radius: s.blur, visible: true } as Effect);
      if (typeof s.backgroundBlur === "number") effects.push({ type: "BACKGROUND_BLUR", radius: s.backgroundBlur, visible: true } as Effect);
      node.effects = effects;
    }
  }
}

export function shadowEffect(sh: any): Effect {
  const c = parseHex(sh.color || SHADOW_DEFAULT.color);
  return {
    type: sh.inner ? "INNER_SHADOW" : "DROP_SHADOW",
    color: { r: c.r, g: c.g, b: c.b, a: c.a },
    offset: { x: num(sh.x, undefined, 0), y: num(sh.y, undefined, 4) },
    radius: num(sh.blur, undefined, 16),
    spread: num(sh.spread, undefined, 0),
    visible: true,
    blendMode: "NORMAL",
  } as Effect;
}

export function stripPrefix(v: string): string {
  return String(v).replace(/^(style|var):/, "");
}

function solid(hex: string): SolidPaint {
  const c = parseHex(hex);
  return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

/** "#hex", "style:Name", "var:Name", {gradient:[...], angle}, Paint objects, null / "none", or an array of these. */
async function setPaints(node: any, field: "fills" | "strokes", value: any) {
  if (typeof value === "string" && value.indexOf("style:") === 0) {
    const style = await findStyle("paint", stripPrefix(value));
    if (field === "fills") await node.setFillStyleIdAsync(style.id);
    else await node.setStrokeStyleIdAsync(style.id);
    return;
  }
  const list = value === null || value === "none" ? [] : Array.isArray(value) ? value : [value];
  const paints: Paint[] = [];
  for (let i = 0; i < list.length; i++) paints.push(await toPaint(list[i]));
  node[field] = paints;
}

export async function toPaint(v: any): Promise<Paint> {
  if (typeof v === "string") {
    if (v.indexOf("var:") === 0) {
      const variable = await findVariable(stripPrefix(v));
      return figma.variables.setBoundVariableForPaint(solid("#000000"), "color", variable);
    }
    return solid(v);
  }
  if (v && Array.isArray(v.gradient)) {
    const stops = v.gradient.map(function (c: any, i: number, all: any[]) {
      const hex = typeof c === "string" ? c : c.color;
      const pos = typeof c === "object" && typeof c.at === "number" ? c.at : all.length === 1 ? 0 : i / (all.length - 1);
      const rgba = parseHex(hex);
      return { position: pos, color: { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a } };
    });
    const radial = v.type === "radial";
    const a = ((typeof v.angle === "number" ? v.angle : 90) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const transform: Transform = radial
      ? [
          [1, 0, 0],
          [0, 1, 0],
        ]
      : [
          [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
          [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos],
        ];
    return { type: radial ? "GRADIENT_RADIAL" : "GRADIENT_LINEAR", gradientTransform: transform, gradientStops: stops } as GradientPaint;
  }
  if (v && typeof v.type === "string") return v as Paint;
  throw codeError("Invalid paint: " + JSON.stringify(v), "BAD_ARGS");
}

/** Sets a numeric property, or binds it to a variable when given "var:Name". */
async function setNumber(node: any, field: string, value: any) {
  if (typeof value === "string" && value.indexOf("var:") === 0) {
    const variable = await findVariable(stripPrefix(value));
    node.setBoundVariable(field, variable);
  } else {
    node[field] = Number(value);
  }
}

async function setPadding(f: FrameNode, p: any) {
  const v = Array.isArray(p) ? p : [p];
  const top = v[0];
  const right = v[1] === undefined ? v[0] : v[1];
  const bottom = v[2] === undefined ? v[0] : v[2];
  const left = v[3] === undefined ? right : v[3];
  await setNumber(f, "paddingTop", top);
  await setNumber(f, "paddingRight", right);
  await setNumber(f, "paddingBottom", bottom);
  await setNumber(f, "paddingLeft", left);
}

export function lineHeight(v: any): LineHeight {
  if (v === "auto") return { unit: "AUTO" };
  const s = String(v);
  if (/%$/.test(s)) return { value: parseFloat(s), unit: "PERCENT" };
  const n = Number(v);
  // Small numbers read as a multiplier (1.5 → 150%), larger ones as pixels.
  return n <= 4 ? { value: n * 100, unit: "PERCENT" } : { value: n, unit: "PIXELS" };
}

function num(a: any, b: any, fallback: number): number {
  if (typeof a === "number") return a;
  if (typeof b === "number") return b;
  return fallback;
}

function sizing(v: any): "FIXED" | "HUG" | "FILL" | null {
  if (typeof v === "number") return "FIXED";
  if (v === "fill") return "FILL";
  if (v === "hug") return "HUG";
  return null;
}

function applySize(node: any, s: any, parentAuto: boolean, type: string, ctx: Ctx, path: string) {
  let w = s.w !== undefined ? s.w : s.width;
  let h = s.h !== undefined ? s.h : s.height;
  if (typeof s.size === "number" && type !== "text") {
    if (w === undefined) w = s.size;
    if (h === undefined) h = s.size;
  }
  if (typeof w === "number" || typeof h === "number") {
    if (type === "svg" || type === "icon") {
      const ratio = node.height ? node.width / node.height : 1;
      const nw = typeof w === "number" ? w : (h as number) * ratio;
      const nh = typeof h === "number" ? h : (w as number) / ratio;
      node.rescale(Math.min(nw / node.width, nh / node.height));
    } else if (type !== "line" && type !== "image") {
      node.resize(Math.max(0.01, typeof w === "number" ? w : node.width), Math.max(0.01, typeof h === "number" ? h : node.height));
    }
  }
  if (type === "text") {
    const t = node as TextNode;
    t.textAutoResize = typeof w === "number" || w === "fill" ? (typeof h === "number" ? "NONE" : "HEIGHT") : "WIDTH_AND_HEIGHT";
  }
  if (!("layoutSizingHorizontal" in node)) return;
  const hs = sizing(w);
  const vs = sizing(h);
  const trySet = function (field: string, value: string) {
    if (value === "FILL" && !parentAuto) {
      ctx.warnings.push(path + ': "fill" needs an auto-layout parent, ignored');
      return;
    }
    if (value === "HUG" && !isAutoLayout(node) && type !== "text") return;
    try {
      node[field] = value;
    } catch (e) {
      ctx.warnings.push(path + ": " + field + " " + value + " not applicable");
    }
  };
  if (hs) trySet("layoutSizingHorizontal", hs);
  if (vs) trySet("layoutSizingVertical", vs);
}

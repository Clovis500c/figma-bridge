// Declarative builder: turns a JSON layout spec into Figma nodes in one pass.
import {
  checkCancelled,
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
import { createCodeBlock, createConnector, createShape, createSlide, createSticky, createTable, requireEditor } from "./figjam";
import { applyBuildReactions } from "./prototype";
import { applyModes } from "./tokens";

interface Ctx {
  warnings: string[];
  ids: { [name: string]: string };
  count: number;
  images: { [key: string]: Uint8Array };
  fonts: { [key: string]: FontName };
  defaults: { font: string; color: string; size: number };
  /** Layers with `bind`, linked to component properties once their component exists. */
  binds: { node: SceneNode; bind: any; path: string }[];
  /** Prototype links, applied at the end because destinations may come later in the spec. */
  reactions: { node: SceneNode; reactions: any; path: string }[];
  /** FigJam connectors, created last because they point at nodes by name, key or id. */
  connectors: { spec: any; parent: BaseNode & ChildrenMixin; path: string }[];
  /** key → node id: a stable handle for connectors that layer names can't give. */
  keys: { [key: string]: string };
  requestId?: string;
  total: number;
  lastProgress: number;
}

const MAX_NODES = 3000;
const SHADOW_DEFAULT = { x: 0, y: 4, blur: 16, spread: 0, color: "#0000001F" };

export async function build(p: any, _timeoutMs?: number, requestId?: string) {
  const spec = p.spec;
  if (!spec || typeof spec !== "object") throw codeError("`spec` must be a node object or an array of node objects", "BAD_ARGS");
  // {slides:[…]} builds a deck: one slide per entry.
  const roots: any[] = Array.isArray(spec)
    ? spec
    : Array.isArray(spec.slides)
      ? spec.slides.map(function (sl: any) {
          return Object.assign({ type: "slide" }, sl);
        })
      : [spec];
  const d = p.defaults || {};
  const ctx: Ctx = {
    warnings: [],
    ids: {},
    count: 0,
    images: p.imageBytes || {},
    fonts: {},
    defaults: { font: d.font || "Inter", color: d.color || "#111111", size: d.size || 14 },
    binds: [],
    reactions: [],
    connectors: [],
    keys: {},
    requestId: requestId,
    total: countNodes(roots),
    lastProgress: 0,
  };
  await preloadFonts(roots, ctx);

  const parent = await parentFor(p.parentId);
  const made: SceneNode[] = [];
  let cursorX: number | null = null;
  for (let i = 0; i < roots.length; i++) {
    const node = await createNode(roots[i], parent, ctx, "spec" + (roots.length > 1 ? "[" + i + "]" : ""));
    if (!node) continue;
    if (node.type !== "SLIDE" && !isAutoLayout(parent) && roots[i].x === undefined && roots[i].y === undefined) {
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
  if (ctx.reactions.length) await applyBuildReactions(ctx.reactions, ctx.ids, ctx.warnings);
  const connectors = await createConnectors(ctx);
  for (let i = 0; i < ctx.binds.length; i++) ctx.warnings.push(ctx.binds[i].path + ": bind needs a component or componentSet ancestor, ignored");
  if (p.select !== false && made.length && parent.type === "PAGE" && parent === figma.currentPage) {
    figma.currentPage.selection = made;
    figma.viewport.scrollAndZoomIntoView(made);
  }
  const out: any = {
    rootId: made.length ? made[0].id : null,
    rootIds: made.map(function (n) {
      return n.id;
    }),
    created: ctx.count + connectors,
    ids: ctx.ids,
  };
  if (ctx.warnings.length) out.warnings = ctx.warnings.slice(0, 50);
  return out;
}

function countNodes(list: any[]): number {
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || typeof s !== "object") continue;
    n++;
    if (Array.isArray(s.children)) n += countNodes(s.children);
    if (Array.isArray(s.variants)) {
      for (let k = 0; k < s.variants.length; k++) n += countNodes([Object.assign({}, s.base || {}, s.variants[k])]);
    }
  }
  return n;
}

/** "n / total layers" in the plugin UI, a few times per second. */
function progress(ctx: Ctx) {
  if (!ctx.requestId) return;
  const now = Date.now();
  if (now - ctx.lastProgress < 150 && ctx.count < ctx.total) return;
  ctx.lastProgress = now;
  figma.ui.postMessage({ t: "progress", id: ctx.requestId, text: Math.min(ctx.count, ctx.total) + " / " + ctx.total + " layers" });
}

// ─── Fonts ──────────────────────────────────────────────────────────────────

function fontKey(s: any, ctx: Ctx): FontName {
  return parseFont(s.font || ctx.defaults.font, s.weight, ctx.defaults.font);
}

/** Font of a rich-text span, or null when it keeps the layer's font. */
function spanFont(s: any, span: any, ctx: Ctx): FontName | null {
  if (!span.font && span.weight === undefined) return null;
  return parseFont(span.font || s.font || ctx.defaults.font, span.weight !== undefined ? span.weight : span.font ? undefined : s.weight, ctx.defaults.font);
}

/** Loads every font of the spec in parallel, with fallbacks when one is missing. */
async function preloadFonts(roots: any[], ctx: Ctx) {
  const wanted: { [key: string]: FontName } = {};
  const walk = function (s: any) {
    if (!s || typeof s !== "object") return;
    if (nodeType(s) === "text") {
      const f = fontKey(s, ctx);
      wanted[f.family + ":" + f.style] = f;
      const spans: any[] = Array.isArray(s.spans) ? s.spans : [];
      for (let i = 0; i < spans.length; i++) {
        const sf = spanFont(s, spans[i] || {}, ctx);
        if (sf) wanted[sf.family + ":" + sf.style] = sf;
      }
    }
    if (Array.isArray(s.children)) s.children.forEach(walk);
    if (Array.isArray(s.variants)) {
      for (let i = 0; i < s.variants.length; i++) walk(Object.assign({}, s.base || {}, s.variants[i], { type: "component" }));
    }
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
    const t = String(s.type).toLowerCase().replace(/[_\s-]/g, "");
    return t === "rectangle" ? "rect" : t === "circle" ? "ellipse" : t === "variants" ? "componentset" : t === "shapewithtext" ? "shape" : t === "code" ? "codeblock" : t;
  }
  if (Array.isArray(s.variants)) return "componentset";
  if (s.text !== undefined || Array.isArray(s.spans)) return "text";
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
  checkCancelled(ctx.requestId);
  const type = nodeType(s);
  requireEditor(type, path);
  let node: SceneNode;
  switch (type) {
    case "connector":
      // Created at the end: its ends may come later in the spec.
      ctx.connectors.push({ spec: s, parent: parent, path: path });
      return null;
    case "sticky":
      node = await createSticky(s);
      break;
    case "shape":
      node = await createShape(s, path, ctx.warnings);
      break;
    case "table":
      node = await createTable(s, path);
      break;
    case "codeblock":
      node = createCodeBlock(s);
      break;
    case "section":
      node = figma.createSection();
      break;
    case "slide":
      node = createSlide();
      break;
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
    case "componentset":
      node = await createComponentSet(s, parent, ctx, path);
      break;
    default:
      throw codeError(path + ': unknown type "' + s.type + '"', "BAD_ARGS");
  }
  ctx.count++;
  progress(ctx);
  // Slides live in the slide grid, where createSlide puts them.
  if (type !== "slide" || parent.type !== "PAGE") parent.appendChild(node);
  const parentAuto = isAutoLayout(parent);
  if (s.key !== undefined) ctx.keys[String(s.key)] = node.id;
  if (s.bind) ctx.binds.push({ node: node, bind: s.bind, path: path });
  const bindStart = ctx.binds.length;

  if (s.name) node.name = String(s.name);
  else if (type === "icon") node.name = "icon/" + s.icon;
  else if (type === "frame" || type === "component") node.name = roleName(s);

  if (type === "frame" || type === "component") await setupFrame(node as FrameNode, s, ctx, path);
  else if (type === "slide") await setupFrame(node as any, s, ctx, path, true);
  else if (type === "section") await setupSection(node as SectionNode, s, ctx, path);
  else if (type === "componentset") await setupLayout(node as ComponentSetNode, Object.assign({ layout: "row", wrap: true, gap: 16, padding: 16 }, s), ctx, path);
  else if (type === "text") await setupText(node as TextNode, s, ctx);
  else if (type === "image") await setupImage(node as RectangleNode, s, ctx, path);
  else if (type === "line") {
    (node as LineNode).resize(num(s.w, s.width, 100), 0);
    if (s.stroke === undefined) (node as LineNode).strokes = [solid(ctx.defaults.color)];
  } else if ((type === "rect" || type === "ellipse") && s.w === undefined && s.width === undefined && s.size === undefined) {
    (node as RectangleNode).resize(100, 100);
  }
  if (type === "instance" && s.text && typeof s.text === "object") await overrideTexts(node as InstanceNode, s.text, ctx);

  if (type === "componentset" && s.stroke === undefined) {
    const set = node as ComponentSetNode;
    set.strokes = [solid("#9747FF")];
    set.dashPattern = [10, 5];
    set.cornerRadius = 5;
  }
  if (FIXED_LOOK.indexOf(type) === -1) await applyVisuals(node, s, ctx, type);
  else if (typeof s.opacity === "number") (node as any).opacity = s.opacity;
  if (type === "text" && Array.isArray(s.spans)) await applySpans(node as TextNode, s, ctx, path);
  if (FIXED_LOOK.indexOf(type) === -1 && type !== "section" && type !== "slide") applySize(node, s, parentAuto, type, ctx, path);
  if (type === "component" && !s.variantOf) await addProperties(node as ComponentNode, s.properties, ctx.binds.splice(bindStart), ctx, path);
  if ((parent as any).layoutMode === "GRID") placeInGrid(node, s, ctx, path);

  if (s.absolute && parentAuto) (node as any).layoutPositioning = "ABSOLUTE";
  if (!parentAuto || s.absolute) {
    if (typeof s.x === "number") node.x = s.x;
    if (typeof s.y === "number") node.y = s.y;
  }
  if (s.grow && parentAuto) (node as any).layoutGrow = 1;
  if (typeof s.rotation === "number" && "rotation" in node) (node as any).rotation = s.rotation;
  if (s.visible === false) node.visible = false;
  if (s.locked) node.locked = true;
  if (s.modes) await applyModes(node, s.modes, ctx.warnings, path);
  if (s.reactions) ctx.reactions.push({ node: node, reactions: s.reactions, path: path });

  if (s.name) {
    let key = String(s.name);
    for (let n = 2; ctx.ids[key]; n++) key = s.name + " #" + n;
    if (Object.keys(ctx.ids).length < 300) ctx.ids[key] = node.id;
  }
  return node;
}

/** A name from what an unnamed frame does, never Figma's "Frame 12". */
function roleName(s: any): string {
  const layout = String(s.layout || s.direction || "").toLowerCase();
  if (layout === "grid") return "Grid";
  if (layout === "row" || layout === "horizontal") return "Row";
  if (layout === "column" || layout === "col" || layout === "vertical") return "Column";
  return Array.isArray(s.children) && s.children.length ? "Container" : "Box";
}

/** FigJam nodes with their own look (set when created): no generic fills, radius or resizing. */
const FIXED_LOOK = ["sticky", "shape", "table", "codeblock"];

async function setupFrame(f: FrameNode, s: any, ctx: Ctx, path: string, keepFills?: boolean) {
  if (!keepFills) f.fills = [];
  await setupLayout(f, s, ctx, path);
  const children: any[] = Array.isArray(s.children) ? s.children : [];
  for (let i = 0; i < children.length; i++) {
    try {
      await createNode(children[i], f, ctx, path + ".children[" + i + "]");
    } catch (e) {
      if ((e as any).code === "TOO_LARGE" || (e as any).code === "CANCELLED" || (e as any).code === "WRONG_EDITOR") throw e;
      ctx.warnings.push(path + ".children[" + i + "]: " + ((e as Error).message || e));
    }
  }
}

/** Sections hold freely placed children; without w/h they wrap them with a margin. */
async function setupSection(sec: SectionNode, s: any, ctx: Ctx, path: string) {
  const children: any[] = Array.isArray(s.children) ? s.children : [];
  const made: SceneNode[] = [];
  for (let i = 0; i < children.length; i++) {
    try {
      const n = await createNode(children[i], sec, ctx, path + ".children[" + i + "]");
      if (n) made.push(n);
    } catch (e) {
      if ((e as any).code === "TOO_LARGE" || (e as any).code === "CANCELLED" || (e as any).code === "WRONG_EDITOR") throw e;
      ctx.warnings.push(path + ".children[" + i + "]: " + ((e as Error).message || e));
    }
  }
  const w = num(s.w, s.width, 0);
  const h = num(s.h, s.height, 0);
  if (w && h) {
    sec.resizeWithoutConstraints(w, h);
    return;
  }
  const pad = typeof s.padding === "number" ? s.padding : 40;
  let right = 0;
  let bottom = 0;
  for (let i = 0; i < made.length; i++) {
    right = Math.max(right, made[i].x + made[i].width);
    bottom = Math.max(bottom, made[i].y + made[i].height);
  }
  sec.resizeWithoutConstraints(Math.max(w || right + pad, 100), Math.max(h || bottom + pad, 100));
}

/** Connectors from build specs: {type:"connector", from, to} with layer names, keys or ids. */
async function createConnectors(ctx: Ctx): Promise<number> {
  let made = 0;
  for (let i = 0; i < ctx.connectors.length; i++) {
    const c = ctx.connectors[i];
    const ends: string[] = [];
    const sides = ["from", "to"];
    for (let k = 0; k < 2; k++) {
      const ref = c.spec[sides[k]];
      let id = ref === undefined ? "" : ctx.keys[String(ref)] || ctx.ids[String(ref)] || "";
      if (!id && ref !== undefined && /^[\dI;:]+$/.test(String(ref))) {
        const n = await figma.getNodeByIdAsync(String(ref));
        if (n) id = n.id;
      }
      ends.push(id);
    }
    if (!ends[0] || !ends[1]) {
      ctx.warnings.push(c.path + ': connector ends not found (from "' + c.spec.from + '", to "' + c.spec.to + '")');
      continue;
    }
    try {
      const n = await createConnector(c.spec, ends[0], ends[1]);
      c.parent.appendChild(n);
      if (c.spec.name) n.name = String(c.spec.name);
      made++;
    } catch (e) {
      ctx.warnings.push(c.path + ": " + ((e as Error).message || e));
    }
  }
  return made;
}

async function setupLayout(f: FrameNode | ComponentSetNode, s: any, ctx: Ctx, path: string) {
  const layout = String(s.layout || s.direction || "").toLowerCase();
  let mode: "HORIZONTAL" | "VERTICAL" | "GRID" | "NONE" = layout === "row" || layout === "horizontal" ? "HORIZONTAL" : layout === "column" || layout === "col" || layout === "vertical" ? "VERTICAL" : layout === "grid" ? "GRID" : "NONE";
  f.clipsContent = !!s.clip;
  if (mode === "GRID") {
    if (await setupGrid(f, s, ctx, path)) return;
    if (Array.isArray(s.gridSize)) return placeGridItems(f, s);
    mode = "HORIZONTAL";
    s = Object.assign({}, s, { wrap: true, rowGap: s.rowGap !== undefined ? s.rowGap : s.gap, gap: s.columnGap !== undefined ? s.columnGap : s.gap });
  }
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
  } else if (s.w === undefined && s.width === undefined && s.size === undefined && (f as any).type !== "SLIDE") {
    f.resize(100, 100);
  }
}

// ─── Grid auto-layout ───────────────────────────────────────────────────────

/** Track spec: number (px) → FIXED, "2fr" → FLEX, "hug" → HUG. */
function track(v: any, fallback: "FLEX" | "HUG"): { type: "FLEX" | "FIXED" | "HUG"; value?: number } {
  if (typeof v === "number") return { type: "FIXED", value: v };
  const str = String(v === undefined ? "" : v).toLowerCase();
  if (str === "hug" || str === "auto") return { type: "HUG" };
  const fr = /^([\d.]+)fr$/.exec(str);
  if (fr) return { type: "FLEX", value: parseFloat(fr[1]) };
  const px = /^([\d.]+)(px)?$/.exec(str);
  if (px) return { type: "FIXED", value: parseFloat(px[1]) };
  return fallback === "FLEX" ? { type: "FLEX", value: 1 } : { type: "HUG" };
}

const GRID_FALLBACK = "Figma's grid track API failed (a Figma bug: \"invalid id\"): grids were built as wrapping rows, or at their measured positions for imported pages.";

// Figma's GridTrackSize objects can fail with "Attempted to invoke callback with invalid id", sometimes only after
// a number of calls in the same session. A grid whose tracks can't be read lays its cells out in the wrong place,
// so every grid is checked, and after the first failure grids are skipped for the rest of the session.
let gridTracksBroken = false;

function tracksReadable(f: any): boolean {
  try {
    const t = f.gridColumnSizes[0];
    return !!t && typeof t.type === "string";
  } catch (e) {
    return false;
  }
}

/** Returns false when grid auto-layout is unavailable or unreliable (the caller falls back to a wrapping row). */
async function setupGrid(f: any, s: any, ctx: Ctx, path: string): Promise<boolean> {
  const fallback = function () {
    gridTracksBroken = true;
    try {
      f.layoutMode = "NONE";
    } catch (e) {}
    if (ctx.warnings.indexOf(GRID_FALLBACK) === -1) ctx.warnings.push(GRID_FALLBACK);
    return false;
  };
  if (gridTracksBroken) return fallback();
  try {
    f.layoutMode = "GRID";
  } catch (e) {
    ctx.warnings.push(path + ": grid auto-layout is not available in this Figma version, used a wrapping row");
    return false;
  }
  const kids: any[] = Array.isArray(s.children) ? s.children : [];
  const cols: any[] | null = Array.isArray(s.columns) ? s.columns : null;
  const rows: any[] | null = Array.isArray(s.rows) ? s.rows : null;
  const colCount = Math.max(1, cols ? cols.length : Number(s.columns) || 2);
  let cells = 0;
  for (let i = 0; i < kids.length; i++) cells += spanOf(kids[i], "col") * spanOf(kids[i], "row");
  const rowCount = Math.max(1, rows ? rows.length : Number(s.rows) || Math.ceil(cells / colCount));
  const fixedW = typeof s.w === "number" || typeof s.width === "number" || s.w === "fill";
  const fixedH = typeof s.h === "number" || typeof s.height === "number" || s.h === "fill";
  const set = function (what: string, fn: () => void) {
    try {
      fn();
    } catch (e) {
      ctx.warnings.push(path + ": grid " + what + ": " + ((e as Error).message || e));
    }
  };
  set("columns", function () {
    f.gridColumnCount = colCount;
  });
  set("rows", function () {
    f.gridRowCount = rowCount;
  });
  if (!tracksReadable(f)) return fallback();
  // Flexible tracks need a fixed container size; otherwise tracks hug their content.
  // A failed track write leaves a grid that misplaces and rejects its children: fall back instead.
  try {
    for (let i = 0; i < colCount; i++) applyTrack(f, "gridColumnSizes", i, track(cols ? cols[i] : undefined, fixedW ? "FLEX" : "HUG"));
    for (let i = 0; i < rowCount; i++) applyTrack(f, "gridRowSizes", i, track(rows ? rows[i] : undefined, fixedH ? "FLEX" : "HUG"));
  } catch (e) {
    return fallback();
  }
  if (!fixedW) set("sizing", function () {
    f.layoutSizingHorizontal = "HUG";
  });
  if (!fixedH) set("sizing", function () {
    f.layoutSizingVertical = "HUG";
  });
  if ("gridItemsPositioning" in f) set("auto flow", function () {
    f.gridItemsPositioning = "ROW_AUTO_FLOW";
  });
  const colGap = s.columnGap !== undefined ? s.columnGap : s.gap;
  const rowGap = s.rowGap !== undefined ? s.rowGap : s.gap;
  if (colGap !== undefined && colGap !== "auto") await setNumber(f, "gridColumnGap", colGap);
  if (rowGap !== undefined && rowGap !== "auto") await setNumber(f, "gridRowGap", rowGap);
  if (s.padding !== undefined) await setPadding(f, s.padding);
  return true;
}

/** Fallback for imported grids: the measured boxes (gridSize, children place) as free positions. */
function placeGridItems(f: FrameNode | ComponentSetNode, s: any) {
  if (s.w === "hug" || s.w === undefined) s.w = s.gridSize[0];
  if (s.h === "hug" || s.h === undefined) s.h = s.gridSize[1];
  const kids: any[] = Array.isArray(s.children) ? s.children : [];
  for (let i = 0; i < kids.length; i++) {
    const p = kids[i] && kids[i].place;
    if (!Array.isArray(p)) continue;
    kids[i].x = p[0];
    kids[i].y = p[1];
    kids[i].w = p[2];
    if (kids[i].type !== "text" || kids[i].h !== undefined) kids[i].h = p[3];
  }
}

// A GridTrackSize object goes stale once one of its properties changes: read the track again for every write.
function applyTrack(f: any, field: "gridColumnSizes" | "gridRowSizes", i: number, spec: { type: string; value?: number }) {
  if (!f[field][i]) return;
  if (f[field][i].type !== spec.type) f[field][i].type = spec.type;
  if (spec.value !== undefined && spec.type !== "HUG" && f[field][i].value !== spec.value) f[field][i].value = spec.value;
}

function spanOf(s: any, axis: "col" | "row"): number {
  if (!s || typeof s !== "object") return 1;
  if (Array.isArray(s.span)) return Math.max(1, Number(axis === "row" ? s.span[0] : s.span[1]) || 1);
  const v = axis === "col" ? (s.colSpan !== undefined ? s.colSpan : s.span) : s.rowSpan;
  return Math.max(1, Number(v) || 1);
}

function placeInGrid(node: any, s: any, ctx: Ctx, path: string) {
  try {
    if (spanOf(s, "col") > 1) node.gridColumnSpan = spanOf(s, "col");
    if (spanOf(s, "row") > 1) node.gridRowSpan = spanOf(s, "row");
    const align: any = { start: "MIN", center: "CENTER", end: "MAX" };
    if (s.cellAlign && align[s.cellAlign]) node.gridChildHorizontalAlign = align[s.cellAlign];
    if (s.cellValign && align[s.cellValign]) node.gridChildVerticalAlign = align[s.cellValign];
  } catch (e) {
    ctx.warnings.push(path + ": grid span: " + ((e as Error).message || e));
  }
}

async function setupText(t: TextNode, s: any, ctx: Ctx) {
  const wanted = fontKey(s, ctx);
  t.fontName = ctx.fonts[wanted.family + ":" + wanted.style] || { family: "Inter", style: "Regular" };
  const spans: any[] = Array.isArray(s.spans) ? s.spans : [];
  t.characters = spans.length
    ? spans
        .map(function (sp: any) {
          return sp && sp.text !== undefined ? String(sp.text) : "";
        })
        .join("")
    : String(s.text === undefined ? "" : s.text);
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

/** Rich text: per-range font, size, color, decoration and link. */
async function applySpans(t: TextNode, s: any, ctx: Ctx, path: string) {
  let at = 0;
  for (let i = 0; i < s.spans.length; i++) {
    const sp = s.spans[i] || {};
    const end = at + String(sp.text === undefined ? "" : sp.text).length;
    if (end === at) continue;
    try {
      const f = spanFont(s, sp, ctx);
      if (f) t.setRangeFontName(at, end, ctx.fonts[f.family + ":" + f.style] || f);
      if (typeof sp.size === "number") t.setRangeFontSize(at, end, sp.size);
      const color = sp.color !== undefined ? sp.color : sp.fill;
      if (typeof color === "string" && color.indexOf("style:") === 0) {
        await t.setRangeFillStyleIdAsync(at, end, (await findStyle("paint", stripPrefix(color))).id);
      } else if (color !== undefined) {
        t.setRangeFills(at, end, [await toPaint(color, ctx.images)]);
      }
      const deco: any = { underline: "UNDERLINE", strike: "STRIKETHROUGH", strikethrough: "STRIKETHROUGH", none: "NONE" };
      if (sp.link) {
        t.setRangeHyperlink(at, end, { type: "URL", value: String(sp.link) });
        if (sp.decoration === undefined) t.setRangeTextDecoration(at, end, "UNDERLINE");
      }
      if (sp.decoration && deco[sp.decoration]) t.setRangeTextDecoration(at, end, deco[sp.decoration]);
      const cases: any = { upper: "UPPER", lower: "LOWER", title: "TITLE", none: "ORIGINAL" };
      if (sp.case && cases[sp.case]) t.setRangeTextCase(at, end, cases[sp.case]);
    } catch (e) {
      ctx.warnings.push(path + ".spans[" + i + "]: " + ((e as Error).message || e));
    }
    at = end;
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

async function findComponent(ref: string, path: string): Promise<ComponentNode | ComponentSetNode> {
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
  return comp;
}

async function createInstance(s: any, path: string): Promise<InstanceNode> {
  const comp = await findComponent(String(s.component), path);
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

// ─── Components with variants and properties ────────────────────────────────

/** {variants:[{props:{Size:"M"}, ...frame spec}], base?, properties?}: one component per variant, combined as a set. */
async function createComponentSet(s: any, parent: BaseNode & ChildrenMixin, ctx: Ctx, path: string): Promise<ComponentSetNode> {
  const variants: any[] = Array.isArray(s.variants) ? s.variants : [];
  if (!variants.length) throw codeError(path + ': a componentSet needs variants:[{props:{Variant:"Primary"}, ...}]', "BAD_ARGS");
  const start = ctx.binds.length;
  const comps: ComponentNode[] = [];
  for (let i = 0; i < variants.length; i++) {
    const v = Object.assign({}, s.base || {}, variants[i] || {});
    const props = v.props || {};
    const keys = Object.keys(props);
    if (!keys.length) throw codeError(path + ".variants[" + i + ']: props:{Name:"value"} is required', "BAD_ARGS");
    const spec = Object.assign({}, v, {
      type: "component",
      variantOf: true,
      name: keys
        .map(function (k) {
          return k + "=" + props[k];
        })
        .join(", "),
    });
    delete spec.props;
    comps.push((await createNode(spec, parent, ctx, path + ".variants[" + i + "]")) as ComponentNode);
  }
  const set = figma.combineAsVariants(comps, parent);
  set.name = String(s.name || "Component");
  await addProperties(set, s.properties, ctx.binds.splice(start), ctx, path);
  return set;
}

/**
 * properties: {Label:"Button" | {type:"text"|"boolean"|"instance", default, preferred?}}.
 * bind on a layer: "Label" (text → characters, boolean → visible, instance → mainComponent)
 * or {characters|visible|mainComponent: "Property"}. An unknown text binding creates the property.
 */
async function addProperties(owner: ComponentNode | ComponentSetNode, properties: any, binds: { node: SceneNode; bind: any; path: string }[], ctx: Ctx, path: string) {
  const keys: { [name: string]: string } = {};
  const types: { [name: string]: string } = {};
  const props = properties && typeof properties === "object" ? properties : {};
  const names = Object.keys(props);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    let def = props[name];
    if (typeof def === "string") def = { type: "text", default: def };
    else if (typeof def === "boolean") def = { type: "boolean", default: def };
    const t = String(def.type || "text").toLowerCase();
    try {
      if (t === "boolean" || t === "bool") {
        keys[name] = owner.addComponentProperty(name, "BOOLEAN", def.default !== false);
        types[name] = "BOOLEAN";
      } else if (t === "instance" || t === "instance_swap" || t === "swap") {
        const comp = await findComponent(String(def.default), path + ".properties." + name);
        const main = comp.type === "COMPONENT_SET" ? comp.defaultVariant : comp;
        const preferred: InstanceSwapPreferredValue[] = [];
        const list: any[] = Array.isArray(def.preferred) ? def.preferred : [];
        for (let k = 0; k < list.length; k++) {
          const p = await findComponent(String(list[k]), path + ".properties." + name);
          preferred.push({ type: p.type === "COMPONENT_SET" ? "COMPONENT_SET" : "COMPONENT", key: p.key });
        }
        keys[name] = owner.addComponentProperty(name, "INSTANCE_SWAP", main.id, preferred.length ? { preferredValues: preferred } : undefined);
        types[name] = "INSTANCE_SWAP";
      } else {
        keys[name] = owner.addComponentProperty(name, "TEXT", String(def.default === undefined ? "" : def.default));
        types[name] = "TEXT";
      }
    } catch (e) {
      ctx.warnings.push(path + ".properties." + name + ": " + ((e as Error).message || e));
    }
  }
  for (let i = 0; i < binds.length; i++) {
    const b = binds[i];
    const map: any = typeof b.bind === "string" ? { auto: b.bind } : b.bind;
    const refs: any = {};
    const fields = Object.keys(map || {});
    for (let k = 0; k < fields.length; k++) {
      const prop = String(map[fields[k]]);
      let field = fields[k];
      if (!keys[prop] && b.node.type === "TEXT" && (field === "auto" || field === "characters")) {
        keys[prop] = owner.addComponentProperty(prop, "TEXT", b.node.characters);
        types[prop] = "TEXT";
      }
      if (!keys[prop]) {
        ctx.warnings.push(b.path + ': no component property "' + prop + '" (declare it in properties)');
        continue;
      }
      if (field === "auto") field = types[prop] === "TEXT" ? "characters" : types[prop] === "BOOLEAN" ? "visible" : "mainComponent";
      refs[field] = keys[prop];
    }
    if (!Object.keys(refs).length) continue;
    try {
      (b.node as any).componentPropertyReferences = Object.assign({}, (b.node as any).componentPropertyReferences || {}, refs);
    } catch (e) {
      ctx.warnings.push(b.path + ": bind: " + ((e as Error).message || e));
    }
  }
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
  if (fill !== undefined && "fills" in node && type !== "image") await setPaints(node, "fills", fill, ctx.images);
  if (s.stroke !== undefined && "strokes" in node) {
    await setPaints(node, "strokes", s.stroke, ctx.images);
    if (Array.isArray(s.strokeWidth) && "strokeTopWeight" in node) {
      // [top, right, bottom, left] like padding: one weight per side.
      const w = s.strokeWidth.map(Number);
      node.strokeTopWeight = w[0] || 0;
      node.strokeRightWeight = w[1] === undefined ? w[0] || 0 : w[1] || 0;
      node.strokeBottomWeight = w[2] === undefined ? w[0] || 0 : w[2] || 0;
      node.strokeLeftWeight = w[3] === undefined ? (w[1] === undefined ? w[0] || 0 : w[1] || 0) : w[3] || 0;
    } else {
      node.strokeWeight = typeof s.strokeWidth === "number" ? s.strokeWidth : 1;
    }
    if (Array.isArray(s.strokeDash) && "dashPattern" in node) node.dashPattern = s.strokeDash.map(Number);
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

/** "#hex", "style:Name", "var:Name", {gradient:[...], angle}, {image, fit}, Paint objects, null / "none", or an array of these. */
async function setPaints(node: any, field: "fills" | "strokes", value: any, images?: { [key: string]: Uint8Array }) {
  if (typeof value === "string" && value.indexOf("style:") === 0) {
    const style = await findStyle("paint", stripPrefix(value));
    if (field === "fills") await node.setFillStyleIdAsync(style.id);
    else await node.setStrokeStyleIdAsync(style.id);
    return;
  }
  const list = value === null || value === "none" ? [] : Array.isArray(value) ? value : [value];
  const paints: Paint[] = [];
  for (let i = 0; i < list.length; i++) paints.push(await toPaint(list[i], images));
  node[field] = paints;
}

const FITS: { [fit: string]: "FILL" | "FIT" | "CROP" | "TILE" } = { fill: "FILL", cover: "FILL", fit: "FIT", contain: "FIT", crop: "CROP", tile: "TILE" };

export async function toPaint(v: any, images?: { [key: string]: Uint8Array }): Promise<Paint> {
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
  if (v && v.imageKey !== undefined) {
    // {image: src} in the spec: the server downloads it and sends the bytes under imageKey.
    const bytes = images && images[v.imageKey];
    if (!bytes) throw codeError("Image fill data missing (use {image: src} with the build tool)", "BAD_ARGS");
    const paint: ImagePaint = { type: "IMAGE", imageHash: figma.createImage(bytes).hash, scaleMode: FITS[String(v.fit || "fill").toLowerCase()] || "FILL" };
    if (typeof v.opacity === "number") return Object.assign({}, paint, { opacity: v.opacity });
    return paint;
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

async function setPadding(f: FrameNode | ComponentSetNode, p: any) {
  const v = Array.isArray(p) ? p : [p];
  const top = v[0];
  const right = v[1] === undefined ? v[0] : v[1];
  const bottom = v[2] === undefined ? v[0] : v[2];
  const left = v[3] === undefined ? right : v[3];
  // Figma rejects negative padding (web layouts can produce it from negative margins).
  const clamp = function (x: any) {
    return typeof x === "number" ? Math.max(0, x) : x;
  };
  await setNumber(f, "paddingTop", clamp(top));
  await setNumber(f, "paddingRight", clamp(right));
  await setNumber(f, "paddingBottom", clamp(bottom));
  await setNumber(f, "paddingLeft", clamp(left));
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

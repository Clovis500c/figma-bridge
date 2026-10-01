// Figma Bridge — plugin main thread.
// Syntax stays ES2017 (no ?. ?? object spread or optional catch binding): the sandbox parser is conservative.
import { annotate } from "./lib/annotate";
import { audit } from "./lib/audit";
import { build } from "./lib/build";
import { checkpoint } from "./lib/checkpoint";
import { describe } from "./lib/describe";
import { exportTree } from "./lib/export";
import { getDesignSystem } from "./lib/design-system";
import { designTokens } from "./lib/tokens";
import { exportTokens } from "./lib/tokens-export";
import { find } from "./lib/find";
import { prototype } from "./lib/prototype";
import { robloxImages, robloxTree } from "./lib/roblox";
import { cancelWait, waitForSelection } from "./lib/selection";
import {
  clearCancelled,
  codeError,
  fontNamesOf,
  getNode,
  invalidateCaches,
  loadFont,
  markCancelled,
  pageOf,
  parentFor,
  parseHex,
  place,
  round,
  safeStringify,
  toSafe,
} from "./lib/util";
import { version as VERSION } from "../package.json";

const DEFAULT_SIZE = { width: 340, height: 540 };
const MIN_SIZE = { width: 280, height: 260 };
const MAX_SIZE = { width: 900, height: 1200 };
const COMPACT_HEIGHT = 44;

figma.skipInvisibleInstanceChildren = true;
figma.showUI(__html__, { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, themeColors: true, title: "Figma Bridge" });

const sessionId = randomId();
let size = { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
let compact = false;

function randomId(): string {
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function post(msg: any) {
  figma.ui.postMessage(msg);
}

function sessionInfo() {
  // fileKey (for the optional REST features) is only given to private and development plugins.
  let fileKey: string | undefined;
  try {
    fileKey = figma.fileKey;
  } catch (e) {}
  return { id: sessionId, fileName: figma.root.name, page: figma.currentPage.name, pageId: figma.currentPage.id, editorType: figma.editorType, fileKey: fileKey };
}

function clampSize(w: number, h: number) {
  return {
    width: Math.round(Math.min(MAX_SIZE.width, Math.max(MIN_SIZE.width, Number(w) || DEFAULT_SIZE.width))),
    height: Math.round(Math.min(MAX_SIZE.height, Math.max(MIN_SIZE.height, Number(h) || DEFAULT_SIZE.height))),
  };
}

function applySize() {
  figma.ui.resize(size.width, compact ? COMPACT_HEIGHT : size.height);
}

async function sendInit() {
  const channel = (await figma.clientStorage.getAsync("channel")) || "default";
  const saved = await figma.clientStorage.getAsync("size");
  if (saved) size = clampSize(saved.width, saved.height);
  compact = !!(await figma.clientStorage.getAsync("compact"));
  applySize();
  post({ t: "init", version: VERSION, session: sessionInfo(), settings: { channel: channel, compact: compact } });
}

// A relaunch button in the right panel reopens the bridge in one click.
try {
  if (!figma.root.getRelaunchData().open) figma.root.setRelaunchData({ open: "Connect this file to your AI agent" });
} catch (e) {}

let lastFileName = figma.root.name;
figma.on("currentpagechange", function () {
  post({ t: "info", session: sessionInfo() });
});
setInterval(function () {
  if (figma.root.name !== lastFileName) {
    lastFileName = figma.root.name;
    post({ t: "info", session: sessionInfo() });
  }
}, 3000);

figma.ui.onmessage = function (msg: any) {
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "ready") void sendInit();
  else if (msg.t === "req") void handleRequest(msg);
  else if (msg.t === "set") void figma.clientStorage.setAsync(msg.key, msg.value);
  else if (msg.t === "compact") {
    compact = !!msg.value;
    applySize();
    void figma.clientStorage.setAsync("compact", compact);
  } else if (msg.t === "resize") {
    // Drag from the UI's corner grip; saved once the drag ends.
    size = clampSize(msg.width, msg.height);
    compact = false;
    applySize();
    if (msg.save) void figma.clientStorage.setAsync("size", size);
  } else if (msg.t === "resetSize") {
    size = { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
    applySize();
    void figma.clientStorage.setAsync("size", size);
  } else if (msg.t === "notify") figma.notify(String(msg.text), { timeout: 2500 });
  else if (msg.t === "focus") void focusNode(String(msg.nodeId));
  else if (msg.t === "cancelWait") cancelWait(String(msg.id));
  else if (msg.t === "cancel") {
    // The UI already answered the agent; long commands stop at their next checkpoint.
    markCancelled(String(msg.id));
    cancelWait(String(msg.id));
  }
};

/** Selects a node and zooms to it, switching page if needed ("Show" in the activity log). */
async function focusNode(id: string) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === "DOCUMENT") {
    figma.notify("This layer no longer exists", { timeout: 2000 });
    return;
  }
  const page = pageOf(node);
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  if (node.type === "PAGE") return;
  figma.currentPage.selection = [node as SceneNode];
  figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
}

// ─── Request dispatch ───────────────────────────────────────────────────────

type Handler = (params: any, timeoutMs: number, requestId: string) => Promise<any>;

const HANDLERS: { [method: string]: Handler } = {
  run_script: runScript,
  build: build,
  describe: describe,
  find: find,
  get_design_system: getDesignSystem,
  design_tokens: designTokens,
  export_tokens: exportTokens,
  audit: audit,
  get_css: getCss,
  checkpoint: checkpoint,
  screenshot: screenshot,
  place_image: placeImage,
  import_svg: importSvg,
  get_context: getContext,
  list_fonts: listFonts,
  wait_for_selection: waitForSelection,
  prototype: prototype,
  annotate: annotate,
  export_tree: exportTree,
  node_info: nodeInfo,
  roblox_tree: robloxTree,
  roblox_images: robloxImages,
  ping: function () {
    return Promise.resolve({ pong: true, session: sessionInfo() });
  },
};

// Commands that only some editors support (others get a clear WRONG_EDITOR error).
const EDITORS: { [method: string]: string[] } = {
  prototype: ["figma"],
  annotate: ["figma", "dev"],
  design_tokens: ["figma", "slides"],
  export_tokens: ["figma", "slides", "dev"],
};
const EDITOR_NAMES: { [editor: string]: string } = { figma: "Figma Design", figjam: "FigJam", slides: "Figma Slides", dev: "Dev Mode" };

// Read-only commands don't need their own undo step.
const READ_ONLY: { [method: string]: boolean } = {
  describe: true,
  find: true,
  get_design_system: true,
  export_tokens: true,
  audit: true,
  get_css: true,
  screenshot: true,
  get_context: true,
  list_fonts: true,
  wait_for_selection: true,
  export_tree: true,
  node_info: true,
  roblox_tree: true,
  ping: true,
};

async function handleRequest(msg: any) {
  const started = Date.now();
  // audit is read-only unless it applies fixes.
  const mutates = !READ_ONLY[msg.method] || !!(msg.params && (msg.params.fix === true || (msg.params.fixes && msg.params.fixes.length)));
  let reply: any;
  // Each AI command becomes a single Ctrl+Z step.
  if (mutates) commitUndo();
  try {
    const handler = HANDLERS[msg.method];
    if (!handler) throw codeError("Unknown method: " + msg.method + " (reopen the plugin after updating it)", "UNKNOWN_METHOD");
    const editors = EDITORS[msg.method];
    if (editors && editors.indexOf(figma.editorType) === -1) {
      throw codeError(msg.method + " is not available in " + (EDITOR_NAMES[figma.editorType] || figma.editorType) + " (works in " + editors.map(function (e) {
        return EDITOR_NAMES[e];
      }).join(", ") + ").", "WRONG_EDITOR");
    }
    if (mutates && figma.editorType === "dev") throw codeError("Dev Mode is read-only: switch the file to Design mode to let the agent edit it.", "WRONG_EDITOR");
    const result = await handler(msg.params || {}, Math.min(Number(msg.timeoutMs) || 30000, 120000), String(msg.id));
    reply = { t: "res", id: msg.id, ok: true, result: result };
  } catch (e) {
    reply = Object.assign({ t: "res", id: msg.id, ok: false }, describeError(e));
  }
  if (mutates) {
    commitUndo();
    invalidateCaches();
  }
  clearCancelled(String(msg.id));
  reply.ms = Date.now() - started;
  post(reply);
}

function commitUndo() {
  try {
    figma.commitUndo();
  } catch (e) {}
}

function describeError(e: any) {
  const out: any = {
    error: e && e.message ? String(e.message) : String(e),
    code: (e && e.code) || "PLUGIN_ERROR",
  };
  if (e && e.stack) out.stack = String(e.stack).split("\n").slice(0, 6).join("\n");
  if (e && e.line) out.line = e.line;
  if (e && e.logs && e.logs.length) out.logs = e.logs;
  return out;
}

// ─── run_script ─────────────────────────────────────────────────────────────

const AsyncFunction: any = Object.getPrototypeOf(async function () {}).constructor;
const SCRIPT_ARGS = ["figma", "console", "utils", "lib"];
let lineBase: number | null = null;
let currentConsole: any = console;

// Snippet library sent by the server (saved with the `snippets` tool), compiled once per version.
const lib: { [name: string]: (args?: any) => Promise<any> } = {};
let libHash = "";

function loadLibrary(hash: string, sources: { [name: string]: string }) {
  if (!hash || hash === libHash) return;
  const names = Object.keys(lib);
  for (let i = 0; i < names.length; i++) delete lib[names[i]];
  const keys = Object.keys(sources || {});
  for (let i = 0; i < keys.length; i++) {
    const name = keys[i];
    try {
      const fn = new AsyncFunction("figma", "utils", "lib", "console", "args", sources[name]);
      lib[name] = function (args?: any) {
        return fn(figma, utils, lib, currentConsole, args);
      };
    } catch (e) {
      const message = "Snippet " + name + " does not compile: " + ((e as Error).message || e);
      lib[name] = function () {
        return Promise.reject(new Error(message));
      };
    }
  }
  libHash = hash;
}

function compile(code: string): { fn: any; offset: number } {
  // A lone expression is returned automatically: `figma.currentPage.name` works as-is.
  if (!/\breturn\b/.test(code)) {
    try {
      const expr = code.trim().replace(/;+\s*$/, "");
      return { fn: new AsyncFunction(SCRIPT_ARGS[0], SCRIPT_ARGS[1], SCRIPT_ARGS[2], SCRIPT_ARGS[3], "return (\n" + expr + "\n);"), offset: 1 };
    } catch (e) {}
  }
  return { fn: new AsyncFunction(SCRIPT_ARGS[0], SCRIPT_ARGS[1], SCRIPT_ARGS[2], SCRIPT_ARGS[3], code), offset: 0 };
}

function stackLine(stack: string): number | null {
  const lines = String(stack || "").split("\n");
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (pass === 0 && !/anonymous|eval|<input>/.test(l)) continue;
      const m = /:(\d+)(?::\d+)?\)?\s*$/.exec(l);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

async function scriptLine(e: any, offset: number): Promise<number | undefined> {
  if (lineBase === null) {
    lineBase = 0;
    try {
      await new AsyncFunction("throw new Error('probe')")();
    } catch (probe) {
      const n = stackLine((probe as any).stack);
      if (n !== null) lineBase = n - 1;
    }
  }
  const raw = stackLine(e && e.stack);
  if (raw === null) {
    const m = /line (\d+)/i.exec(String(e && e.message));
    return m ? Number(m[1]) : undefined;
  }
  const line = raw - lineBase - offset;
  return line >= 1 ? line : undefined;
}

async function runScript(p: any, timeoutMs: number) {
  const logs: string[] = [];
  const scriptConsole = makeConsole(logs);
  let compiled = { fn: null as any, offset: 0 };
  let timer: any;
  loadLibrary(p.libHash, p.lib);
  currentConsole = scriptConsole;
  try {
    compiled = compile(String(p.code || ""));
    const value = await Promise.race([
      compiled.fn(figma, scriptConsole, utils, lib),
      new Promise(function (_, reject) {
        timer = setTimeout(function () {
          reject(codeError("Script timed out after " + timeoutMs + " ms (async work may still be running in Figma)", "TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
    const out: any = { result: toSafe(value, 0, []) };
    if (logs.length) out.logs = logs;
    return out;
  } catch (e) {
    const err: any = e instanceof Error ? e : new Error(String(e));
    if (!err.code) err.code = err.name === "SyntaxError" ? "SYNTAX_ERROR" : "SCRIPT_ERROR";
    err.line = await scriptLine(err, compiled.offset);
    err.logs = logs;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function makeConsole(logs: string[]) {
  function add(level: string) {
    return function () {
      const parts: string[] = [];
      for (let i = 0; i < arguments.length; i++) {
        const a = arguments[i];
        parts.push(typeof a === "string" ? a : safeStringify(a));
      }
      if (logs.length < 200) logs.push((level === "log" ? "" : level + ": ") + parts.join(" ").slice(0, 2000));
    };
  }
  return { log: add("log"), info: add("info"), warn: add("warn"), error: add("error"), debug: add("debug") };
}

// ─── Script helpers (`utils`) ───────────────────────────────────────────────

const utils = {
  /** utils.loadFonts('Inter:Bold', {family, style}, textNode, …) — cached per session. */
  loadFonts: async function (...fonts: any[]) {
    const names = fontNamesOf(fonts);
    await Promise.all(names.map(loadFont));
    return names.length;
  },
  node: function (id: string) {
    return figma.getNodeByIdAsync(id);
  },
  page: async function (nameOrId: string) {
    const pages = figma.root.children;
    let page: PageNode | null = null;
    for (let i = 0; i < pages.length; i++) if (pages[i].id === nameOrId || pages[i].name === nameOrId) page = pages[i];
    if (!page) throw new Error("Page not found: " + nameOrId);
    await figma.setCurrentPageAsync(page);
    return page;
  },
  hex: function (hex: string): RGB | RGBA {
    const c = parseHex(hex);
    return c.a === 1 ? { r: c.r, g: c.g, b: c.b } : c;
  },
  solid: function (hex: string, opacity?: number): SolidPaint[] {
    const c = parseHex(hex);
    return [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: opacity === undefined ? c.a : opacity }];
  },
  /** Same spec as the `build` tool (icons and image `src` need the tool itself). */
  build: function (spec: any, options?: any) {
    return build(Object.assign({}, options || {}, { spec: spec, select: options && options.select === true }));
  },
  /** Compact outline of a node tree, like the `describe` tool. */
  describe: async function (node?: any, depth?: number) {
    const id = node && typeof node === "object" ? node.id : node;
    const out = await describe({ nodeId: id, depth: depth });
    return out.outline;
  },
};

// ─── Other commands ─────────────────────────────────────────────────────────

async function getCss(p: any) {
  const node: any = p.nodeId ? await getNode(p.nodeId) : figma.currentPage.selection[0];
  if (!node) throw codeError("No nodeId given and nothing is selected", "BAD_ARGS");
  if (typeof node.getCSSAsync !== "function") throw codeError("A " + node.type + " node has no CSS", "BAD_ARGS");
  const out: any = { nodeId: node.id, name: node.name, css: await node.getCSSAsync() };
  if (p.children && "children" in node) {
    out.children = [];
    const kids = node.children.slice(0, 50);
    for (let i = 0; i < kids.length; i++) {
      out.children.push({ nodeId: kids[i].id, name: kids[i].name, css: await kids[i].getCSSAsync() });
    }
  }
  return out;
}

async function screenshot(p: any) {
  const node: any = p.nodeId ? await getNode(p.nodeId) : figma.currentPage.selection[0];
  if (!node) throw codeError("No nodeId given and nothing is selected", "BAD_ARGS");
  if (typeof node.exportAsync !== "function") throw codeError("A " + node.type + " node cannot be exported", "BAD_ARGS");
  const box = node.absoluteRenderBounds || node.absoluteBoundingBox || { width: node.width || 1, height: node.height || 1 };
  let scale = p.scale || 1;
  // `width` (used by compare) exports at the reference image's resolution.
  if (!p.scale && p.width) scale = Math.max(0.05, Math.min(4, p.width / Math.max(box.width, 1)));
  if (p.maxDimension) scale = Math.min(scale, p.maxDimension / Math.max(box.width, box.height, 1));
  const format = p.format === "JPG" ? "JPG" : "PNG";
  const bytes = await node.exportAsync({ format: format, constraint: { type: "SCALE", value: scale } });
  // The export covers the render bounds (shadows included): offset maps image pixels back to the layer box.
  const bb = node.absoluteBoundingBox;
  const offset = node.absoluteRenderBounds && bb ? { x: round(node.absoluteRenderBounds.x - bb.x), y: round(node.absoluteRenderBounds.y - bb.y) } : { x: 0, y: 0 };
  return { bytes: bytes, format: format, scale: scale, offset: offset, name: node.name, nodeId: node.id };
}

async function placeImage(p: any) {
  if (!(p.bytes instanceof Uint8Array)) throw codeError("No image bytes received", "BAD_ARGS");
  const image = figma.createImage(p.bytes);
  const imgSize = await image.getSizeAsync();
  const paint: ImagePaint = { type: "IMAGE", imageHash: image.hash, scaleMode: p.scaleMode || "FILL" };
  let target: any;
  if (p.nodeId) {
    target = await getNode(p.nodeId);
    if (!("fills" in target)) throw codeError("A " + target.type + " node has no fills", "BAD_ARGS");
    if (p.name) target.name = p.name;
  } else {
    let w = p.width;
    let h = p.height;
    if (!w && !h) {
      w = imgSize.width;
      h = imgSize.height;
    } else if (!h) h = (w * imgSize.height) / imgSize.width;
    else if (!w) w = (h * imgSize.width) / imgSize.height;
    target = figma.createRectangle();
    target.name = p.name || "Image";
    target.resize(Math.max(1, w), Math.max(1, h));
    (await parentFor(p.parentId)).appendChild(target);
    place(target, p.x, p.y);
  }
  target.fills = [paint];
  return {
    nodeId: target.id,
    name: target.name,
    imageHash: image.hash,
    width: round(target.width),
    height: round(target.height),
    imageWidth: imgSize.width,
    imageHeight: imgSize.height,
  };
}

async function importSvg(p: any) {
  if (!p.svg) throw codeError("Empty SVG", "BAD_ARGS");
  const node = figma.createNodeFromSvg(String(p.svg));
  if (p.name) node.name = p.name;
  (await parentFor(p.parentId)).appendChild(node);
  if (typeof p.size === "number" && node.height > 0) node.rescale(p.size / Math.max(node.width, node.height));
  if (!("layoutMode" in node.parent! && (node.parent as any).layoutMode !== "NONE")) place(node, p.x, p.y);
  return { nodeId: node.id, name: node.name, width: round(node.width), height: round(node.height) };
}

function bounds(n: any) {
  const b = n.absoluteBoundingBox;
  return b ? { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) } : null;
}

async function getContext() {
  const sel = figma.currentPage.selection;
  const vb = figma.viewport.bounds;
  return {
    fileName: figma.root.name,
    pages: figma.root.children.map(function (pg) {
      return { id: pg.id, name: pg.name };
    }),
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    selectionCount: sel.length,
    selection: sel.slice(0, 100).map(function (n) {
      return { id: n.id, name: n.name, type: n.type, bounds: bounds(n) };
    }),
    viewport: {
      center: { x: round(figma.viewport.center.x), y: round(figma.viewport.center.y) },
      zoom: round(figma.viewport.zoom),
      bounds: { x: round(vb.x), y: round(vb.y), width: round(vb.width), height: round(vb.height) },
    },
  };
}

/** Names, types and pages of node ids (comment anchors, version diffs). */
async function nodeInfo(p: any) {
  const ids: string[] = Array.isArray(p.ids) ? p.ids.slice(0, 500) : [];
  const out: any = {};
  for (let i = 0; i < ids.length; i++) {
    const n = await figma.getNodeByIdAsync(String(ids[i]));
    if (!n) continue;
    const pg = pageOf(n);
    out[ids[i]] = { name: n.name, type: n.type, page: pg ? pg.name : undefined };
  }
  return out;
}

let fontCache: Font[] | null = null;

async function listFonts(p: any) {
  if (!fontCache) fontCache = await figma.listAvailableFontsAsync();
  const filter = String(p.filter || "").toLowerCase();
  const families: { [family: string]: string[] } = {};
  const order: string[] = [];
  for (let i = 0; i < fontCache.length; i++) {
    const f = fontCache[i].fontName;
    if (filter && f.family.toLowerCase().indexOf(filter) === -1) continue;
    if (!families[f.family]) {
      families[f.family] = [];
      order.push(f.family);
    }
    families[f.family].push(f.style);
  }
  const limit = p.limit || 100;
  return {
    totalFamilies: order.length,
    families: order.slice(0, limit).map(function (family) {
      return { family: family, styles: families[family] };
    }),
  };
}

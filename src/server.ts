import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, mkdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Bridge, BridgeError } from "./bridge";
import { iconSvg, searchIcons } from "./icons";
import { imageInfo } from "./image";
import { generateCode, type IrNode } from "./codegen";
import { normalizeTokens } from "./tokens";
import { type ExportData, exportTokenFiles, type Format, FORMATS } from "./tokens-export";
import { importWeb } from "./web/import";
import { deleteSnippet, getSnippet, listSnippets, loadLibrary, saveSnippet, SNIPPETS_DIR } from "./snippets";
import { version as VERSION } from "../package.json";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT) || 3055;
const CHANNEL = process.env.FIGMA_BRIDGE_CHANNEL || "default";
const OUT_DIR = process.env.FIGMA_BRIDGE_OUT || join(tmpdir(), "figma-bridge");
const LOG_FILE = join(OUT_DIR, "bridge.log");
const MAX_OUTPUT_CHARS = 60_000;
const MAX_IMAGE_BYTES = 50 << 20;
const FIGMA_MAX_IMAGE_DIM = 4096;
const VIEW_MAX_DIM = 1568; // larger images are downscaled by the model anyway

mkdirSync(OUT_DIR, { recursive: true });
try {
  if (statSync(LOG_FILE).size > 5 << 20) truncateSync(LOG_FILE, 0);
} catch {}

// stdout is the MCP channel: logs go to stderr and to a file.
function log(line: string) {
  const text = `[${new Date().toISOString().slice(11, 23)}] ${line}`;
  console.error(text);
  try {
    appendFileSync(LOG_FILE, text + "\n");
  } catch {}
}

const bridge = new Bridge({ port: PORT, channel: CHANNEL, version: VERSION, log });
bridge.start();

// ─── Result helpers ─────────────────────────────────────────────────────────

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

function json(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return "null";
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return JSON.stringify({
    truncated: true,
    totalChars: text.length,
    note: "Output too large; ask for less (smaller depth, a filter, or ids and names only).",
    preview: text.slice(0, MAX_OUTPUT_CHARS),
  });
}

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: json(value) }] });
const plain = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

function failure(e: unknown): ToolResult {
  const out: Record<string, unknown> = { ok: false, error: (e as Error)?.message ?? String(e) };
  if (e instanceof BridgeError) {
    out.code = e.code;
    for (const key of ["line", "stack", "logs"] as const) if (e.details[key] !== undefined) out[key] = e.details[key];
  }
  return { content: [{ type: "text", text: json(out) }], isError: true };
}

async function track(name: string, summary: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const t0 = performance.now();
  try {
    const result = await fn();
    log(`${name} ok ${Math.round(performance.now() - t0)}ms ${summary}`);
    return result;
  } catch (e) {
    log(`${name} ERROR ${Math.round(performance.now() - t0)}ms ${summary} :: ${(e as Error)?.message ?? e}`);
    return failure(e);
  }
}

const oneLine = (s: string, max = 120) => s.replace(/\s+/g, " ").trim().slice(0, max);

async function readImageSource(source: string): Promise<Uint8Array> {
  const data = /^data:[^,]*?(;base64)?,(.*)$/is.exec(source);
  if (data) return new Uint8Array(data[1] ? Buffer.from(data[2]!, "base64") : Buffer.from(decodeURIComponent(data[2]!)));
  if (/^file:\/\//i.test(source)) source = fileURLToPath(source);
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
    if (!res.ok) throw new BridgeError(`Download failed: HTTP ${res.status} for ${source}`, "DOWNLOAD");
    if (Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new BridgeError("Remote image is too large", "TOO_LARGE");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new BridgeError("Remote image is too large", "TOO_LARGE");
    return bytes;
  }
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) throw new BridgeError(`File not found: ${source}`, "BAD_ARGS");
  if (info.size > MAX_IMAGE_BYTES) throw new BridgeError(`Image is larger than ${MAX_IMAGE_BYTES >> 20} MB`, "TOO_LARGE");
  return new Uint8Array(await readFile(source));
}

/** Image bytes as the bridge payload; the plugin UI converts WEBP and oversized images. */
async function imagePayload(source: string) {
  return bytesPayload(await readImageSource(source), source);
}

function bytesPayload(bytes: Uint8Array, source: string) {
  const info = imageInfo(bytes);
  if (!info) throw new BridgeError(`Unsupported image (expected PNG, JPG, WEBP or GIF): ${source}`, "BAD_IMAGE");
  const needsTranscode = info.format === "webp" || Math.max(info.width, info.height) > FIGMA_MAX_IMAGE_DIM;
  return {
    b64: Buffer.from(bytes).toString("base64"),
    mime: info.mime,
    transcode: needsTranscode ? { maxDim: FIGMA_MAX_IMAGE_DIM } : undefined,
  };
}

/** Resolves icons and image sources of a build spec on the server (the plugin has no network access). */
async function prepareSpec(spec: unknown, defaultColor: string) {
  const images: Record<string, Awaited<ReturnType<typeof imagePayload>>> = {};
  const jobs: Promise<void>[] = [];
  let n = 0;
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.icon && !node.svg) {
      const size = typeof node.size === "number" ? node.size : 24;
      jobs.push(iconSvg(String(node.icon), size, typeof node.color === "string" ? node.color : defaultColor).then((svg) => void (node.svg = svg)));
    }
    if (node.src && !node.imageKey) {
      const key = `img${n++}`;
      jobs.push(imagePayload(String(node.src)).then((img) => void (images[key] = img)));
      node.imageKey = key;
      delete node.src;
    }
    // Image paints: fill:{image:"https://…", fit:"cover"}.
    for (const field of ["fill", "stroke"]) {
      for (const paint of Array.isArray(node[field]) ? node[field] : [node[field]]) {
        if (!paint || typeof paint !== "object" || typeof paint.image !== "string" || paint.imageKey) continue;
        const key = `img${n++}`;
        jobs.push(imagePayload(paint.image).then((img) => void (images[key] = img)));
        paint.imageKey = key;
        delete paint.image;
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
    if (Array.isArray(node.variants)) node.variants.forEach(walk);
    if (node.base) walk(node.base);
  };
  walk(spec);
  await Promise.all(jobs);
  return images;
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "node";

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "figma-bridge", version: VERSION },
  {
    instructions: [
      "Figma Bridge drives the user's Figma desktop app through a local plugin. No rate limits: iterate freely.",
      "Workflow:",
      "1. get_context, then get_design_system when the file has styles, variables or components: reuse them instead of raw values. find locates layers by name, text, type, style or component across pages.",
      "2. New UI → build (one call per screen or section, with auto-layout; grid, rich text spans, component sets with variants, prototype reactions). Editing existing design → describe it first, then build into it (parentId) or run_script.",
      "3. Design system → design_tokens writes variables (with Light/Dark modes) and styles from simple JSON, W3C tokens or a Tailwind theme; build uses them via var:, style: and modes.",
      "4. Verify → screenshot with returnImage:true, and audit to catch contrast, overflow and naming issues. Fix, then check again. audit {scope:'design-system'} scores the file's design system; audit {fix:true} binds raw values to variables and styles.",
      "Reproduce a mockup or screenshot: build it at the mockup's size → compare {nodeId, reference, returnImage:true} → fix the largest regions → compare again until mismatchPercent stops dropping.",
      "5. Before risky changes to existing work → checkpoint {action:'save'}; restore if the result is worse. Each command is one Ctrl+Z step for the user.",
      "Existing website or HTML → import_web turns it into editable auto-layout frames (one per viewport); then compare against the returned reference screenshot.",
      "When the target is unclear, wait_for_selection asks the user to pick it in Figma. prototype links screens, annotate leaves Dev Mode notes, export_code turns a frame into HTML/React.",
      "run_script: `figma` global, top-level await, `return` a small JSON value (nodes come back as {id,name,type}).",
      "Script helpers: utils.loadFonts('Inter:Bold', …), utils.node(id), utils.page(name), utils.hex('#hex'), utils.solid('#hex', opacity?),",
      "utils.build(spec, {parentId}), utils.describe(nodeOrId, depth); lib.<name>(args) runs a saved snippet; console.log is returned as `logs`.",
      "Save helpers you will reuse with the snippets tool. Icons: search_icons, then insert_icon or {icon:'set:name'} in build.",
      "Rules: load fonts before editing text; pages load on demand (await figma.setCurrentPageAsync / getNodeByIdAsync); keep results small.",
      "The user can cancel a command from the plugin (code CANCELLED): build stops, a script may still finish, so check the file before retrying.",
      "If no file is connected, tell the user to run Plugins → Development → Figma Bridge in Figma (Ctrl+Alt+P re-runs it). If list_sessions reports versionMismatch, ask them to reopen or update the plugin.",
    ].join("\n"),
  },
);

server.registerTool(
  "run_script",
  {
    title: "Run Figma Plugin API script",
    description:
      "Execute JavaScript in the Figma plugin main thread (full Plugin API via `figma`). The code is the body of an async " +
      "function: use top-level await and `return` the output (JSON-serialized; a single expression is returned automatically). " +
      "Helpers: utils.loadFonts, utils.node, utils.page, utils.hex, utils.solid, utils.build, utils.describe; lib.<snippet>(args); " +
      "console.log is captured. On error returns {ok:false, error, line, stack}. Prefer build for creating new layouts. " +
      "If the user presses Cancel in the plugin you get code CANCELLED, but a script cannot be interrupted and may still finish: check the file before retrying.",
    inputSchema: {
      code: z.string().min(1).describe("Script body, e.g. `const f = figma.createFrame(); f.name = 'Card'; return f.id`"),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional().describe("Default 30000, max 120000"),
    },
  },
  ({ code, timeoutMs }) =>
    track("run_script", oneLine(code), async () => {
      const t0 = performance.now();
      const { hash, lib } = loadLibrary();
      const out = await bridge.request<{ result: unknown; logs?: string[] }>("run_script", { code, lib, libHash: hash }, timeoutMs ?? 30_000);
      return ok({ ok: true, result: out.result ?? null, ...(out.logs ? { logs: out.logs } : {}), ms: Math.round(performance.now() - t0) });
    }),
);

server.registerTool(
  "build",
  {
    title: "Build a layout from a JSON spec",
    description: `Create a whole layout in ONE call from a declarative spec. Fonts load automatically, icons are fetched, images loaded. Much faster and safer than run_script for new UI.
Node: {type?, name?, ...props, children?: Node[]}. type is inferred (text/spans→text, icon→icon, src→image, component→instance, variants→componentSet, else frame). Types: frame, component, componentSet, text, rect, ellipse, line, icon, image, svg, instance.
FRAME: layout "row"|"column"|"grid" (auto-layout; omit for free positioning), gap (number|"auto"), padding (n | [v,h] | [t,r,b,l]), align (cross axis: start|center|end|baseline), justify (main axis: start|center|end|between), wrap, rowGap, clip. Frames have no fill unless set.
GRID: layout:"grid", columns (count | tracks like [200,"1fr","2fr","hug"]), rows (same; default: enough rows, hugging), columnGap, rowGap (or gap). Children: span:[rows,cols] or colSpan/rowSpan, cellAlign/cellValign. Give the grid a w for "fr" columns.
SIZE: w / h: number (fixed) | "fill" (stretch inside an auto-layout parent) | "hug". Auto-layout frames hug by default. grow:true. absolute:true with x/y inside auto-layout; x/y for children of free frames.
TEXT: text, font ("Inter" | "Inter:Bold"), weight (400|500|600|700 or style name), size, color, lineHeight (1.5 | 24 | "150%"), letterSpacing (px | "2%"), align (left|center|right|justify), case (upper|lower|title), decoration (underline|strike), maxLines, textStyle "style:Name". Give w:"fill" or a number to wrap text.
RICH TEXT: spans:[{text:"Read the "},{text:"docs",weight:600,color:"#0D99FF",link:"https://…"}] instead of text; a span may set font, weight, size, color, decoration, case, link.
PAINT (fill, stroke, color): "#RRGGBB[AA]", "style:<paint style>", "var:<color variable>", {gradient:["#a","#b"], angle:90, type?:"radial"}, {image:"https://…"|path, fit:"fill"|"fit"|"crop"|"tile"}, null, or an array (last on top). stroke + strokeWidth (n | [t,r,b,l]) + strokeAlign (inside|center|outside) + strokeDash [dash,gap].
EFFECTS: radius (n | [tl,tr,br,bl] | "var:x"), opacity, shadow (true | {x,y,blur,spread,color} | [...] | "style:Name"), blur, backgroundBlur, rotation, visible.
ICON: {icon:"lucide:house", size:20, color:"#111"} (any Iconify set). IMAGE: {src:"C:/img.png" | "https://…", w, h, fit:"fill"|"fit"|"crop"|"tile"}. SVG: {svg:"<svg…>"}.
INSTANCE: {component:"Button" | node id | library key, props:{Variant:"Primary", Label:"Buy"}, text:{"Label layer name":"Buy"}}.
COMPONENT SET: {type:"componentSet", name:"Button", base:{shared frame spec}, variants:[{props:{Variant:"Primary",Size:"M"}, fill:"#0D99FF", children:[…]}, …], properties:{Label:"Button", "Show icon":{type:"boolean",default:true}, Icon:{type:"instance",default:"Icon/Star"}}}. One component per variant, combined as variants.
On a layer inside a component: bind:"Label" links a text to a text property (created if missing); bind:{visible:"Show icon"} or {mainComponent:"Icon"} for the others. type:"component" takes properties too.
PROTOTYPE: reactions:[{trigger:"click", action:"navigate", to:"Details", transition:"smart", duration:300}] on any layer (see the prototype tool).
gap/padding/radius accept "var:<number variable>". MODES: modes:{"Theme":"Dark"} sets a collection's variable mode on a frame and its children.
Example: {"name":"Card","layout":"column","w":320,"padding":24,"gap":12,"fill":"#FFFFFF","radius":16,"shadow":true,"children":[{"text":"Pro plan","size":20,"weight":600},{"text":"Everything you need","color":"#6B7280","w":"fill"},{"layout":"row","gap":8,"align":"center","children":[{"icon":"lucide:check","size":16,"color":"#16A34A"},{"text":"Unlimited projects"}]}]}
Returns {rootId, ids:{layerName:id}, created, warnings}. The result is selected and zoomed to unless select:false.`,
    inputSchema: {
      // A plain open object keeps the schema portable (Gemini/Antigravity reject propertyNames and anyOf on some versions).
      spec: z.object({}).passthrough().describe("Root node: {name, layout, children:[...], ...}. Several roots: wrap them in a frame or call build again."),
      parentId: z.string().optional().describe("Parent frame (default: current page)"),
      x: z.number().optional().describe("Position of the root on the page (default: viewport center)"),
      y: z.number().optional(),
      defaults: z
        .object({ font: z.string().optional(), color: z.string().optional(), size: z.number().optional() })
        .optional()
        .describe('Default text font family, color and size, e.g. {"font":"Inter","color":"#111111","size":14}'),
      select: z.boolean().optional().describe("Select and zoom to the result (default true)"),
    },
  },
  (args) =>
    track("build", typeof (args.spec as any).name === "string" ? (args.spec as any).name : "spec", async () => {
      const images = await prepareSpec(args.spec, args.defaults?.color ?? "#111111");
      return ok(await bridge.request("build", { ...args, images }, 90_000));
    }),
);

server.registerTool(
  "describe",
  {
    title: "Outline a node tree",
    description:
      "Compact outline of a node and its children, one line per layer: type, name, id, size, auto-layout, fills, text, font, " +
      "styles, variables, component info. Default target: selection, else the current page. Use it before editing an existing design.",
    inputSchema: {
      nodeId: z.string().optional(),
      depth: z.number().int().min(0).max(12).optional().describe("Levels of children, default 3"),
      maxNodes: z.number().int().min(10).max(2000).optional().describe("Default 300"),
    },
  },
  (args) =>
    track("describe", args.nodeId ?? "(selection)", async () => {
      const r = await bridge.request<{ outline: string; nodes: number; truncated: boolean }>("describe", args, 30_000);
      return plain(r.outline + (r.truncated ? `\n(truncated after ${r.nodes} layers: use a nodeId, lower depth or raise maxNodes)` : ""));
    }),
);

server.registerTool(
  "find",
  {
    title: "Find layers",
    description:
      "Search layers across all pages (or one page / subtree) by name, text content, type, style name or component. " +
      'Strings match as case-insensitive substrings, or as a regex when written "/pattern/flags". Filters combine (AND). ' +
      "Returns {total, matches:[{id, name, type, page, path, text?}], truncated}. Use it to locate layers before describe, build into them or run_script.",
    inputSchema: {
      name: z.string().optional().describe('Layer name, e.g. "button" or "/^Card \\d+$/"'),
      text: z.string().optional().describe("Text content of TEXT layers"),
      type: z.array(z.string()).optional().describe('Node types, e.g. ["FRAME","INSTANCE","TEXT","COMPONENT","COMPONENT_SET","SECTION"]'),
      style: z.string().optional().describe("Name of a paint, text or effect style the layer uses"),
      component: z.string().optional().describe("Instances of this component or component set (name, id or key)"),
      pageId: z.string().optional().describe("Only this page"),
      parentId: z.string().optional().describe("Only inside this layer"),
      limit: z.number().int().min(1).max(500).optional().describe("Max matches returned, default 50"),
    },
  },
  (args) =>
    track("find", oneLine(JSON.stringify(args)), async () => ok(await bridge.request("find", args, 60_000))),
);

server.registerTool(
  "get_design_system",
  {
    title: "List styles, variables and components",
    description:
      "The file's local color/text/effect styles, variables (with default-mode values) and components (with variant props). " +
      "Reuse them in build via \"style:Name\", \"var:Name\" and {component:\"Name\"}.",
    inputSchema: {
      include: z.array(z.enum(["colors", "text", "effects", "variables", "components"])).optional().describe("Default: all"),
      limit: z.number().int().min(1).max(2000).optional().describe("Max items per list, default 300"),
    },
  },
  (args) => track("get_design_system", (args.include ?? ["all"]).join(","), async () => ok(await bridge.request("get_design_system", args, 60_000))),
);

server.registerTool(
  "design_tokens",
  {
    title: "Write or export the design system",
    description: `WRITE (give tokens): create or update variable collections (with modes such as Light/Dark) and paint, text and effect styles. Idempotent: matched by name, so re-run it to change values. Returns counts of created and updated items.
Accepted formats (auto-detected, or set format):
SIMPLE: {"collections":[{"name":"Theme","modes":["Light","Dark"],"variables":{"color/primary":{"Light":"#0D99FF","Dark":"#2AA5FF"},"space/md":16,"radius/card":12,"color/link":"{color/primary}","flag/beta":true,"font/body":"Inter"}}],
 "styles":{"colors":{"Brand/Primary":"var:color/primary","Brand/Hero":{"gradient":["#0D99FF","#7C3AED"]}},"text":{"Heading/H1":{"font":"Inter","weight":700,"size":32,"lineHeight":1.2,"letterSpacing":"-1%"}},"effects":{"Shadow/Card":{"y":4,"blur":16,"color":"#0000001F"}}}}
 A scalar applies to every mode; an object keys values by mode. "{name}" or "var:name" is an alias. Detailed form: {"type":"color|number|string|boolean","values":{...},"description","scopes":["FRAME_FILL",...]}.
W3C: design tokens with $value/$type (color, dimension, number, fontFamily, fontWeight, duration, typography → text style, shadow → effect style, gradient → paint style). Values go to \`mode\`; $extensions.modes {"Dark": value} adds other modes.
TAILWIND: {theme:{colors, spacing, borderRadius, fontSize, extend}} → color/*, spacing/*, radius/*, font-size/* variables and text/* styles.
Use them in build with "var:color/primary", "style:Heading/H1", and modes:{"Theme":"Dark"} on a frame.
EXPORT (action:"export"): every local variable (all modes, aliases kept as references) and style → formats: dtcg (W3C DTCG JSON, re-importable with its collections and modes), css (custom properties, one block per mode: [data-theme="dark"]), tailwind (v3 preset + tokens.css), tailwind4 (@theme), scss, ts (typed const), json (the SIMPLE format above). Writes the files into path (a folder) or returns their text. Re-exporting an unchanged file gives identical files.
Example: {"action":"export","formats":["css","tailwind4","ts"],"path":"C:/app/src/styles"}`,
    inputSchema: {
      tokens: z.object({}).passthrough().optional().describe("Tokens to write, in one of the formats above"),
      action: z.enum(["write", "export"]).optional().describe("Default: write when tokens are given, else export"),
      format: z.enum(["auto", "simple", "w3c", "tailwind"]).optional().describe("Input format for write, default auto"),
      collection: z.string().optional().describe('Collection for W3C/Tailwind tokens (default "Tokens" / "Tailwind")'),
      mode: z.string().optional().describe('Mode that receives W3C/Tailwind values (default "Default")'),
      formats: z.array(z.enum(FORMATS)).optional().describe('Export formats, default ["dtcg","css"]'),
      path: z.string().optional().describe("Export folder (created if missing), or a file path when exporting one format; omit to get the text back"),
      collections: z.array(z.string()).optional().describe("Export only these collections"),
      modeSelector: z.string().optional().describe('CSS selector for non-default modes, default [data-theme="{mode}"] ({collection} also works)'),
    },
  },
  (args) =>
    track("design_tokens", args.action ?? (args.tokens ? args.format ?? "auto" : "export"), async () => {
      if ((args.action ?? (args.tokens ? "write" : "export")) === "export") {
        const data = await bridge.request<ExportData>("export_tokens", { collections: args.collections }, 60_000);
        const formats = args.formats?.length ? args.formats : (["dtcg", "css"] as Format[]);
        const { files, warnings } = exportTokenFiles(data, formats, { modeSelector: args.modeSelector });
        const counts = { collections: data.collections.length, variables: data.collections.reduce((n, c) => n + c.variables.length, 0), paintStyles: data.styles.colors.length, textStyles: data.styles.text.length, effectStyles: data.styles.effects.length };
        if (!args.path) {
          const text = files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n");
          return { content: [{ type: "text", text: json({ counts, files: files.map((f) => f.path), ...(warnings.length ? { warnings } : {}) }) }, { type: "text", text: text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + "\n… truncated: give path to write the files" : text }] };
        }
        const single = files.length === 1 && /\.[a-z0-9]+$/i.test(args.path);
        const written = [];
        for (const f of files) {
          const target = single ? args.path : join(args.path, f.path);
          written.push({ format: f.format, path: target, status: await writeIfChanged(target, f.content) });
        }
        return ok({ counts, files: written, ...(warnings.length ? { warnings } : {}) });
      }
      if (!args.tokens) throw new BridgeError("Give tokens to write, or action:\"export\".", "BAD_ARGS");
      const set = normalizeTokens(args.tokens as Record<string, unknown>, args);
      return ok(await bridge.request("design_tokens", { collections: set.collections, styles: set.styles, warnings: set.warnings }, 120_000));
    }),
);

/** Writes a file only when its content changed; returns what happened. */
async function writeIfChanged(path: string, content: string): Promise<"created" | "updated" | "unchanged"> {
  const before = await readFile(path, "utf8").catch(() => null);
  if (before === content) return "unchanged";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return before === null ? "created" : "updated";
}

server.registerTool(
  "audit",
  {
    title: "Check a design or the whole design system",
    description:
      "scope \"layers\" (default) lints a node (default: selection, else the page): low text contrast (WCAG AA), text overflowing its container, clipped layers, " +
      "missing fonts, tiny text, frames without auto-layout, spacing off the 4 px grid, fractional sizes, default layer names, too many fonts or font sizes. " +
      "Returns issues with nodeId, severity and message.\n" +
      "scope \"design-system\" scores the whole file (or nodeId) from 0 to 100, overall and per category: tokens (raw colors, spacing and radii vs variables and styles), " +
      "contrast, typography (text using text styles), components (detached-looking frames, heavily overridden instances), styles (duplicate or unused styles, variables and components), " +
      "naming (default layer names, token naming convention). Returns the scores and concrete issues.\n" +
      "fix:true applies safe fixes to nodeId / the selection / the page, as one undo step: binds raw colors to the closest color variable (same value or ΔE < 2, as the layer's mode sees it), " +
      "spacing, padding and radii to number variables with the same value, applies text styles that match exactly, and renames default layer names from their content. " +
      'Returns {fixed, changes:[{nodeId, fix, from, to}]} plus the report after fixing. fixes limits it, e.g. ["colors","names"]. Example: {"scope":"design-system"} then {"fix":true}.',
    inputSchema: {
      nodeId: z.string().optional(),
      scope: z.enum(["layers", "design-system"]).optional().describe("Default layers"),
      rules: z
        .array(z.string())
        .optional()
        .describe("layers scope only: contrast, text-overflow, clipped, missing-font, tiny-text, no-auto-layout, off-grid, fractional, default-name, empty, font-sprawl, type-scale"),
      fix: z.boolean().optional().describe("Apply the safe fixes, then report"),
      fixes: z.array(z.enum(["colors", "numbers", "textStyles", "names"])).optional().describe("Only these fixes (implies fix)"),
    },
  },
  (args) =>
    track("audit", `${args.scope ?? "layers"}${args.fix || args.fixes ? " fix" : ""} ${args.nodeId ?? ""}`, async () => ok(await bridge.request("audit", args, 120_000))),
);

server.registerTool(
  "screenshot",
  {
    title: "Export a node to an image file",
    description:
      "Export a node (default: the first selected node) to PNG/JPG. The file is written to a temp folder and " +
      "{path, width, height} is returned. Set returnImage:true to also see the image directly (downscaled to 1568 px unless maxDimension is set).",
    inputSchema: {
      nodeId: z.string().optional().describe("Node to export; defaults to the current selection"),
      scale: z.number().min(0.01).max(4).optional().describe("Export scale, default 1"),
      format: z.enum(["PNG", "JPG"]).optional(),
      maxDimension: z.number().int().min(16).max(8192).optional().describe("Cap the longest side in pixels"),
      returnImage: z.boolean().optional().describe("Also return the image as MCP image content"),
    },
  },
  ({ nodeId, scale, format, maxDimension, returnImage }) =>
    track("screenshot", nodeId ?? "(selection)", async () => {
      const r = await bridge.request<{ bytesB64: string; format: "PNG" | "JPG"; name: string; nodeId: string }>(
        "screenshot",
        { nodeId, scale, format, maxDimension: maxDimension ?? (returnImage ? VIEW_MAX_DIM : undefined) },
        60_000,
      );
      const bytes = Buffer.from(r.bytesB64, "base64");
      const info = imageInfo(bytes);
      const ext = r.format === "JPG" ? "jpg" : "png";
      const path = join(OUT_DIR, `${safeName(r.name)}-${safeName(r.nodeId)}-${Date.now()}.${ext}`);
      await writeFile(path, bytes);
      const meta = { path, nodeId: r.nodeId, name: r.name, width: info?.width, height: info?.height, bytes: bytes.length };
      const content: Content[] = [{ type: "text", text: json(meta) }];
      if (returnImage) content.push({ type: "image", data: r.bytesB64, mimeType: ext === "jpg" ? "image/jpeg" : "image/png" });
      return { content };
    }),
);

server.registerTool(
  "compare",
  {
    title: "Compare a layer with a reference image",
    description:
      "Pixel-diff a layer against a reference image (mockup, screenshot) from a local path or URL. The layer is exported at the " +
      "reference's resolution (or scale), the reference is resized to match, and differing pixels are counted. Returns " +
      "{mismatchPercent, regions:[{x, y, width, height, mismatchPercent}] in layer coordinates (largest first), heatmapPath}. " +
      "returnImage:true also shows reference and result side by side. Use it to reproduce a mockup: build → compare → fix the largest regions → compare again.",
    inputSchema: {
      nodeId: z.string().optional().describe("Layer to compare (default: the first selected layer)"),
      reference: z.string().min(1).describe("Reference image: local path or http(s) URL (PNG, JPG, WEBP, GIF)"),
      scale: z.number().min(0.05).max(4).optional().describe("Export scale; default: match the reference width"),
      threshold: z.number().min(0).max(1).optional().describe("Per-pixel color distance that counts as different, default 0.1"),
      returnImage: z.boolean().optional().describe("Also return reference and result side by side"),
    },
  },
  (args) =>
    track("compare", `${args.nodeId ?? "(selection)"} vs ${oneLine(args.reference, 80)}`, async () => {
      const refBytes = await readImageSource(args.reference);
      const info = imageInfo(refBytes);
      if (!info) throw new BridgeError(`Unsupported reference image (expected PNG, JPG, WEBP or GIF): ${args.reference}`, "BAD_IMAGE");
      const shot = await bridge.request<{ bytesB64: string; scale: number; offset: { x: number; y: number }; name: string; nodeId: string }>(
        "screenshot",
        { nodeId: args.nodeId, scale: args.scale, width: Math.min(info.width, 2400), format: "PNG", maxDimension: 4096 },
        60_000,
      );
      const diff = await bridge.request<{
        width: number;
        height: number;
        mismatch: number;
        regions: { x: number; y: number; width: number; height: number; mismatch: number }[];
        totalRegions: number;
        reference: { width: number; height: number };
        heatmap: string;
        sideBySide?: string;
      }>(
        "compare_images",
        { actual: shot.bytesB64, reference: Buffer.from(refBytes).toString("base64"), referenceMime: info.mime, threshold: args.threshold, sideBySide: !!args.returnImage },
        90_000,
      );
      const pct = (v: number) => Math.round(v * 10_000) / 100;
      const toLayer = (v: number, axis: "x" | "y") => Math.round((v / shot.scale + shot.offset[axis]) * 10) / 10;
      const heatmapPath = join(OUT_DIR, `compare-${safeName(shot.name)}-${Date.now()}.png`);
      await writeFile(heatmapPath, Buffer.from(diff.heatmap, "base64"));
      const refRatio = diff.reference.width / diff.reference.height;
      const ratio = diff.width / diff.height;
      const result: Record<string, unknown> = {
        nodeId: shot.nodeId,
        mismatchPercent: pct(diff.mismatch),
        regions: diff.regions.map((r) => ({
          x: toLayer(r.x, "x"),
          y: toLayer(r.y, "y"),
          width: Math.round((r.width / shot.scale) * 10) / 10,
          height: Math.round((r.height / shot.scale) * 10) / 10,
          mismatchPercent: pct(r.mismatch),
        })),
        totalRegions: diff.totalRegions,
        compared: { width: diff.width, height: diff.height, scale: Math.round(shot.scale * 1000) / 1000 },
        reference: diff.reference,
        heatmapPath,
      };
      if (Math.abs(refRatio - ratio) / ratio > 0.03) {
        result.warning = `Aspect ratios differ (reference ${refRatio.toFixed(3)}, layer ${ratio.toFixed(3)}): the reference was stretched. Match the layer size to the mockup first.`;
      }
      if (diff.sideBySide) {
        result.sideBySidePath = heatmapPath.replace(/\.png$/, "-side.png");
        await writeFile(result.sideBySidePath as string, Buffer.from(diff.sideBySide, "base64"));
      }
      const content: Content[] = [{ type: "text", text: json(result) }];
      if (diff.sideBySide) content.push({ type: "image", data: diff.sideBySide, mimeType: "image/png" });
      return { content };
    }),
);

server.registerTool(
  "import_web",
  {
    title: "Import a website or HTML as editable layers",
    description: `Render a web page in the user's Chrome or Edge and rebuild it as editable Figma layers: flex and grid become auto-layout (checked against the page, else free positioning), margins become spacing, text keeps font, weight, size, line height, letter spacing, color and links, plus borders, radii, shadows, gradients, opacity, images and inline SVG. Layers get semantic names (Header, Nav, Card, Button…).
One frame per viewport width, side by side. Web fonts map to fonts installed in Figma (substitutions are reported). Canvas, video and native form controls are imported as pictures.
Give exactly one of url, html (a full document or a fragment) or path (local .html file). selector imports one element only, e.g. "#pricing".
Returns {frames:[{viewport, rootId, layers, reference}], fontSubstitutions, warnings}. reference is a screenshot of the page: run compare {nodeId: rootId, reference} to check the result and fix the differences.
Example: {"url":"https://example.com","viewports":[1440,390]}`,
    inputSchema: {
      url: z.string().optional().describe("http(s) or file:// URL"),
      html: z.string().optional().describe("HTML markup to render"),
      path: z.string().optional().describe("Local .html file"),
      viewports: z.array(z.number().int().min(240).max(3840)).max(4).optional().describe("Widths in px, default [1440, 390]"),
      selector: z.string().optional().describe("CSS selector of the only element to import"),
      parentId: z.string().optional().describe("Frame or section that receives the frames (default: current page)"),
      name: z.string().optional().describe("Frame name prefix (default: the page title)"),
      maxHeight: z.number().int().min(200).max(30000).optional().describe("Import at most this many px from the top, default 12000"),
      waitMs: z.number().int().min(0).max(30000).optional().describe("Extra wait after load for slow pages, default 0"),
    },
  },
  (args) =>
    track("import_web", oneLine(args.url ?? args.path ?? `${args.html?.length ?? 0} chars of HTML`, 80), async () => {
      const fonts = await bridge.request<{ families: { family: string; styles: string[] }[] }>("list_fonts", { limit: 100_000 }, 30_000);
      const html = args.html !== undefined && !/<html[\s>]/i.test(args.html) ? `<!doctype html><html><head><meta charset="utf-8"></head><body>${args.html}</body></html>` : args.html;
      const result = await importWeb(
        { ...args, html },
        { fonts: fonts.families, readLocal: readImageSource, imageFormat: (b) => imageInfo(b)?.format ?? null },
      );
      // Frames go side by side, starting at the viewport center (or the parent's origin).
      let x = 0;
      let y = 0;
      if (!args.parentId) {
        const ctx = await bridge.request<{ viewport: { center: { x: number; y: number } } }>("get_context", {}, 15_000);
        x = Math.round(ctx.viewport.center.x - (result.viewports[0]?.width ?? 0) / 2);
        y = Math.round(ctx.viewport.center.y - Math.min(result.viewports[0]?.height ?? 0, 900) / 2);
      }
      const frames: Record<string, unknown>[] = [];
      const warnings = [...result.warnings];
      for (const v of result.viewports) {
        const images: Record<string, ReturnType<typeof bytesPayload>> = {};
        for (const [key, bytes] of Object.entries(v.images)) {
          try {
            images[key] = bytesPayload(bytes, key);
          } catch (e) {
            warnings.push(`${key}: ${(e as Error).message}`);
          }
        }
        const built = await bridge.request<{ rootId: string; created: number; warnings?: string[] }>(
          "build",
          { spec: v.spec, images, parentId: args.parentId, x, y, select: false, label: "Web import" },
          120_000,
        );
        let reference: string | undefined;
        if (v.screenshot) {
          reference = join(OUT_DIR, `import-${safeName(v.title || "page")}-${v.viewport}-${Date.now()}.png`);
          await writeFile(reference, v.screenshot);
        }
        frames.push({ viewport: v.viewport, rootId: built.rootId, name: v.spec.name, layers: built.created, size: { width: v.width, height: v.height }, reference });
        for (const w of built.warnings ?? []) if (warnings.length < 60) warnings.push(w);
        x += Math.ceil(v.width) + 120;
      }
      const ids = frames.map((f) => f.rootId).filter(Boolean);
      if (!args.parentId && ids.length) {
        await bridge
          .request("run_script", {
            code: `const ns = []; for (const id of ${JSON.stringify(ids)}) { const n = await figma.getNodeByIdAsync(id); if (n) ns.push(n); } figma.currentPage.selection = ns; figma.viewport.scrollAndZoomIntoView(ns); return ns.length`,
          })
          .catch(() => {});
      }
      return ok({
        frames,
        ...(Object.keys(result.substitutions).length ? { fontSubstitutions: result.substitutions } : {}),
        ...(warnings.length ? { warnings: warnings.slice(0, 60) } : {}),
      });
    }),
);

server.registerTool(
  "prototype",
  {
    title: "Prototype links and flows",
    description: `Wire prototype interactions between frames, set flow starting points, or list them (no arguments → list for the current page).
links: [{from, to?, trigger?, action?, transition?, duration?, easing?, direction?, delay?, url?}]
 from: layer id or name; to: id or name of a top-level frame (a screen). trigger: click (default) | hover | press | drag | after (delay ms) | mouse-enter | mouse-leave.
 action: navigate (default with to) | overlay | swap | scroll-to | change-to (variants) | back | close | url.
 transition: instant (default) | dissolve | smart | move-in | move-out | push | slide-in | slide-out (+ direction left|right|top|bottom, or "push-left"); duration ms (default 300); easing: ease-out (default) | ease-in | ease-in-out | linear | gentle | quick | bouncy | slow.
flows: [{nodeId (top-level frame id or name), name?}] start points of the prototype on the current page.
Links are added to existing interactions unless replace:true; clear:[ids] removes all interactions of those layers. Inside build, use reactions:[{trigger, action, to:"<layer name in the spec>", …}] on any layer.`,
    inputSchema: {
      links: z.array(z.object({}).passthrough()).optional(),
      flows: z.array(z.object({}).passthrough()).optional(),
      clear: z.array(z.string()).optional().describe("Layer ids whose interactions are removed first"),
      replace: z.boolean().optional().describe("Replace the interactions of each linked layer instead of adding"),
      list: z.boolean().optional().describe("Also return the interactions after the change"),
      nodeId: z.string().optional().describe("Limit the listing to this layer and its children"),
    },
  },
  (args) =>
    track("prototype", `${args.links?.length ?? 0} links, ${args.flows?.length ?? 0} flows`, async () => ok(await bridge.request("prototype", args, 60_000))),
);

server.registerTool(
  "annotate",
  {
    title: "Dev Mode annotations",
    description:
      "Add, list or clear Dev Mode annotations, the notes developers see on layers. " +
      'add: {nodeId, label (markdown), properties?: ["width","height","fills","cornerRadius","padding","itemSpacing","fontSize","textStyleId",…] pinned as live values, category? (e.g. "Interaction", created if missing), color?}. ' +
      "list: {nodeId? | pageId?} returns the annotations of a layer and its children, or of a page (default: current page). clear: {nodeId}.",
    inputSchema: {
      action: z.enum(["add", "list", "clear"]).optional().describe("Default: add when label/properties are given, else list"),
      nodeId: z.string().optional(),
      pageId: z.string().optional().describe("list only"),
      label: z.string().max(5000).optional().describe("Markdown text of the note"),
      properties: z
        .array(z.string())
        .optional()
        .describe(
          "width, height, maxWidth, minWidth, maxHeight, minHeight, fills, strokes, effects, strokeWeight, cornerRadius, textStyleId, textAlignHorizontal, fontFamily, fontStyle, fontSize, fontWeight, lineHeight, letterSpacing, itemSpacing, padding, layoutMode, alignItems, opacity, mainComponent",
        ),
      category: z.string().optional().describe("Category label, e.g. Development, Interaction, Accessibility"),
      color: z.enum(["yellow", "orange", "red", "pink", "violet", "blue", "teal", "green"]).optional().describe("Color of a new category"),
      replace: z.boolean().optional().describe("Replace the layer's annotations instead of adding one"),
    },
  },
  (args) => track("annotate", `${args.action ?? (args.label ? "add" : "list")} ${args.nodeId ?? ""}`, async () => ok(await bridge.request("annotate", args, 30_000))),
);

server.registerTool(
  "export_code",
  {
    title: "Export a layer to code",
    description:
      "Generate front-end code from a frame or component (default: selection). framework html (a standalone page) or react (a component); " +
      "styling css (classes named after the layers) or tailwind. Auto-layout becomes flexbox, grid auto-layout CSS grid, fill/hug sizing flex rules, " +
      "text semantic tags (h1–h3, p, a), layers named button/nav/header/footer/section… the matching tags; colors, borders, radii and shadows " +
      "come from Figma's own CSS (variables stay var(--…)). Images and icons are saved as files in an assets folder. " +
      "Returns the code as text plus the folder where everything was written. Name layers well before exporting: names become class names.",
    inputSchema: {
      nodeId: z.string().optional(),
      framework: z.enum(["html", "react"]).optional().describe("Default html"),
      styling: z.enum(["css", "tailwind"]).optional().describe("Default css"),
    },
  },
  ({ nodeId, framework = "html", styling = "css" }) =>
    track("export_code", `${nodeId ?? "(selection)"} ${framework}/${styling}`, async () => {
      const r = await bridge.request<{ tree: IrNode; assets: Record<string, { b64?: string; svg?: string }>; nodes: number; truncated: boolean; warnings: string[] }>(
        "export_tree",
        { nodeId },
        120_000,
      );
      const dir = join(OUT_DIR, `export-${safeName(r.tree.name)}-${Date.now()}`);
      mkdirSync(join(dir, "assets"), { recursive: true });
      const finalName: Record<string, string> = {};
      for (const [file, a] of Object.entries(r.assets)) {
        const bytes = a.svg !== undefined ? Buffer.from(a.svg) : Buffer.from(a.b64 ?? "", "base64");
        const ext = a.svg !== undefined ? "svg" : imageInfo(bytes)?.format.replace("jpeg", "jpg") ?? "png";
        finalName[file] = file.replace(/\.[a-z]+$/, `.${ext}`);
        writeFileSync(join(dir, "assets", finalName[file]!), bytes);
      }
      const code = generateCode(r.tree, { framework, styling, assetPath: (f) => `assets/${finalName[f] ?? f}` });
      for (const f of code.files) writeFileSync(join(dir, f.path), f.content);
      const warnings = [...r.warnings, ...code.warnings];
      if (r.truncated) warnings.push(`Stopped after ${r.nodes} layers: export a smaller frame for the rest.`);
      const meta = {
        dir,
        files: code.files.map((f) => f.path),
        assets: Object.values(finalName).map((f) => `assets/${f}`),
        fonts: code.fonts,
        layers: r.nodes,
        ...(warnings.length ? { warnings } : {}),
      };
      let text = code.files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n");
      if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS) + `\n… truncated: the full code is in ${dir}`;
      return { content: [{ type: "text", text: json(meta) }, { type: "text", text }] };
    }),
);

server.registerTool(
  "get_css",
  {
    title: "CSS of a node",
    description: "CSS properties Figma generates for a node (default: selection), optionally for its direct children too. Useful for design → code.",
    inputSchema: { nodeId: z.string().optional(), children: z.boolean().optional() },
  },
  (args) => track("get_css", args.nodeId ?? "(selection)", async () => ok(await bridge.request("get_css", args, 30_000))),
);

server.registerTool(
  "place_image",
  {
    title: "Place a local or remote image",
    description:
      "Load an image (PNG/JPG/WEBP/GIF) from a local path or URL and use it as an image fill: on an existing node (nodeId), " +
      "or on a new rectangle (default: native size, centered in the viewport). WEBP and images over 4096 px are converted automatically.",
    inputSchema: {
      path: z.string().optional().describe("Local file path"),
      url: z.string().url().optional().describe("http(s) URL to download"),
      nodeId: z.string().optional().describe("Existing node that receives the image fill"),
      parentId: z.string().optional().describe("Parent for the new rectangle (default: current page)"),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional().describe("If only one of width/height is given, the aspect ratio is kept"),
      height: z.number().positive().optional(),
      scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("Default FILL"),
      name: z.string().optional(),
    },
  },
  (args) =>
    track("place_image", args.path ?? args.url ?? "", async () => {
      if (!!args.path === !!args.url) throw new BridgeError("Give exactly one of `path` or `url`.", "BAD_ARGS");
      const img = await imagePayload((args.path ?? args.url)!);
      const { path, url, ...rest } = args;
      return ok(await bridge.request("place_image", { ...rest, bytesB64: img.b64, mime: img.mime, transcode: img.transcode }, 60_000));
    }),
);

server.registerTool(
  "import_svg",
  {
    title: "Import SVG as vector nodes",
    description: "Create editable vector nodes from an SVG file or string (figma.createNodeFromSvg). Returns {nodeId, width, height}.",
    inputSchema: {
      path: z.string().optional().describe("Local .svg file"),
      svgString: z.string().optional().describe("Raw SVG markup"),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      name: z.string().optional(),
    },
  },
  ({ path, svgString, ...rest }) =>
    track("import_svg", path ?? `${svgString?.length ?? 0} chars`, async () => {
      if (!!path === !!svgString) throw new BridgeError("Give exactly one of `path` or `svgString`.", "BAD_ARGS");
      const svg = path ? await readFile(path, "utf8") : svgString!;
      return ok(await bridge.request("import_svg", { svg, ...rest }));
    }),
);

server.registerTool(
  "insert_icon",
  {
    title: "Insert an icon",
    description:
      'Insert an icon as editable vectors from any Iconify set: "lucide:house", "tabler:user", "ph:heart", "material-symbols:search", ' +
      '"heroicons:bell", "mdi:github", "simple-icons:figma" (brand logos). Use search_icons to find names. Inside build, use {icon:"set:name"} instead.',
    inputSchema: {
      name: z.string().describe('"set:name", e.g. "lucide:settings" (a bare name uses Lucide)'),
      size: z.number().int().min(8).max(512).optional().describe("Height in px, default 24"),
      color: z.string().optional().describe("Hex color for monochrome icons, default #111111"),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      layerName: z.string().optional().describe('Default "icon/<name>"'),
    },
  },
  (args) =>
    track("insert_icon", args.name, async () => {
      const svg = await iconSvg(args.name, args.size ?? 24, args.color ?? "#111111");
      return ok(await bridge.request("import_svg", { svg, name: args.layerName ?? `icon/${args.name}`, parentId: args.parentId, x: args.x, y: args.y }));
    }),
);

server.registerTool(
  "search_icons",
  {
    title: "Search icons",
    description:
      "Search 200 000+ open-source icons (Iconify). Returns names like \"lucide:shopping-cart\" to use with insert_icon or build. " +
      "Pass prefix to stay in one consistent set (lucide, tabler, ph, material-symbols, heroicons, mdi, simple-icons).",
    inputSchema: {
      query: z.string().min(1),
      prefix: z.string().optional().describe("Icon set, e.g. lucide"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 24"),
    },
  },
  (args) => track("search_icons", args.query, async () => ok({ icons: await searchIcons(args.query, args.prefix, args.limit ?? 24) })),
);

server.registerTool(
  "get_context",
  {
    title: "Current Figma context",
    description:
      "Start here. File name, pages (id/name), current page, selection (ids, names, bounds) and viewport of the connected file. " +
      "Workflow: get_design_system (or design_tokens to create one) → build (new UI) or find/describe + run_script (edits) → " +
      "screenshot returnImage:true + audit, or compare against a mockup → fix. Unsure what the user means? wait_for_selection.",
    inputSchema: {},
  },
  () => track("get_context", "", async () => ok(await bridge.request("get_context", {}, 15_000))),
);

server.registerTool(
  "wait_for_selection",
  {
    title: "Wait for the user to select layers",
    description:
      "Ask the user to select something in Figma and wait for it. The plugin shows a banner \"Your agent is waiting: <message>\" " +
      "with a Cancel button. Resolves as soon as the selection changes to a non-empty one, with {page, count, selection:[{id, name, type, bounds}], timedOut}. " +
      "Use it when the target is ambiguous (\"which card should I restyle?\") instead of guessing.",
    inputSchema: {
      message: z.string().max(200).optional().describe('Shown to the user, e.g. "Select the card to restyle"'),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional().describe("Default 60000, max 120000"),
    },
  },
  ({ message, timeoutMs }) =>
    track("wait_for_selection", message ?? "", async () => {
      const ms = timeoutMs ?? 60_000;
      return ok(await bridge.request("wait_for_selection", { message, timeoutMs: ms }, ms));
    }),
);

server.registerTool(
  "list_fonts",
  {
    title: "List available fonts",
    description: "Fonts available in Figma, grouped by family with their styles. Use `filter` (case-insensitive substring of the family).",
    inputSchema: {
      filter: z.string().optional(),
      limit: z.number().int().min(1).max(2000).optional().describe("Max families, default 100"),
    },
  },
  ({ filter, limit }) =>
    track("list_fonts", filter ?? "", async () => ok(await bridge.request("list_fonts", { filter, limit: limit ?? 100 }, 30_000))),
);

server.registerTool(
  "checkpoint",
  {
    title: "Save or restore a copy of layers",
    description:
      'Safety net for edits. action "save": copies nodeIds (default: selection) to a "⟲ Bridge checkpoints" page and returns a checkpointId. ' +
      '"restore": puts the saved copies back in place of the current layers (id, default "latest"; restored layers get new ids). ' +
      '"list": saved checkpoints. "delete": removes one (id) or all (id:"all", also removes the page).',
    inputSchema: {
      action: z.enum(["save", "restore", "list", "delete"]),
      nodeIds: z.array(z.string()).optional(),
      id: z.string().optional(),
      label: z.string().optional().describe("Short note, e.g. 'before dark mode'"),
    },
  },
  (args) => track("checkpoint", `${args.action} ${args.id ?? args.label ?? ""}`, async () => ok(await bridge.request("checkpoint", args, 60_000))),
);

server.registerTool(
  "snippets",
  {
    title: "Manage reusable script functions",
    description:
      "A library of your own helpers, available in every run_script as `await lib.<name>(args)`. A snippet is the body of an async " +
      "function with figma, utils, lib, console and args in scope; `return` its result. Actions: list, get (name), save (name, code, " +
      "description, usage), delete (name). Save anything you write twice (buttons, cards, naming passes…). Stored in " +
      SNIPPETS_DIR,
    inputSchema: {
      action: z.enum(["list", "get", "save", "delete"]),
      name: z.string().optional().describe("JS identifier, e.g. primaryButton"),
      code: z.string().optional(),
      description: z.string().optional(),
      usage: z.string().optional().describe('e.g. await lib.primaryButton({ label: "Buy", parentId })'),
    },
  },
  (args) =>
    track("snippets", `${args.action} ${args.name ?? ""}`, async () => {
      const need = (v: string | undefined, what: string) => {
        if (!v) throw new BridgeError(`\`${what}\` is required for ${args.action}.`, "BAD_ARGS");
        return v;
      };
      switch (args.action) {
        case "list":
          return ok({ snippets: listSnippets(), folder: SNIPPETS_DIR });
        case "get":
          return plain(getSnippet(need(args.name, "name")));
        case "save":
          return ok({ saved: need(args.name, "name"), path: saveSnippet(args.name!, need(args.code, "code"), args.description, args.usage) });
        case "delete":
          deleteSnippet(need(args.name, "name"));
          return ok({ deleted: args.name });
      }
    }),
);

server.registerTool(
  "list_sessions",
  {
    title: "List connected Figma files",
    description: "Figma files that currently have the plugin open, plus bridge status. Needed only when several files are open.",
    inputSchema: {},
  },
  () =>
    track("list_sessions", "", async () => {
      const sessions = await bridge.sessions().catch(() => []);
      const selected = bridge.selection.id;
      return ok({
        bridge: { mode: bridge.mode, port: bridge.port, channel: bridge.channel, ...(bridge.lastError ? { error: bridge.lastError } : {}) },
        sessions: sessions.map((s) => ({
          id: s.id,
          fileName: s.fileName,
          page: s.page,
          pluginVersion: s.version,
          ...(s.version && s.version !== VERSION
            ? { versionMismatch: `Plugin v${s.version}, server v${VERSION}: ask the user to reopen the plugin in Figma, or update it.` }
            : {}),
          connectedSeconds: Math.round((Date.now() - s.connectedAt) / 1000),
          selected: s.id === selected || undefined,
        })),
        ...(sessions.length ? {} : { hint: "Open the Figma Bridge plugin in Figma to connect a file." }),
      });
    }),
);

server.registerTool(
  "select_session",
  {
    title: "Choose which Figma file to drive",
    description: "Select the target file by name (exact or unique partial match) or session id when several files are connected.",
    inputSchema: { name: z.string().min(1).describe("File name or session id") },
  },
  ({ name }) =>
    track("select_session", name, async () => {
      const s = await bridge.select(name);
      return ok({ selected: { id: s.id, fileName: s.fileName, page: s.page } });
    }),
);

await server.connect(new StdioServerTransport());
log(`Figma Bridge MCP ${VERSION} ready (port ${PORT}, channel ${CHANNEL}, files in ${OUT_DIR})`);

const shutdown = () => process.exit(0);
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Bridge, BridgeError } from "./bridge";
import { imageInfo } from "./image";

const VERSION = "1.0.2";
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

const bridge = new Bridge({ port: PORT, channel: CHANNEL, log });
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
    note: "Output too large; return a smaller result (e.g. ids and names only).",
    preview: text.slice(0, MAX_OUTPUT_CHARS),
  });
}

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: json(value) }] });

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

async function readImageSource(path?: string, url?: string): Promise<{ bytes: Uint8Array; label: string }> {
  if (!!path === !!url) throw new BridgeError("Give exactly one of `path` or `url`.", "BAD_ARGS");
  if (path) {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new BridgeError(`File not found: ${path}`, "BAD_ARGS");
    if (file.size > MAX_IMAGE_BYTES) throw new BridgeError(`Image is larger than ${MAX_IMAGE_BYTES >> 20} MB`, "TOO_LARGE");
    return { bytes: new Uint8Array(await file.arrayBuffer()), label: path };
  }
  const res = await fetch(url!, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!res.ok) throw new BridgeError(`Download failed: HTTP ${res.status} for ${url}`, "DOWNLOAD");
  if (Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new BridgeError("Remote image is too large", "TOO_LARGE");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new BridgeError("Remote image is too large", "TOO_LARGE");
  return { bytes, label: url! };
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "node";

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "figma-bridge", version: VERSION },
  {
    instructions: [
      "Figma Bridge drives the user's Figma desktop app through a local plugin. No rate limits: iterate freely.",
      "Workflow: get_context → run_script (batch MANY edits in ONE script) → screenshot to check the result visually.",
      "run_script body: `figma` global, top-level await, `return` a small JSON value (nodes come back as {id,name,type}).",
      "Script helpers: utils.loadFonts('Inter:Bold', 'Inter:Regular' | textNode | FontName…), utils.node(id), utils.page(nameOrId),",
      "utils.hex('#RRGGBB[AA]') → RGB(A), utils.solid('#hex', opacity?) → Paint[]. console.log output is returned as `logs`.",
      "Rules: load fonts before editing text; pages load on demand (await figma.setCurrentPageAsync / getNodeByIdAsync);",
      "figma.skipInvisibleInstanceChildren is true; use auto-layout frames for UI; return ids of what you create to reuse them.",
      "If no file is connected, tell the user to run Plugins → Development → Figma Bridge in Figma (Ctrl+Alt+P re-runs it).",
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
      "Helpers: utils.loadFonts, utils.node, utils.page, utils.hex, utils.solid; console.log is captured. " +
      "On error returns {ok:false, error, line, stack}. Prefer one script that does a whole step over many small calls.",
    inputSchema: {
      code: z.string().min(1).describe("Script body, e.g. `const f = figma.createFrame(); f.name = 'Card'; return f.id`"),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional().describe("Default 30000, max 120000"),
    },
  },
  ({ code, timeoutMs }) =>
    track("run_script", oneLine(code), async () => {
      const t0 = performance.now();
      const out = await bridge.request<{ result: unknown; logs?: string[] }>("run_script", { code }, timeoutMs ?? 30_000);
      return ok({ ok: true, result: out.result ?? null, ...(out.logs ? { logs: out.logs } : {}), ms: Math.round(performance.now() - t0) });
    }),
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
      await Bun.write(path, bytes);
      const meta = { path, nodeId: r.nodeId, name: r.name, width: info?.width, height: info?.height, bytes: bytes.length };
      const content: Content[] = [{ type: "text", text: json(meta) }];
      if (returnImage) content.push({ type: "image", data: r.bytesB64, mimeType: ext === "jpg" ? "image/jpeg" : "image/png" });
      return { content };
    }),
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
      const { bytes, label } = await readImageSource(args.path, args.url);
      const info = imageInfo(bytes);
      if (!info) throw new BridgeError(`Unsupported image (expected PNG, JPG, WEBP or GIF): ${label}`, "BAD_IMAGE");
      const needsTranscode = info.format === "webp" || Math.max(info.width, info.height) > FIGMA_MAX_IMAGE_DIM;
      const { path, url, ...rest } = args;
      const r = await bridge.request(
        "place_image",
        {
          ...rest,
          bytesB64: Buffer.from(bytes).toString("base64"),
          mime: info.mime,
          transcode: needsTranscode ? { maxDim: FIGMA_MAX_IMAGE_DIM } : undefined,
        },
        60_000,
      );
      return ok(r);
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
      const svg = path ? await Bun.file(path).text() : svgString!;
      return ok(await bridge.request("import_svg", { svg, ...rest }));
    }),
);

server.registerTool(
  "get_context",
  {
    title: "Current Figma context",
    description: "File name, pages (id/name), current page, selection (ids, names, bounds) and viewport of the connected file.",
    inputSchema: {},
  },
  () =>
    track("get_context", "", async () => {
      const ctx = await bridge.request("get_context", {}, 15_000);
      return ok(ctx);
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

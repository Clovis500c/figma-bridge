// End-to-end self-test: starts the MCP server over stdio, waits for the Figma plugin,
// then round-trips a script, a screenshot, an image and an SVG. Leaves the file unchanged.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const WAIT_PLUGIN_MS = 120_000;
const serverPath = join(import.meta.dir, "..", "src", "server.ts");

const client = new Client({ name: "figma-bridge-selftest", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", serverPath],
  stderr: "ignore",
  env: { ...process.env } as Record<string, string>,
});

let failures = 0;

async function call(name: string, args: Record<string, unknown> = {}) {
  const t0 = performance.now();
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = res.content.find((c) => c.type === "text")?.text ?? "null";
  return { data: JSON.parse(text), isError: !!res.isError, ms: Math.round(performance.now() - t0), images: res.content.filter((c) => c.type === "image").length };
}

function check(label: string, pass: boolean, detail: unknown) {
  if (!pass) failures++;
  console.log(`${pass ? "✔" : "✘"} ${label.padEnd(28)} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

await client.connect(transport);
const { tools } = await client.listTools();
check("MCP tools", tools.length === 8, tools.map((t) => t.name).join(", "));

// Wait for the plugin.
const deadline = Date.now() + WAIT_PLUGIN_MS;
let hinted = false;
for (;;) {
  const { data } = await call("list_sessions");
  if (data.sessions?.length) {
    check("plugin connected", true, `${data.sessions.map((s: any) => s.fileName).join(", ")} (bridge ${data.bridge.mode})`);
    if (data.sessions.length > 1) await call("select_session", { name: data.sessions[0].id });
    break;
  }
  if (data.bridge?.error) console.log(`… ${data.bridge.error}`);
  if (!hinted) {
    console.log("… Waiting for Figma: open a file and run Plugins → Development → Figma Bridge");
    hinted = true;
  }
  if (Date.now() > deadline) {
    check("plugin connected", false, "timed out");
    process.exit(1);
  }
  await Bun.sleep(1000);
}

const page = await call("run_script", { code: "return figma.currentPage.name" });
check("run_script", !page.isError && typeof page.data.result === "string", `"${page.data.result}" in ${page.ms} ms`);

const expr = await call("run_script", { code: "figma.root.children.length" });
check("run_script (expression)", !expr.isError && typeof expr.data.result === "number", `${expr.data.result} page(s)`);

const bad = await call("run_script", { code: "const a = 1;\nnull.boom;" });
check("run_script error report", bad.isError && bad.data.ok === false, { error: bad.data.error, line: bad.data.line });

const made = await call("run_script", {
  code: `
    await utils.loadFonts("Inter:Bold");
    const frame = figma.createFrame();
    frame.name = "figma-bridge selftest";
    frame.resize(240, 120);
    frame.fills = utils.solid("#A259FF");
    frame.cornerRadius = 16;
    const t = figma.createText();
    t.fontName = { family: "Inter", style: "Bold" };
    t.characters = "Bridge OK";
    t.fontSize = 28;
    t.fills = utils.solid("#FFFFFF");
    frame.appendChild(t);
    t.x = 24; t.y = 40;
    console.log("created", frame.id);
    return { id: frame.id, x: frame.x, y: frame.y };
  `,
});
check("run_script (create)", !made.isError && !!made.data.result?.id, made.data.result ?? made.data);
const frameId: string = made.data.result.id;

const shot = await call("screenshot", { nodeId: frameId, scale: 2 });
const shotFile = Bun.file(shot.data.path ?? "");
check("screenshot → file", !shot.isError && (await shotFile.exists()) && shot.data.width === 480, `${shot.data.width}×${shot.data.height}, ${shot.data.bytes} B, ${shot.ms} ms`);

const view = await call("screenshot", { nodeId: frameId, returnImage: true, format: "JPG" });
check("screenshot returnImage", !view.isError && view.images === 1, `${view.data.width}×${view.data.height} jpg`);

const img = await call("place_image", { path: shot.data.path, x: made.data.result.x + 260, y: made.data.result.y, width: 240, name: "selftest image" });
check("place_image", !img.isError && !!img.data.nodeId, img.data);

const svg = await call("import_svg", {
  svgString: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#1ABCFE"/></svg>',
  x: made.data.result.x + 520,
  y: made.data.result.y,
  name: "selftest svg",
});
check("import_svg", !svg.isError && svg.data.width === 64, svg.data);

const ctx = await call("get_context");
check("get_context", !ctx.isError && Array.isArray(ctx.data.pages), `${ctx.data.fileName} · ${ctx.data.pages?.length} page(s) · ${ctx.data.selectionCount} selected`);

const fonts = await call("list_fonts", { filter: "inter", limit: 3 });
check("list_fonts", !fonts.isError && fonts.data.totalFamilies >= 1, fonts.data.families?.map((f: any) => f.family));

const cleanup = await call("run_script", {
  code: `for (const id of ${JSON.stringify([frameId, img.data.nodeId, svg.data.nodeId])}) { const n = await figma.getNodeByIdAsync(id); if (n) n.remove(); } return "removed"`,
});
check("cleanup", !cleanup.isError, cleanup.data.result);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed.");
await client.close();
process.exit(failures ? 1 : 0);

// End-to-end self-test: starts the MCP server over stdio, waits for the Figma plugin,
// then round-trips a script, a screenshot, an image and an SVG. Leaves the file unchanged.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WAIT_PLUGIN_MS = 120_000;
const serverPath = join(import.meta.dir, "..", "src", "server.ts");

const client = new Client({ name: "figma-bridge-selftest", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", serverPath],
  stderr: "ignore",
  // Snippets go to a throwaway folder so the test never touches the user's library.
  env: { ...process.env, FIGMA_BRIDGE_SNIPPETS: join(tmpdir(), `figma-bridge-selftest-${process.pid}`) } as Record<string, string>,
});

let failures = 0;

async function call(name: string, args: Record<string, unknown> = {}) {
  const t0 = performance.now();
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = res.content.find((c) => c.type === "text")?.text ?? "null";
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text }; // describe and snippets.get return plain text
  }
  return { data, isError: !!res.isError, ms: Math.round(performance.now() - t0), images: res.content.filter((c) => c.type === "image").length };
}

function check(label: string, pass: boolean, detail: unknown) {
  if (!pass) failures++;
  console.log(`${pass ? "✔" : "✘"} ${label.padEnd(28)} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

await client.connect(transport);
const { tools } = await client.listTools();
check("MCP tools", tools.length === 25, tools.map((t) => t.name).join(", "));

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

const same = await call("compare", { nodeId: frameId, reference: shot.data.path });
const sideBySide = await call("compare", { nodeId: frameId, reference: shot.data.path, scale: 1, returnImage: true });
check(
  "compare",
  !same.isError && same.data.mismatchPercent < 1 && existsSync(same.data.heatmapPath ?? "") && sideBySide.images === 1,
  { mismatch: same.data.mismatchPercent, regions: same.data.regions?.length, error: same.data.error },
);

const img = await call("place_image", { path: shot.data.path, x: made.data.result.x + 260, y: made.data.result.y, width: 240, name: "selftest image" });
check("place_image", !img.isError && !!img.data.nodeId, img.data);

const svg = await call("import_svg", {
  svgString: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#1ABCFE"/></svg>',
  x: made.data.result.x + 520,
  y: made.data.result.y,
  name: "selftest svg",
});
check("import_svg", !svg.isError && svg.data.width === 64, svg.data);

// Selecting from a script resolves the wait like a user click would.
const waiting = call("wait_for_selection", { message: "selftest: selecting automatically", timeoutMs: 10_000 });
await Bun.sleep(500);
await call("run_script", { code: `figma.currentPage.selection = [await figma.getNodeByIdAsync(${JSON.stringify(frameId)})]` });
const waited = await waiting;
check("wait_for_selection", !waited.isError && waited.data.selection?.[0]?.id === frameId && !waited.data.timedOut, { count: waited.data.count, timedOut: waited.data.timedOut });

const ctx = await call("get_context");
check("get_context", !ctx.isError && Array.isArray(ctx.data.pages), `${ctx.data.fileName} · ${ctx.data.pages?.length} page(s) · ${ctx.data.selectionCount} selected`);

const fonts = await call("list_fonts", { filter: "inter", limit: 3 });
check("list_fonts", !fonts.isError && fonts.data.totalFamilies >= 1, fonts.data.families?.map((f: any) => f.family));

// ─── 1.2 tools ──────────────────────────────────────────────────────────────
const built = await call("build", {
  x: made.data.result.x,
  y: made.data.result.y + 200,
  select: false,
  spec: {
    name: "selftest card",
    layout: "column",
    w: 280,
    padding: 20,
    gap: 10,
    fill: "#FFFFFF",
    radius: 12,
    stroke: "#E5E7EB",
    shadow: true,
    children: [
      { name: "Title", text: "Pro plan", size: 18, weight: 600 },
      { name: "Body", text: "Everything you need to ship faster.", color: "#6B7280", w: "fill" },
      { name: "Feature", layout: "row", gap: 8, align: "center", children: [{ icon: "lucide:check", size: 16, color: "#16A34A" }, { text: "Unlimited projects" }] },
      { name: "Button", layout: "row", justify: "center", w: "fill", padding: [10, 16], radius: 8, fill: "#0D99FF", children: [{ text: "Upgrade", color: "#FFFFFF", weight: 600 }] },
    ],
  },
});
const cardId: string = built.data.rootId;
check("build", !built.isError && !!cardId && built.data.created >= 8, { created: built.data.created, warnings: built.data.warnings ?? [] });

const outline = await call("describe", { nodeId: cardId, depth: 2 });
check("describe", !outline.isError && /FRAME "selftest card"/.test(outline.data.text) && /column/.test(outline.data.text), outline.data.text?.split("\n")[0]);

const lint = await call("audit", { nodeId: cardId });
check("audit", !lint.isError && typeof lint.data.summary?.error === "number", { ...lint.data.summary, rules: lint.data.countsByRule });

const ds = await call("get_design_system", { limit: 5 });
check("get_design_system", !ds.isError && !!ds.data.counts, ds.data.counts);

const css = await call("get_css", { nodeId: cardId });
check("get_css", !css.isError && !!css.data.css, Object.keys(css.data.css ?? {}).slice(0, 5));

const icon = await call("insert_icon", { name: "lucide:star", size: 32, color: "#F59E0B", x: made.data.result.x + 620, y: made.data.result.y });
check("insert_icon", !icon.isError && icon.data.height === 32, icon.data);

const note = await call("annotate", { nodeId: cardId, label: "Card: **hug** height", properties: ["width", "padding"] });
const notes = await call("annotate", { action: "list", nodeId: cardId });
const cleared = await call("annotate", { action: "clear", nodeId: cardId });
check(
  "annotate add/list/clear",
  !note.isError && notes.data.nodes?.[0]?.annotations?.[0]?.properties?.length === 2 && cleared.data.removed === 1,
  notes.data.nodes?.[0] ?? note.data,
);

const exported = (await client.callTool({ name: "export_code", arguments: { nodeId: cardId, framework: "react", styling: "tailwind" } })) as { content: { text: string }[]; isError?: boolean };
const exportMeta = JSON.parse(exported.content[0]?.text ?? "{}");
check(
  "export_code",
  !exported.isError && /Pro plan/.test(exported.content[1]?.text ?? "") && exportMeta.assets?.some((a: string) => a.endsWith(".svg")),
  { files: exportMeta.files, assets: exportMeta.assets?.length, error: exportMeta.error },
);
if (exportMeta.dir) rmSync(exportMeta.dir, { recursive: true, force: true });

const saved = await call("checkpoint", { action: "save", nodeIds: [cardId], label: "selftest" });
await call("run_script", { code: `(await figma.getNodeByIdAsync(${JSON.stringify(cardId)})).name = "changed"` });
const restored = await call("checkpoint", { action: "restore", id: saved.data.checkpointId });
const newCardId: string = restored.data.restored?.[cardId];
const restoredName = await call("run_script", { code: `(await figma.getNodeByIdAsync(${JSON.stringify(newCardId)})).name` });
await call("checkpoint", { action: "delete", id: saved.data.checkpointId });
check("checkpoint save/restore", !saved.isError && !restored.isError && restoredName.data.result === "selftest card", { id: saved.data.checkpointId, restored: newCardId });

const snip = await call("snippets", { action: "save", name: "selftestDouble", code: "return args * 2", description: "test" });
const usesLib = await call("run_script", { code: "await lib.selftestDouble(21)" });
check("snippets + lib", !snip.isError && usesLib.data.result === 42, usesLib.data.result ?? usesLib.data);

// ─── 1.4 tools ──────────────────────────────────────────────────────────────
const tokens = {
  collections: [
    {
      name: "selftest tokens",
      modes: ["Light", "Dark"],
      variables: { "color/bg": { Light: "#FFFFFF", Dark: "#111111" }, "color/surface": "{color/bg}", "space/md": 16, "flag/beta": true },
    },
  ],
  styles: {
    colors: { "selftest/Primary": "var:color/bg" },
    text: { "selftest/H1": { font: "Inter", weight: 700, size: 32, lineHeight: 1.2 } },
    effects: { "selftest/Shadow": { y: 4, blur: 16, color: "#0000001F" } },
  },
};
const tk1 = await call("design_tokens", { tokens });
const tk2 = await call("design_tokens", { tokens });
check(
  "design_tokens (idempotent)",
  !tk1.isError && tk1.data.counts?.variables.created === 4 && tk2.data.counts?.variables.updated === 4 && tk2.data.counts?.variables.created === 0,
  { first: tk1.data.counts?.variables, second: tk2.data.counts?.variables, warnings: tk1.data.warnings ?? tk1.data.error },
);
const w3c = await call("design_tokens", { tokens: { selftest: { $type: "dimension", gap: { $value: "8px" } } }, collection: "selftest tokens", mode: "Light" });
check("design_tokens (W3C)", !w3c.isError && w3c.data.counts?.variables.created === 1, w3c.data.counts?.variables ?? w3c.data);
const dark = await call("build", {
  select: false,
  spec: { name: "selftest dark", modes: { "selftest tokens": "Dark" }, layout: "column", padding: "var:space/md", fill: "var:color/surface", children: [{ text: "Dark", color: "var:color/bg" }] },
});
const darkFill = await call("run_script", {
  code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(dark.data.rootId)}); return { mode: Object.values(n.explicitVariableModes)[0], pad: n.paddingTop }`,
});
// Free Figma plans allow a single mode per collection: then only the variable bindings can be checked.
const singleModePlan = ((tk1.data.warnings ?? []) as string[]).some((w) => /limited to 1 modes?/i.test(w));
if (singleModePlan) {
  check("build modes", !dark.isError && darkFill.data.result?.pad === 16, "variables bound; mode switch skipped (this Figma plan allows 1 mode)");
} else {
  check("build modes", !dark.isError && !dark.data.warnings && darkFill.data.result?.pad === 16, darkFill.data.result ?? dark.data);
}
const tokenCleanup = await call("run_script", {
  code: `
    for (const c of await figma.variables.getLocalVariableCollectionsAsync()) if (c.name === "selftest tokens") c.remove();
    const styles = [...await figma.getLocalPaintStylesAsync(), ...await figma.getLocalTextStylesAsync(), ...await figma.getLocalEffectStylesAsync()];
    for (const s of styles) if (s.name.startsWith("selftest/")) s.remove();
    (await figma.getNodeByIdAsync(${JSON.stringify(dark.data.rootId)}))?.remove();
    return "removed"`,
});
check("design_tokens cleanup", !tokenCleanup.isError, tokenCleanup.data.result ?? tokenCleanup.data);

const set = await call("build", {
  select: false,
  spec: {
    type: "componentSet",
    name: "selftest Button",
    base: { layout: "row", padding: [8, 16], radius: 8, children: [{ name: "Label", text: "Button", bind: "Label" }, { name: "Dot", type: "ellipse", size: 8, fill: "#FFFFFF", bind: { visible: "Show dot" } }] },
    properties: { "Show dot": { type: "boolean", default: false } },
    variants: [{ props: { Variant: "Primary" }, fill: "#0D99FF" }, { props: { Variant: "Secondary" }, fill: "#E5E7EB" }],
  },
});
const setInfo = await call("run_script", {
  code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(set.data.rootId)}); return { type: n.type, variants: n.children.length, props: Object.keys(n.componentPropertyDefinitions).map((k) => k.split("#")[0]).sort() }`,
});
check(
  "build componentSet",
  !set.isError && setInfo.data.result?.type === "COMPONENT_SET" && setInfo.data.result.variants === 2 && setInfo.data.result.props.join() === "Label,Show dot,Variant",
  setInfo.data.result ?? set.data,
);

const grid = await call("build", {
  select: false,
  spec: { name: "selftest grid", layout: "grid", columns: 3, gap: 8, children: [{ w: 40, h: 40, fill: "#0D99FF", span: [1, 2] }, ...Array.from({ length: 4 }, () => ({ w: 40, h: 40, fill: "#E5E7EB" }))] },
});
const gridInfo = await call("run_script", { code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(grid.data.rootId)}); return { mode: n.layoutMode, cols: n.gridColumnCount, rows: n.gridRowCount }` });
check("build grid", !grid.isError && (gridInfo.data.result?.mode === "GRID" ? gridInfo.data.result.cols === 3 : /grid/.test(String(grid.data.warnings))), { ...gridInfo.data.result, warnings: grid.data.warnings });

const rich = await call("build", {
  select: false,
  spec: { name: "selftest rich", spans: [{ text: "Read the " }, { text: "docs", weight: 700, color: "#0D99FF", link: "https://figma.com" }, { text: " now", size: 20 }] },
});
const richInfo = await call("run_script", {
  code: `const t = await figma.getNodeByIdAsync(${JSON.stringify(rich.data.rootId)}); return { text: t.characters, style: t.getRangeFontName(9, 13).style, link: t.getRangeHyperlink(9, 13)?.value, size: t.getRangeFontSize(13, 17) }`,
});
check("build spans", !rich.isError && richInfo.data.result?.style === "Bold" && richInfo.data.result.size === 20 && !!richInfo.data.result.link, richInfo.data.result ?? rich.data);

const found = await call("find", { text: "docs", type: ["TEXT"] });
const foundRe = await call("find", { name: "/^selftest (grid|rich)$/", limit: 5 });
check("find", !found.isError && found.data.matches?.some((m: any) => m.id === rich.data.rootId) && foundRe.data.total >= 2, { text: found.data.total, regex: foundRe.data.total });
const foundInst = await call("find", { component: "selftest Button" });
check("find (component)", !foundInst.isError && typeof foundInst.data.total === "number", foundInst.data.total ?? foundInst.data);

// Prototype destinations are top-level frames: one build per screen.
const screenB = await call("build", { select: false, spec: { name: "selftest Screen B", w: 120, h: 200, fill: "#F3F4F6", reactions: [{ action: "back" }] } });
const screenA = await call("build", {
  select: false,
  spec: { name: "selftest Screen A", w: 120, h: 200, fill: "#FFFFFF", children: [{ name: "Go", text: "Go", reactions: [{ to: "selftest Screen B", transition: "smart", duration: 250 }] }] },
});
const links = await call("prototype", { nodeId: screenA.data.rootId });
check(
  "build reactions",
  !screenA.isError && !screenA.data.warnings && !screenB.data.warnings && links.data.interactions?.links?.[0]?.toName === "selftest Screen B",
  links.data.interactions?.links ?? screenA.data,
);
const relink = await call("prototype", {
  links: [{ from: screenB.data.rootId, to: screenA.data.rootId, trigger: "after", delay: 1000, transition: "slide-in-right" }],
  flows: [{ nodeId: screenA.data.rootId, name: "selftest flow" }],
  replace: true,
  list: true,
  nodeId: screenB.data.rootId,
});
check(
  "prototype links + flows",
  !relink.isError && relink.data.interactions?.links?.[0]?.trigger === "AFTER_TIMEOUT" && relink.data.flows?.some((f: any) => f.name === "selftest flow"),
  relink.data.interactions?.links ?? relink.data,
);
await call("run_script", { code: `figma.currentPage.flowStartingPoints = figma.currentPage.flowStartingPoints.filter((f) => f.name !== "selftest flow")` });

const buildCleanup = await call("run_script", {
  code: `for (const id of ${JSON.stringify([set.data.rootId, grid.data.rootId, rich.data.rootId, screenA.data.rootId, screenB.data.rootId])}) { const n = id && await figma.getNodeByIdAsync(id); if (n) n.remove(); } return "removed"`,
});
check("build 1.4 cleanup", !buildCleanup.isError, buildCleanup.data.result);

// ─── 1.6 tools ──────────────────────────────────────────────────────────────
const web = await call("import_web", {
  html: '<div style="display:flex;gap:12px;padding:24px;font-family:Inter"><div style="padding:16px;border-radius:12px;background:#0D99FF;color:#fff">selftest web</div><a href="#">Link</a></div>',
  viewports: [480],
  name: "selftest web",
});
if (web.isError && /NO_BROWSER|MISSING_DEPENDENCY/.test(web.data.code ?? "")) {
  check("import_web", true, `skipped: ${web.data.error}`);
} else {
  const webInfo = await call("run_script", {
    code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(web.data.frames?.[0]?.rootId ?? "")}); return n && { w: n.width, text: n.findOne((t) => t.type === "TEXT" && t.characters === "selftest web") !== null }`,
  });
  check("import_web", !web.isError && webInfo.data.result?.w === 480 && webInfo.data.result.text && existsSync(web.data.frames[0].reference ?? ""), webInfo.data.result ?? web.data);
  await call("run_script", { code: `(await figma.getNodeByIdAsync(${JSON.stringify(web.data.frames?.[0]?.rootId ?? "")}))?.remove()` });
}

const cleanup = await call("run_script", {
  code: `for (const id of ${JSON.stringify([frameId, img.data.nodeId, svg.data.nodeId, newCardId ?? cardId, icon.data.nodeId])}) { const n = id && await figma.getNodeByIdAsync(id); if (n) n.remove(); } return "removed"`,
});
check("cleanup", !cleanup.isError, cleanup.data.result);
rmSync(join(tmpdir(), `figma-bridge-selftest-${process.pid}`), { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed.");
await client.close();
process.exit(failures ? 1 : 0);

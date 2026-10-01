import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpecMarkdown, PROMPTS } from "../src/guides";

test("prompts and resources over MCP", async () => {
  const client = new Client({ name: "guides-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(import.meta.dir, "..", "src", "server.ts")],
      stderr: "ignore",
      env: { ...process.env, FIGMA_BRIDGE_PORT: String(46000 + Math.floor(Math.random() * 4000)), FIGMA_BRIDGE_OUT: mkdtempSync(join(tmpdir(), "fb-guides-")) } as Record<string, string>,
    }),
  );
  try {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["new-screen", "apply-design-system", "reproduce-screenshot", "import-website", "figma-to-code", "figma-to-roblox", "audit-and-fix"]);
    for (const p of prompts) expect(p.arguments?.every((a) => !a.required)).toBe(true);
    const web = await client.getPrompt({ name: "import-website", arguments: { url: "https://example.com", viewports: "1280, 375" } });
    const webText = (web.messages[0]!.content as { text: string }).text;
    expect(webText).toContain('import_web {url:"https://example.com", viewports:[1280,375]}');
    const code = await client.getPrompt({ name: "figma-to-code", arguments: { projectPath: "C:/app" } });
    expect((code.messages[0]!.content as { text: string }).text).toContain("project at C:/app");

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["figma-bridge://docs/build-spec", "figma-bridge://docs/workflow"]);
    const spec = await client.readResource({ uri: "figma-bridge://docs/build-spec" });
    const specText = (spec.contents[0] as { text: string }).text;
    expect(specText).toStartWith("# build spec reference");
    expect(specText).toContain("## Text");
    expect(specText).toContain("## Diagram (figjam)");
    expect(specText).toContain("```json");
    const flow = await client.readResource({ uri: "figma-bridge://docs/workflow" });
    const flowText = (flow.contents[0] as { text: string }).text;
    const { tools } = await client.listTools();
    for (const t of tools) expect(flowText).toContain(`**${t.name}**`);
    for (const p of PROMPTS) expect(flowText).toContain(`**${p.name}**`);
  } finally {
    await client.close();
  }
}, 30_000);

test("build spec markdown keeps every section of the tool description", () => {
  const md = buildSpecMarkdown("Intro line.\nFRAME: layout row.\nTEXT: text, font.\nExample: {\"name\":\"Card\"}");
  expect(md).toBe('# build spec reference\n\nIntro line.\n\n## Frame\n\nlayout row.\n\n## Text\n\ntext, font.\n\n## Example\n\n```json\n{"name":"Card"}\n```\n');
});

test("server.json and package.json agree", () => {
  const root = join(import.meta.dir, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  expect(pkg.mcpName).toBe(server.name);
  expect(server.version).toBe(pkg.version);
  expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } });
  expect(server.description.length).toBeLessThanOrEqual(100);
});

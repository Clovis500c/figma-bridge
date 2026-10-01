// Tool input schemas must stay portable: Gemini / Antigravity reject anyOf, oneOf, allOf,
// propertyNames and $ref. Checked against the real server, as an MCP client sees it.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORBIDDEN = ["anyOf", "oneOf", "allOf", "propertyNames", "$ref", "not"];
const root = join(import.meta.dir, "..");
const dist = join(root, "dist", "server.js");
const hasNode = spawnSync("node", ["--version"]).status === 0;

function forbiddenKeys(value: unknown, path: string, out: string[]) {
  if (Array.isArray(value)) value.forEach((v, i) => forbiddenKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      // "properties" holds parameter names, which may be anything.
      if (FORBIDDEN.includes(k) && !path.endsWith(".properties")) out.push(`${path}.${k}`);
      forbiddenKeys(v, `${path}.${k}`, out);
    }
  }
}

async function listTools(command: string, args: string[]) {
  const client = new Client({ name: "schema-test", version: "1.0.0" });
  const env = { ...process.env, FIGMA_BRIDGE_PORT: String(40000 + Math.floor(Math.random() * 20000)), FIGMA_BRIDGE_OUT: mkdtempSync(join(tmpdir(), "fb-schema-")) };
  await client.connect(new StdioClientTransport({ command, args, stderr: "ignore", env: env as Record<string, string> }));
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

function checkTools(tools: Awaited<ReturnType<typeof listTools>>) {
  expect(tools.length).toBe(25);
  const problems: string[] = [];
  for (const t of tools) {
    forbiddenKeys(t.inputSchema, t.name, problems);
    expect(t.inputSchema.type).toBe("object");
    expect((t.description ?? "").length).toBeGreaterThan(40);
  }
  expect(problems).toEqual([]);
}

describe("tool schemas are portable", () => {
  test("bun run src/server.ts", async () => {
    checkTools(await listTools(process.execPath, ["run", join(root, "src", "server.ts")]));
  }, 30_000);

  test.skipIf(!hasNode || !existsSync(dist))("node dist/server.js", async () => {
    checkTools(await listTools("node", [dist]));
  }, 30_000);
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPlugin, parseClients, runSetup, tomlBlock, writeToml } from "../src/setup";

let home: string;
const appData = () => join(home, "AppData", "Roaming");
const npx = { command: "npx", args: ["-y", "@clovis500c/figma-bridge"] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "figma-bridge-setup-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const read = (...p: string[]) => readFileSync(join(home, ...p), "utf8");

describe("runSetup", () => {
  test("configures only the clients it detects", () => {
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".codex"));
    const r = runSetup({ home, appData: appData(), ...npx });
    expect(r.updated.map((u) => u.client).sort()).toEqual(["claude-code", "codex", "cursor"]);
    expect(r.missing).toContain("Windsurf");
    expect(JSON.parse(read(".cursor", "mcp.json"))).toEqual({ mcpServers: { FigmaBridge: { command: "npx", args: ["-y", "@clovis500c/figma-bridge"] } } });
    expect(JSON.parse(read(".claude.json")).mcpServers.FigmaBridge).toEqual({ type: "stdio", ...npx });
  });

  test("JSON: keeps other servers and settings, and backs up the original", () => {
    mkdirSync(join(home, ".cursor"));
    const original = JSON.stringify({ theme: "dark", mcpServers: { Other: { command: "other" }, FigmaBridge: { command: "old" } } });
    writeFileSync(join(home, ".cursor", "mcp.json"), original);
    runSetup({ home, appData: appData(), ...npx, clients: ["cursor"] });
    const config = JSON.parse(read(".cursor", "mcp.json"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.Other).toEqual({ command: "other" });
    expect(config.mcpServers.FigmaBridge.command).toBe("npx");
    expect(read(".cursor", "mcp.json.bak-figma-bridge")).toBe(original);
  });

  test("TOML: replaces a previous block and its sub-tables, keeps the rest", () => {
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      join(home, ".codex", "config.toml"),
      ['model = "gpt-5"', "", "[mcp_servers.FigmaBridge]", "command = 'old'", "", "[mcp_servers.FigmaBridge.env]", 'A = "1"', "", "[mcp_servers.other]", "command = 'x'", ""].join("\n"),
    );
    runSetup({ home, appData: appData(), ...npx, clients: ["codex"] });
    const toml = read(".codex", "config.toml");
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain("[mcp_servers.other]\ncommand = 'x'");
    expect(toml).not.toContain("old");
    expect(toml).not.toContain("FigmaBridge.env");
    expect(toml.match(/\[mcp_servers\.FigmaBridge\]/g)).toHaveLength(1);
    expect(toml.trimEnd().endsWith(tomlBlock(npx.command, npx.args))).toBe(true);
  });

  test("TOML: literal strings keep Windows paths as-is", () => {
    const path = join(home, "config.toml");
    writeToml(path, "C:\\Users\\me\\.bun\\bin\\bun.exe", ["run", "C:\\Users\\me\\figma-bridge\\src\\server.ts"]);
    expect(readFileSync(path, "utf8")).toContain("command = 'C:\\Users\\me\\.bun\\bin\\bun.exe'");
    writeToml(path, "npx", ["-y", "x"]);
    expect(readFileSync(path, "utf8").match(/\[mcp_servers\.FigmaBridge\]/g)).toHaveLength(1);
  });

  test("a forced client is created even when not detected", () => {
    const r = runSetup({ home, appData: appData(), ...npx, clients: ["windsurf", "claude-desktop"] });
    expect(r.updated.map((u) => u.client).sort()).toEqual(["claude-desktop", "windsurf"]);
    expect(existsSync(join(appData(), "Claude", "claude_desktop_config.json"))).toBe(true);
    expect(existsSync(join(home, ".codeium", "windsurf", "mcp_config.json"))).toBe(true);
  });

  test("Gemini CLI is only configured when its settings file exists", () => {
    mkdirSync(join(home, ".gemini"));
    expect(runSetup({ home, appData: appData(), ...npx }).updated.map((u) => u.client)).not.toContain("gemini-cli");
    writeFileSync(join(home, ".gemini", "settings.json"), "{}");
    expect(runSetup({ home, appData: appData(), ...npx }).updated.map((u) => u.client)).toContain("gemini-cli");
  });

  test("invalid JSON is reported, not overwritten", () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ not json");
    const r = runSetup({ home, appData: appData(), ...npx, clients: ["cursor"] });
    expect(r.failed).toHaveLength(1);
    expect(read(".cursor", "mcp.json")).toBe("{ not json");
  });

  test("unknown client ids throw", () => {
    expect(() => runSetup({ home, appData: appData(), ...npx, clients: ["vscode"] })).toThrow(/Unknown client/);
  });
});

test("parseClients", () => {
  expect(parseClients(["--client", "codex,cursor", "--client=windsurf", "--print"])).toEqual(["codex", "cursor", "windsurf"]);
});

test("installPlugin copies the three plugin files", () => {
  const to = join(home, ".figma-bridge", "plugin");
  const manifest = installPlugin(join(import.meta.dir, "..", "plugin"), to);
  expect(manifest).toBe(join(to, "manifest.json"));
  expect(JSON.parse(readFileSync(manifest, "utf8")).main).toBe("code.js");
  expect(existsSync(join(to, "code.js")) && existsSync(join(to, "ui.html"))).toBe(true);
});

// Registers the MCP server in every AI client found on this machine (shared by `bun run setup`
// and `npx @clovis500c/figma-bridge setup`). Originals are backed up as <file>.bak-figma-bridge.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SERVER_NAME = "FigmaBridge";

export interface ClientSpec {
  id: string;
  label: string;
  /** Files to write; a client is detected when the folder of one of them exists. */
  files: string[];
  format: "json" | "toml";
  /** Extra fields of the JSON entry (Claude Code wants type: "stdio"). */
  extra?: Record<string, unknown>;
}

export function clientList(home: string, appData: string): ClientSpec[] {
  return [
    { id: "claude-code", label: "Claude Code", files: [join(home, ".claude.json")], format: "json", extra: { type: "stdio" } },
    { id: "claude-desktop", label: "Claude Desktop", files: [join(appData, "Claude", "claude_desktop_config.json")], format: "json" },
    { id: "codex", label: "Codex", files: [join(home, ".codex", "config.toml")], format: "toml" },
    {
      id: "antigravity",
      label: "Antigravity",
      files: [join(home, ".gemini", "antigravity", "mcp_config.json"), join(home, ".gemini", "config", "mcp_config.json")],
      format: "json",
    },
    { id: "gemini-cli", label: "Gemini CLI", files: [join(home, ".gemini", "settings.json")], format: "json" },
    { id: "cursor", label: "Cursor", files: [join(home, ".cursor", "mcp.json")], format: "json" },
    { id: "windsurf", label: "Windsurf", files: [join(home, ".codeium", "windsurf", "mcp_config.json")], format: "json" },
  ];
}

function backup(path: string, text: string) {
  writeFileSync(path + ".bak-figma-bridge", text);
}

export function writeJson(path: string, entry: Record<string, unknown>) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const config = text.trim() ? JSON.parse(text) : {};
  if (text.trim()) backup(path, text);
  config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: entry };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

// TOML literal strings ('...') keep Windows backslashes as-is.
export function tomlBlock(command: string, args: string[]) {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = '${command}'`,
    `args = [${args.map((a) => `'${a}'`).join(", ")}]`,
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 120",
  ].join("\n");
}

export function writeToml(path: string, command: string, args: string[]) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.trim()) backup(path, text);
  // Drop a previous block (and its sub-tables) before appending the new one.
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) skipping = header[1] === `mcp_servers.${SERVER_NAME}` || header[1]!.startsWith(`mcp_servers.${SERVER_NAME}.`);
    if (!skipping) kept.push(line);
  }
  const body = kept.join("\n").trimEnd();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, (body ? body + "\n\n" : "") + tomlBlock(command, args) + "\n");
}

export interface SetupOptions {
  home: string;
  appData: string;
  command: string;
  args: string[];
  /** Client ids to configure even if not detected (from --client). */
  clients?: string[];
}

export interface SetupResult {
  updated: { client: string; label: string; file: string }[];
  failed: { client: string; label: string; file: string; error: string }[];
  missing: string[];
}

export function runSetup(opts: SetupOptions): SetupResult {
  const all = clientList(opts.home, opts.appData);
  const forced = opts.clients ?? [];
  const unknown = forced.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`Unknown client(s): ${unknown.join(", ")}. Known: ${all.map((c) => c.id).join(", ")}`);
  const result: SetupResult = { updated: [], failed: [], missing: [] };
  for (const client of all) {
    const detected = client.files.filter((f) => existsSync(dirname(f)) && (client.id !== "gemini-cli" || existsSync(f)));
    const targets = forced.length ? (forced.includes(client.id) ? (detected.length ? detected : [client.files[0]!]) : []) : detected;
    if (!targets.length) {
      if (!forced.length) result.missing.push(client.label);
      continue;
    }
    for (const file of targets) {
      try {
        if (client.format === "toml") writeToml(file, opts.command, opts.args);
        else writeJson(file, { ...client.extra, command: opts.command, args: opts.args });
        result.updated.push({ client: client.id, label: client.label, file });
      } catch (e) {
        result.failed.push({ client: client.id, label: client.label, file, error: (e as Error).message });
      }
    }
  }
  return result;
}

const PLUGIN_FILES = ["manifest.json", "code.js", "ui.html"];

/** Copies manifest.json, code.js and ui.html to a stable folder; returns the manifest path. */
export function installPlugin(from: string, to: string, version?: string): string {
  mkdirSync(to, { recursive: true });
  for (const f of PLUGIN_FILES) copyFileSync(join(from, f), join(to, f));
  if (version) writeFileSync(join(to, "version.json"), JSON.stringify({ version }) + "\n");
  return join(to, "manifest.json");
}

/** Negative when a < b, for "1.12.0"-style versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Keeps the installed Figma plugin in step with this server: called at startup, so restarting the
 * AI client is enough to update both. Never downgrades a copy installed by a newer server.
 */
export function syncPlugin(from: string, to: string, version: string): "installed" | "updated" | "current" | "newer" | "skipped" {
  if (!PLUGIN_FILES.every((f) => existsSync(join(from, f)))) return "skipped";
  const had = existsSync(join(to, "manifest.json"));
  let installed = "";
  try {
    installed = JSON.parse(readFileSync(join(to, "version.json"), "utf8")).version || "";
  } catch {}
  if (installed) {
    const order = compareVersions(installed, version);
    if (order > 0) return "newer";
    if (order === 0 && PLUGIN_FILES.every((f) => existsSync(join(to, f)))) return "current";
  }
  installPlugin(from, to, version);
  return had ? "updated" : "installed";
}

// ─── Console output ─────────────────────────────────────────────────────────

const color = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = color(1);
export const green = color(32);
export const dim = color(2);
export const yellow = color(33);

export function printSetup(r: SetupResult, rerun: string) {
  for (const label of r.missing) console.log(dim(`  –  ${label.padEnd(15)} not found`));
  for (const u of r.updated) console.log(green(`  ✔  ${u.label.padEnd(15)}`) + dim(u.file));
  for (const f of r.failed) console.log(yellow(`  !  ${f.label.padEnd(15)}could not update ${f.file}: ${f.error}`));
  if (!r.updated.length) console.log(yellow(`\nNo AI client found. Use \`${rerun} --client <name>\` or \`${rerun} --print\` for manual config.`));
}

export function printSnippets(command: string, args: string[]) {
  console.log(bold("JSON clients") + dim(" (Claude, Antigravity, Gemini CLI, Cursor, Windsurf…)"));
  console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args } } }, null, 2));
  console.log(bold("\nCodex") + dim(" (~/.codex/config.toml)"));
  console.log(tomlBlock(command, args) + "\n");
}

/** --client a,b --client c → ["a","b","c"] */
export function parseClients(argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === "--client" && argv[i + 1]) out.push(...argv[i + 1]!.split(","));
    else if (a.startsWith("--client=")) out.push(...a.slice(9).split(","));
  });
  return out;
}

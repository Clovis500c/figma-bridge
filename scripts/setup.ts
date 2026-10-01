// One-command setup: registers the MCP server in every AI client found on this machine.
//   bun run setup                    detected clients
//   bun run setup --client codex     force one client (repeatable): claude-code, claude-desktop, codex,
//                                    antigravity, gemini-cli, cursor, windsurf
//   bun run setup --print            only print the config snippets
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const NAME = "FigmaBridge";
const root = resolve(import.meta.dir, "..");
const command = process.execPath;
const args = ["run", join(root, "src", "server.ts")];
const manifest = join(root, "plugin", "manifest.json");
const home = homedir();
const appData = process.env.APPDATA || join(home, "AppData", "Roaming");

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface Client {
  id: string;
  label: string;
  /** Files to write; a client is detected when the folder of one of them exists. */
  files: string[];
  format: "json" | "toml";
  entry?: Record<string, unknown>;
}

const CLIENTS: Client[] = [
  { id: "claude-code", label: "Claude Code", files: [join(home, ".claude.json")], format: "json", entry: { type: "stdio", command, args } },
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

function backup(path: string, text: string) {
  writeFileSync(path + ".bak-figma-bridge", text);
}

function writeJson(path: string, entry: Record<string, unknown>) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const config = text.trim() ? JSON.parse(text) : {};
  if (text.trim()) backup(path, text);
  config.mcpServers = { ...config.mcpServers, [NAME]: entry };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

// TOML literal strings ('...') keep Windows backslashes as-is.
const tomlBlock = () =>
  [`[mcp_servers.${NAME}]`, `command = '${command}'`, `args = [${args.map((a) => `'${a}'`).join(", ")}]`, "startup_timeout_sec = 20", "tool_timeout_sec = 120"].join("\n");

function writeToml(path: string) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.trim()) backup(path, text);
  // Drop a previous block (and its sub-tables) before appending the new one.
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) skipping = header[1] === `mcp_servers.${NAME}` || header[1]!.startsWith(`mcp_servers.${NAME}.`);
    if (!skipping) kept.push(line);
  }
  const body = kept.join("\n").trimEnd();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, (body ? body + "\n\n" : "") + tomlBlock() + "\n");
}

const argv = process.argv.slice(2);
const forced = argv.flatMap((a, i) => (a === "--client" && argv[i + 1] ? argv[i + 1]!.split(",") : []));
const printOnly = argv.includes("--print");

console.log(bold("\nFigma Bridge setup\n"));

if (printOnly) {
  console.log(bold("JSON clients") + dim(" (Claude, Antigravity, Gemini CLI, Cursor, Windsurf…)"));
  console.log(JSON.stringify({ mcpServers: { [NAME]: { command, args } } }, null, 2));
  console.log(bold("\nCodex") + dim(" (~/.codex/config.toml)"));
  console.log(tomlBlock() + "\n");
  process.exit(0);
}

const unknown = forced.filter((id) => !CLIENTS.some((c) => c.id === id));
if (unknown.length) {
  console.log(yellow(`Unknown client(s): ${unknown.join(", ")}. Known: ${CLIENTS.map((c) => c.id).join(", ")}`));
  process.exit(1);
}

let done = 0;
for (const client of CLIENTS) {
  const targets = forced.length
    ? forced.includes(client.id)
      ? client.files.filter((f) => existsSync(dirname(f))).concat(client.files.some((f) => existsSync(dirname(f))) ? [] : [client.files[0]!])
      : []
    : client.files.filter((f) => existsSync(dirname(f)) && (client.id !== "gemini-cli" || existsSync(f)));
  if (!targets.length) {
    if (!forced.length) console.log(dim(`  –  ${client.label.padEnd(15)} not found`));
    continue;
  }
  for (const file of targets) {
    try {
      if (client.format === "toml") writeToml(file);
      else writeJson(file, client.entry ?? { command, args });
      console.log(green(`  ✔  ${client.label.padEnd(15)}`) + dim(file));
      done++;
    } catch (e) {
      console.log(yellow(`  !  ${client.label.padEnd(15)}could not update ${file}: ${(e as Error).message}`));
    }
  }
}

if (!done) {
  console.log(yellow("\nNo AI client found. Use `bun run setup --client <name>` or `bun run setup --print` for manual config."));
}

console.log(`
${bold("Next")}
  1. Figma desktop → Plugins → Development → Import plugin from manifest…
     ${green(manifest)}
  2. Restart your AI client, then run Plugins → Development → Figma Bridge in a Figma file.
${dim("Modified files are backed up as <file>.bak-figma-bridge")}
`);

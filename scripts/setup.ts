// One-command setup: registers the MCP server in Claude Code (user scope) with this machine's absolute paths.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const bun = process.execPath;
const server = join(root, "src", "server.ts");
const manifest = join(root, "plugin", "manifest.json");
const entry = { type: "stdio", command: bun, args: ["run", server] };

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

console.log(bold("\nFigma Bridge setup\n"));

let registered = false;
try {
  Bun.spawnSync(["claude", "mcp", "remove", "FigmaBridge", "--scope", "user"], { stdout: "ignore", stderr: "ignore" });
  const add = Bun.spawnSync(["claude", "mcp", "add-json", "FigmaBridge", JSON.stringify(entry), "--scope", "user"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  registered = add.exitCode === 0;
  if (!registered) console.log(yellow(add.stderr.toString().trim()));
} catch {
  // Claude Code CLI not on PATH: fall back to manual instructions below.
}

// No CLI (e.g. desktop app only): write the user-scope entry into ~/.claude.json, keeping a backup.
if (!registered) {
  const configPath = join(homedir(), ".claude.json");
  const file = Bun.file(configPath);
  try {
    const text = (await file.exists()) ? await file.text() : "{}";
    const config = JSON.parse(text);
    if (text !== "{}") await Bun.write(configPath + ".bak-figma-bridge", text);
    config.mcpServers = { ...config.mcpServers, FigmaBridge: entry };
    await Bun.write(configPath, JSON.stringify(config, null, 2));
    registered = true;
  } catch (e) {
    console.log(yellow(`! Could not update ${configPath}: ${(e as Error).message}`));
  }
}

if (registered) {
  console.log(green("✔ MCP server \"FigmaBridge\" added to Claude Code (all projects)."));
} else {
  console.log(yellow("! Could not run the `claude` CLI. Add this to your .mcp.json (project) or ~/.claude.json:"));
  console.log(JSON.stringify({ mcpServers: { FigmaBridge: entry } }, null, 2));
}

console.log(`
${bold("Next, in the Figma desktop app:")}
  1. Plugins → Development → Import plugin from manifest…
     ${green(manifest)}
  2. Open a file and run Plugins → Development → Figma Bridge.
  3. Restart Claude Code. The plugin shows a green dot once connected.

Check everything works: ${bold("bun run test")}
`);

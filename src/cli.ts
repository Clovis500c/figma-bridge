#!/usr/bin/env node
// npx @clovis500c/figma-bridge [setup | plugin | --version | --help]; no command starts the MCP server.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bold, dim, green, installPlugin, parseClients, printSetup, printSnippets, runSetup, yellow } from "./setup";
import { version as VERSION } from "../package.json";

export const PACKAGE = "@clovis500c/figma-bridge";

const [cmd, ...rest] = process.argv.slice(2);
const home = homedir();
// dist/server.js and src/cli.ts both sit one level below the package root.
const pluginSource = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const pluginTarget = join(home, ".figma-bridge", "plugin");

// Windows clients spawn commands without a shell, and npx is a .cmd script there.
// @latest makes npx check for a new release each time the AI client starts the server.
const spec = `${PACKAGE}@latest`;
const npx = process.platform === "win32" ? { command: "cmd", args: ["/c", "npx", "-y", spec] } : { command: "npx", args: ["-y", spec] };

function plugin(): string {
  const manifest = installPlugin(pluginSource, pluginTarget, VERSION);
  console.log(`${bold("Figma plugin")} copied to ${dim(pluginTarget)}`);
  return manifest;
}

function next(manifest: string) {
  console.log(`
${bold("Next")}
  1. Figma desktop → Plugins → Development → Import plugin from manifest…
     ${green(manifest)}
     (once: updates install themselves when your AI client restarts; then reopen the plugin)
  2. Restart your AI client, then run Plugins → Development → Figma Bridge in a Figma file.
`);
}

switch (cmd) {
  case undefined:
  case "serve":
    await import("./server");
    break;
  case "setup": {
    console.log(bold("\nFigma Bridge setup\n"));
    if (rest.includes("--print")) {
      printSnippets(npx.command, npx.args);
      break;
    }
    try {
      const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
      printSetup(runSetup({ home, appData, command: npx.command, args: npx.args, clients: parseClients(rest) }), `npx ${PACKAGE} setup`);
    } catch (e) {
      console.log(yellow((e as Error).message));
      process.exit(1);
    }
    console.log();
    next(plugin());
    console.log(dim("Modified files are backed up as <file>.bak-figma-bridge\n"));
    break;
  }
  case "plugin":
    next(plugin());
    break;
  case "-v":
  case "--version":
    console.log(VERSION);
    break;
  default:
    console.log(`${bold("Figma Bridge")} ${VERSION}: let any AI agent design in the Figma desktop app.

Usage: npx ${PACKAGE} [command]

  (no command)       start the MCP server (what AI clients run)
  setup              add it to every AI client found and install the Figma plugin
    --client <id>    only these clients: claude-code, claude-desktop, codex, antigravity, gemini-cli, cursor, windsurf
    --print          print the config snippets instead
  plugin             copy the Figma plugin to ${pluginTarget}
  --version          print the version
`);
    if (cmd !== "-h" && cmd !== "--help" && cmd !== "help") process.exit(1);
}

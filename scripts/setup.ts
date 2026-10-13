// One-command setup for a clone or release folder run with Bun:
//   bun run setup                    detected clients
//   bun run setup --client codex     force one client (repeatable): claude-code, claude-desktop, codex,
//                                    antigravity, gemini-cli, cursor, windsurf
//   bun run setup --print            only print the config snippets
// With npm, `npx @clovis500c/figma-bridge setup` does the same with an npx command.
import { homedir } from "node:os";
import { version } from "../package.json";
import { join, resolve } from "node:path";
import { pairingEnabled, pairingToken } from "../src/pairing";
import { bold, green, dim, installPlugin, parseClients, printSetup, printSnippets, runSetup, yellow } from "../src/setup";

const root = resolve(import.meta.dir, "..");
const command = process.execPath;
const args = ["run", join(root, "src", "server.ts")];
const argv = process.argv.slice(2);

console.log(bold("\nFigma Bridge setup\n"));
if (argv.includes("--print")) {
  printSnippets(command, args);
  process.exit(0);
}
try {
  const home = homedir();
  const result = runSetup({ home, appData: process.env.APPDATA || join(home, "AppData", "Roaming"), command, args, clients: parseClients(argv) });
  printSetup(result, "bun run setup");
} catch (e) {
  console.log(yellow((e as Error).message));
  process.exit(1);
}
// The installed copy carries this machine's pairing token; the server keeps it in step at each start.
const manifest = installPlugin(join(root, "plugin"), join(homedir(), ".figma-bridge", "plugin"), version, pairingEnabled() ? pairingToken() : undefined);
console.log(`
${bold("Next")}
  1. Figma desktop → Plugins → Development → Import plugin from manifest…
     ${green(manifest)}
  2. Restart your AI client, then run Plugins → Development → Figma Bridge in a Figma file.
${dim("Modified files are backed up as <file>.bak-figma-bridge")}
`);

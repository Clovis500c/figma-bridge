// Pairing token shared by the hub and the installed Figma plugin. A web page can open a sandboxed iframe whose
// Origin is "null", like a Figma plugin's, so the origin alone can't tell them apart: the plugin copy in
// ~/.figma-bridge/plugin carries this machine's token (written by setup and by the startup sync) and sends it in
// its hello. Every server process on the machine reads the same file.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Placeholder in plugin/ui.html, replaced by the token when the plugin is installed. */
export const TOKEN_PLACEHOLDER = "__FIGMA_BRIDGE_PAIRING__";

export const PAIRING_HELP =
  "A Figma Bridge plugin without this machine's pairing token tried to connect and was refused. If it was the user's plugin, " +
  "ask them to close and reopen it in Figma (Plugins → Development → Figma Bridge) so it loads the updated copy; if they imported " +
  "it from another folder, re-import ~/.figma-bridge/plugin/manifest.json (npx @clovis500c/figma-bridge plugin prints the path).";

const VALID = /^[0-9a-f]{32,128}$/;

/** False when the user turned pairing off (FIGMA_BRIDGE_PAIRING=0), e.g. to run the plugin straight from a clone. */
export function pairingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|off|false|no)$/i.test(env.FIGMA_BRIDGE_PAIRING ?? "");
}

/** The machine's token, created on first use. Several servers may start at once: the first write wins. */
export function pairingToken(dir = process.env.FIGMA_BRIDGE_HOME || join(homedir(), ".figma-bridge")): string {
  const file = join(dir, "pairing-token");
  const read = () => {
    try {
      const t = readFileSync(file, "utf8").trim();
      return VALID.test(t) ? t : "";
    } catch {
      return "";
    }
  };
  const existing = read();
  if (existing) return existing;
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(24).toString("hex");
  try {
    writeFileSync(file, token + "\n", { flag: "wx", mode: 0o600 });
    return token;
  } catch {
    // Another process created it first, or the file held garbage: use what is there, else replace it.
    const now = read();
    if (now) return now;
    writeFileSync(file, token + "\n", { mode: 0o600 });
    return token;
  }
}

export function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

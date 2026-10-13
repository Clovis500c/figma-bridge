import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Servers started by tests must not touch the user's installed Figma plugin (~/.figma-bridge/plugin).
process.env.FIGMA_BRIDGE_PLUGIN_SYNC = "0";
// …nor create the machine's pairing token in their home folder.
process.env.FIGMA_BRIDGE_HOME ||= mkdtempSync(join(tmpdir(), "fb-home-"));

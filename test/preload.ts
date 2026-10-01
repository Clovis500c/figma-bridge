// Servers started by tests must not touch the user's installed Figma plugin (~/.figma-bridge/plugin).
process.env.FIGMA_BRIDGE_PLUGIN_SYNC = "0";

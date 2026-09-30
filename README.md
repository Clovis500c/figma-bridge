# Figma Bridge

**Let Claude Code design directly in the Figma desktop app, with no rate limits.**

Figma Bridge connects an AI agent (Claude Code, or any MCP client) to the Figma file you have open. The agent can create
frames, write text, apply styles, import images and SVGs, take screenshots to check its own work, and run any
[Figma Plugin API](https://www.figma.com/plugin-docs/) code, as many times as it needs.

Everything runs on your machine. Commands go through a small Figma **development plugin**, not through Figma's web API,
so there are **no API quotas, no tokens, and no rate limits**.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Daily use](#daily-use)
- [What the AI can do (tools)](#what-the-ai-can-do-tools)
- [Writing scripts](#writing-scripts)
- [Several Figma files or Claude windows](#several-figma-files-or-claude-windows)
- [Troubleshooting](#troubleshooting)
- [Configuration](#configuration)
- [Security](#security)
- [Development](#development)
- [FAQ](#faq)

---

## How it works

```
┌─────────────┐  stdio   ┌──────────────────────┐  WebSocket          ┌──────────────┐  postMessage  ┌─────────────┐
│ Claude Code │ ───────▶ │ Figma Bridge server  │ ──────────────────▶ │ Plugin UI    │ ────────────▶ │ Figma       │
│ (MCP client)│ ◀─────── │ (Bun, src/server.ts) │ ◀── localhost:3055 ─│ (ui.html)    │ ◀──────────── │ (code.js)   │
└─────────────┘          └──────────────────────┘                     └──────────────┘               └─────────────┘
```

There are three pieces, all in this repo:

1. **The MCP server** (`src/server.ts`). Claude Code starts it automatically (you register it once).
   It gives the AI 8 tools (see [below](#what-the-ai-can-do-tools)).
2. **The WebSocket bridge** (`src/bridge.ts`). It runs **inside** the MCP server process, on `localhost:3055`.
   You never start it by hand.
3. **The Figma plugin** (`plugin/`). You open it in your Figma file. Its small window keeps the connection alive
   and passes each command to Figma, which runs it with the full Plugin API.

The plugin connects on its own as soon as it opens, and reconnects on its own if the server restarts
(for example when you restart Claude Code). There is no channel name to type and no socket to launch.

---

## Requirements

| What | Why | How to get it |
|---|---|---|
| **Windows 10/11** | Tested there. It should also work on macOS and Linux. | — |
| **[Bun](https://bun.sh)** | Runs the server (TypeScript, no build step). | In PowerShell: `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Figma desktop app** | Development plugins only run in the desktop app, not in the browser. | [figma.com/downloads](https://www.figma.com/downloads/) |
| **Claude Code** | The AI agent (CLI, desktop app or IDE extension). Any MCP client works. | [claude.com/claude-code](https://claude.com/claude-code) |

You also need **edit access** to the Figma file you want the AI to work on.

---

## Installation

This takes about 2 minutes, and you only do it once.

### 1. Download

Get **`figma-bridge-vX.Y.Z.zip`** from the [latest release](https://github.com/Clovis500c/figma-bridge/releases/latest)
and unzip it wherever you want to keep it, for example `C:\Users\<you>\figma-bridge`.

> **Tip:** avoid a OneDrive or Dropbox folder. Syncing `node_modules` is slow and can lock files during install.

Or clone the repo: `git clone https://github.com/Clovis500c/figma-bridge.git`

### 2. Install and register the server

Open a terminal **in the unzipped folder** and run:

```bash
bun install
```

```bash
bun run setup
```

- `bun install` downloads the dependencies (only `@modelcontextprotocol/sdk` and `zod`) and builds the plugin.
- `bun run setup` registers the MCP server **`FigmaBridge`** in Claude Code **for all your projects**, with the correct
  paths for your machine. If the `claude` command is available it uses `claude mcp add-json`. Otherwise it adds the entry
  to `~/.claude.json` and saves a backup as `~/.claude.json.bak-figma-bridge`. At the end it prints the exact path of
  the plugin manifest for the next step.

<details>
<summary>Prefer to configure it by hand?</summary>

Add this to the `.mcp.json` of a project, or to `mcpServers` in `~/.claude.json` for all projects. Replace the paths
with yours:

```json
{
  "mcpServers": {
    "FigmaBridge": {
      "type": "stdio",
      "command": "C:\\Users\\<you>\\.bun\\bin\\bun.exe",
      "args": ["run", "C:\\Users\\<you>\\figma-bridge\\src\\server.ts"]
    }
  }
}
```
</details>

### 3. Import the plugin into Figma

In the Figma desktop app, open any design file, then:

**Menu → Plugins → Development → Import plugin from manifest…** → select `plugin\manifest.json` in the folder.

Figma remembers it. You won't need to do this again.

### 4. Restart Claude Code

Claude Code only loads new MCP servers at startup. After restarting, you can check it's there with `/mcp`.

### 5. Open the plugin and test

In your Figma file: **Plugins → Development → Figma Bridge**. The status dot turns **green** ("Connected to your AI")
and Figma shows a small notification.

To check everything end to end:

```bash
bun run test
```

The test waits for the plugin, then runs a script, takes screenshots, places an image, imports an SVG, reads the
context and lists fonts. It then **deletes everything it created**, so your file ends up exactly as it was.

---

## Daily use

1. Open your Figma file.
2. Open the plugin: **Ctrl+Alt+P** (re-runs the last plugin), or the **Figma Bridge** button in the right-hand panel when
   nothing is selected (the plugin adds this button on first launch).
3. Ask Claude for something, for example:
   - *"Design a pricing page with 3 plans on a new page in Figma."*
   - *"Look at my selection and make a dark-mode version next to it."*
   - *"Rename every layer in the selected frame based on its content."*
   - *"Place C:\photos\hero.jpg as the background of frame 'Hero'."*

The plugin window shows what's happening: connection status, file and page, how many commands ran, how many failed,
average duration, and the last 20 commands. Click a failed command to see the full error.

The **—** button collapses the plugin into a thin bar so it stays out of the way. The plugin keeps working while
collapsed, but **not when closed**: closing it disconnects the file.

---

## What the AI can do (tools)

The tool set is small on purpose. `run_script` can do anything the Figma Plugin API can do. The other tools cover what
a script can't do by itself: reading files from your disk, downloading URLs, and saving images.

| Tool | What it does |
|---|---|
| **`run_script`** `({ code, timeoutMs? })` | **The main tool.** Runs JavaScript inside Figma with the full Plugin API (`figma`). The code runs as the body of an async function: use `await` freely and `return` a result. A single expression is returned automatically. Default timeout 30 s, max 120 s. On failure it returns `{ ok: false, error, line, stack }`, where `line` is the line in *your* script. |
| **`screenshot`** `({ nodeId?, scale?, format?, maxDimension?, returnImage? })` | Exports a node (by default the current selection) as PNG or JPG. The image is saved to a temp folder and the tool returns `{ path, width, height }`. This keeps images out of the AI's context unless it asks for them. With `returnImage: true` the AI also *sees* the image (capped at 1568 px). |
| **`place_image`** `({ path` or `url, nodeId?, parentId?, x?, y?, width?, height?, scaleMode?, name? })` | Loads a PNG, JPG, WEBP or GIF from your disk or the web. It either sets it as the image fill of an existing node, or creates a new rectangle for it (native size, centred in view by default). WEBP files and images larger than 4096 px, Figma's limit, are converted automatically. |
| **`import_svg`** `({ path` or `svgString, x?, y?, parentId?, name? })` | Turns an SVG into editable Figma vectors. |
| **`get_context`** `()` | File name, pages, current page, selection (ids, names, types, positions and sizes) and viewport. The AI usually calls this first. |
| **`list_fonts`** `({ filter?, limit? })` | Fonts available in Figma, grouped by family with their styles. |
| **`list_sessions`** `()` | Which Figma files currently have the plugin open, and the bridge status. |
| **`select_session`** `({ name })` | Chooses which file to work on when several are connected (by file name or part of it). |

The server also gives the AI short usage instructions: batch many changes into one script, load fonts before editing
text, check the result with a screenshot. You don't need to explain any of this yourself.

---

## Writing scripts

You normally never write scripts: the AI does. This section is for reference or for writing your own.

A script is the **body of an async function** that receives `figma`, `console` and `utils`:

```js
// Create a card with auto-layout and a title
await utils.loadFonts("Inter:Bold", "Inter:Regular");

const card = figma.createFrame();
card.name = "Card";
card.layoutMode = "VERTICAL";
card.itemSpacing = 8;
card.paddingLeft = card.paddingRight = card.paddingTop = card.paddingBottom = 24;
card.cornerRadius = 16;
card.fills = utils.solid("#1E1E2E");

const title = figma.createText();
title.fontName = { family: "Inter", style: "Bold" };
title.characters = "Hello from Claude";
title.fontSize = 24;
title.fills = utils.solid("#FFFFFF");
card.appendChild(title);

figma.viewport.scrollAndZoomIntoView([card]);
console.log("created card", card.id);   // shows up in `logs`
return { id: card.id };                  // the tool's result
```

### Helpers (`utils`)

| Helper | What it does |
|---|---|
| `await utils.loadFonts("Inter:Bold", …)` | Loads fonts before you edit text. Accepts `"Family:Style"` strings, `{ family, style }` objects, or a text node (loads all its fonts). Fonts are cached, so calling it again is free. |
| `await utils.node("12:34")` | Gets a node by id (on any page). |
| `await utils.page("Page name")` | Switches to a page by name or id and returns it. |
| `utils.solid("#A259FF", 0.8?)` | Returns a solid fill (`Paint[]`), ready for `node.fills = …`. |
| `utils.hex("#A259FF")` | Converts a hex colour to Figma's `{ r, g, b }` (0 to 1). |

### Good to know

- **Return values** are converted to JSON. Figma nodes become `{ id, name, type }`. Keep results small: return ids,
  not whole trees.
- **Fonts must be loaded** before you change `characters`, `fontSize`, `fontName` and similar text properties.
- **Pages load on demand** (Figma's `dynamic-page` mode). Use `await figma.getNodeByIdAsync(id)` and
  `await figma.setCurrentPageAsync(page)`, not the old synchronous versions.
- `figma.skipInvisibleInstanceChildren` is on, which makes `findAll` much faster on big files.
- **Timeouts** stop waiting for the result, but can't interrupt a synchronous infinite loop. See [Troubleshooting](#troubleshooting).

---

## Several Figma files or Claude windows

- **Several Figma files**: open the plugin in each file you want the AI to reach. With one file connected, the AI uses
  it automatically. With several, it calls `list_sessions` and then `select_session("file name")`. If the file is
  reopened later, the choice is kept.
- **Several Claude Code windows**: the first one to start opens port 3055, and the others connect through it. If that
  first window closes, another takes over the port within a fraction of a second, and the plugin reconnects on its own.

---

## Troubleshooting

| What you see | What it means / what to do |
|---|---|
| Plugin says **"Waiting for Claude Code"** | The MCP server isn't running. Open (or restart) Claude Code, and check with `/mcp` that `FigmaBridge` is listed and connected. The plugin retries every few seconds, and **Retry now** forces an immediate attempt. |
| Plugin says **"Port 3055 is busy"** | Another program is using port 3055, often an old TalkToFigma socket (`bun run src/socket.ts`). Close it and the connection resumes by itself. To find it: `Get-NetTCPConnection -LocalPort 3055` in PowerShell. |
| The AI says **"No Figma file is connected"** | The plugin isn't open in any file. Open it (Ctrl+Alt+P). |
| The AI says **"Several Figma files are connected"** | Expected with several files open: it should call `select_session`. You can also tell it which file to use. |
| `FigmaBridge` doesn't appear in `/mcp` | Restart Claude Code after `bun run setup`. If it's still missing, check the paths in `~/.claude.json` (or use the manual config above). |
| **Figma froze** after a script | A script got stuck in a synchronous loop, which nothing can interrupt. Close the plugin (or Figma), then reopen it. |
| Text edits fail with a font error | The font isn't installed or wasn't loaded. Ask the AI to use `list_fonts` and `utils.loadFonts`. |

**Logs:** every command is logged in `%TEMP%\figma-bridge\bridge.log`. Screenshots are saved in the same folder,
`%TEMP%\figma-bridge\`.

---

## Configuration

These are optional environment variables for the MCP server. Set them in the `env` block of the MCP config.

| Variable | Default | Purpose |
|---|---|---|
| `FIGMA_BRIDGE_CHANNEL` | `default` | Isolates several agents from each other. If you change it, set the same channel in the plugin's settings (gear icon). |
| `FIGMA_BRIDGE_PORT` | `3055` | WebSocket port. Figma only lets the plugin reach `localhost:3055` (see `plugin/manifest.json`). If you change it, also update `devAllowedDomains` in the manifest and `WS_URL` in `plugin/ui.html`. |
| `FIGMA_BRIDGE_OUT` | `%TEMP%\figma-bridge` | Where screenshots and the log file go. |

---

## Security

- The server listens on **`127.0.0.1` only**. Other machines on your network can't reach it.
- **Web pages can't control your Figma.** Browsers always send an `Origin` header, so a website trying to open a
  WebSocket to the port is refused as a command sender. Only local programs (like the MCP server) can send commands.
- The plugin can't reach the internet: its manifest allows no domains except `localhost:3055`.
- `run_script` runs **arbitrary code** in your Figma file, which is the point. Only connect agents you trust, and keep
  normal Figma version history in mind (**File → Show version history**) if you want to roll back.

---

## Development

```
src/server.ts      MCP server (stdio) and the 8 tools
src/bridge.ts      WebSocket hub: sessions, request routing, large-message chunking, port takeover
src/image.ts       reads image format and size from file headers (no dependencies)
plugin/code.ts     plugin main thread, compiled to plugin/code.js
plugin/ui.html     plugin window: WebSocket, reconnection, image conversion, activity log
plugin/manifest.json
scripts/setup.ts   registers the MCP server in Claude Code (bun run setup)
test/selftest.ts   end-to-end test (bun run test)
```

| Command | What it does |
|---|---|
| `bun run build` | Compiles `plugin/code.ts` into `plugin/code.js`. Also runs automatically after `bun install`. |
| `bun run check` | Strict TypeScript check of the server and the plugin. |
| `bun run test` | End-to-end test against a real Figma file (the plugin must be open). |
| `bun run start` | Starts the MCP server by hand (normally Claude Code does it). |

After changing `plugin/code.ts`, run `bun run build`, then close and reopen the plugin in Figma.
Changes to `ui.html` only need the plugin to be reopened.

**Protocol notes:** messages are JSON. Messages over 1 MB are split into chunks and reassembled on the other side
(up to 256 MB). Binary data (images, exports) travels as base64 between the server and the plugin only; the AI never
receives base64 unless it asks for `returnImage`. The plugin code sticks to ES2017 syntax, because Figma's plugin
sandbox parser is conservative.

---

## FAQ

**Does this use my Figma API quota or need a Figma token?**
No. It only uses the Plugin API inside the desktop app, the same way any plugin you install does.

**Is this the same as Figma's official MCP server?**
No. The official server mainly reads designs for code generation, and it has usage limits. Figma Bridge gives the AI
full write access to your open file through a plugin, with no limits.

**Does it work in the browser version of Figma?**
No. Development plugins that connect to `localhost` only run in the desktop app.

**Can I use it with something other than Claude Code?**
Yes. Any MCP client that can start a stdio server works (Cursor, Windsurf, Claude Desktop, and others). Use the same
command and args as in the manual config.

**Do I need to keep the plugin window visible?**
No. Collapse it with **—**. Just don't close it.

---

## License

[MIT](LICENSE)

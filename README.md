# Figma Bridge

**Let Claude Code design directly in the Figma desktop app, with no rate limits.**

Figma Bridge connects an AI agent (Claude Code, or any MCP client) to the Figma file you have open. The agent can create
frames, write text, apply styles, import images and SVGs, take screenshots to check its own work, and run any
[Figma Plugin API](https://www.figma.com/plugin-docs/) code, as many times as it needs.

Everything runs on your machine. Commands go through a small Figma **development plugin**, not through Figma's web API,
so there are **no API quotas, no tokens, and no rate limits**.

<p align="center"><img src="docs/plugin.jpg" alt="The Figma Bridge plugin, waiting for Claude (light) and live with activity (dark)" width="640"></p>

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Daily use](#daily-use)
- [What the AI can do (tools)](#what-the-ai-can-do-tools)
- [Building layouts](#building-layouts)
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

The plugin window shows what's happening:

- **The bridge**: *Claude Code* on the left, your *Figma file* (and current page) on the right. When connected, the line
  between them is solid. Each command travels along it as a dot, and comes back green (success) or red (error).
  When it isn't connected, the line is dashed and a short checklist explains what to do.
- **Stats**: commands run, errors, and average time with a small bar chart of recent durations.
- **Activity**: every command with an icon for its type (script, screenshot, image, SVG…), how long it took
  (slow ones in orange), and an **All / Errors** filter.
  - **Click a row** to see details: full error message, duration, time, and the layer it touched.
  - **Show in canvas** selects the layer the command created and zooms to it, switching page if needed.
  - **Copy error** / **Copy command** copy text to the clipboard.
- **Settings** (sliders icon): channel, window size reset, session info.

**Resize the window** by dragging the grip in the bottom-right corner. The size is remembered for next time
(*Settings → Reset window size* restores the default).

The **—** button collapses the plugin into a thin bar so it stays out of the way. The plugin keeps working while
collapsed, but **not when closed**: closing it disconnects the file.

---

## What the AI can do (tools)

The AI gets 17 tools. The server also gives it a short workflow, so you don't need to explain any of this yourself:
**read the file → build → check visually and with the audit → fix**.

### Create

| Tool | What it does |
|---|---|
| **`build`** `({ spec, parentId?, x?, y?, defaults?, select? })` | **The fastest way to design.** Builds a whole layout from a JSON description in one call: frames with auto-layout, text, icons, images, component instances, styles and variables. Fonts are loaded automatically. See [Building layouts](#building-layouts). |
| **`run_script`** `({ code, timeoutMs? })` | Runs any JavaScript inside Figma with the full Plugin API (`figma`), for everything `build` doesn't cover (editing existing layers, bulk renames, complex logic). `await` works at the top level; `return` a result. On failure it returns `{ ok: false, error, line, stack }`, where `line` is the line in *your* script. Default timeout 30 s, max 120 s. |
| **`insert_icon`** `({ name, size?, color?, parentId?, x?, y? })` | Inserts an icon as editable vectors from any [Iconify](https://icon-sets.iconify.design/) set: `lucide:house`, `tabler:user`, `ph:heart`, `material-symbols:search`, `simple-icons:figma` (brand logos)… |
| **`search_icons`** `({ query, prefix?, limit? })` | Searches 200 000+ open-source icons and returns their names. |
| **`place_image`** `({ path` or `url, nodeId?, … })` | Places a PNG, JPG, WEBP or GIF from your disk or the web, as a fill of an existing layer or on a new rectangle. WEBP and images over 4096 px are converted automatically. |
| **`import_svg`** `({ path` or `svgString, … })` | Turns an SVG into editable vectors. |

### Read and check

| Tool | What it does |
|---|---|
| **`get_context`** `()` | File name, pages, current page, selection and viewport. The AI usually starts here. |
| **`describe`** `({ nodeId?, depth?, maxNodes? })` | A compact outline of a design, one line per layer: type, name, id, size, auto-layout, colours, text, font, styles, variables, components. The AI reads your existing work cheaply before editing it. |
| **`get_design_system`** `({ include?, limit? })` | Your file's colour, text and effect styles, variables (with values) and components (with variant options). The AI then reuses them instead of hard-coding colours. |
| **`audit`** `({ nodeId?, rules? })` | Checks a design for low text contrast (WCAG AA), text overflowing its box, clipped layers, missing fonts, tiny text, frames without auto-layout, spacing off the 4 px grid, fractional sizes, default layer names, too many fonts or font sizes. |
| **`screenshot`** `({ nodeId?, scale?, format?, maxDimension?, returnImage? })` | Exports a layer to a PNG/JPG file and returns its path and size. With `returnImage: true` the AI also *sees* it. |
| **`get_css`** `({ nodeId?, children? })` | The CSS Figma generates for a layer, for turning a design into code. |
| **`list_fonts`** `({ filter?, limit? })` | Installed fonts, grouped by family. |

### Stay safe and go faster

| Tool | What it does |
|---|---|
| **`checkpoint`** `({ action, nodeIds?, id?, label? })` | `save` copies layers to a **⟲ Bridge checkpoints** page; `restore` puts them back if an edit went wrong; `list` and `delete` manage them. |
| **`snippets`** `({ action, name?, code?, description?, usage? })` | The AI's own library of reusable functions (a button, a card, a renaming pass…), saved in `~/.figma-bridge/snippets` and callable from any script as `await lib.name(args)`. It survives updates of this repo. |
| **`list_sessions`** / **`select_session`** | Lists the Figma files with the plugin open, and picks which one to work on. |

**Undo:** every command the AI runs is a **single Ctrl+Z step** in Figma, so you can undo a whole `build` or script at once.

---

## Building layouts

`build` takes a tree of nodes. Each node is an object with optional `children`. The type is guessed from its
properties (`text` → text, `icon` → icon, `src` → image, `component` → instance, otherwise a frame):

```json
{
  "name": "Card", "layout": "column", "w": 320, "padding": 24, "gap": 12,
  "fill": "#FFFFFF", "radius": 16, "stroke": "#E5E7EB", "shadow": true,
  "children": [
    { "text": "Pro plan", "size": 20, "weight": 600 },
    { "text": "Everything you need to ship faster.", "color": "#6B7280", "w": "fill" },
    { "layout": "row", "gap": 8, "align": "center", "children": [
      { "icon": "lucide:check", "size": 16, "color": "#16A34A" },
      { "text": "Unlimited projects" }
    ]},
    { "src": "C:/photos/hero.jpg", "w": "fill", "h": 160, "radius": 12 },
    { "component": "Button", "props": { "Variant": "Primary" }, "text": { "Label": "Upgrade" } }
  ]
}
```

| Property | Values |
|---|---|
| `layout` | `"row"` or `"column"` turns on auto-layout. Leave it out for free positioning (`x`, `y` on children). |
| `gap`, `padding`, `align`, `justify`, `wrap` | Auto-layout spacing (`gap: "auto"` = space between), padding (`24`, `[12, 24]` or `[t, r, b, l]`), cross-axis alignment (`start`, `center`, `end`, `baseline`), main-axis alignment (`start`, `center`, `end`, `between`). |
| `w`, `h` | A number (fixed), `"fill"` (stretch inside an auto-layout parent) or `"hug"`. Auto-layout frames hug their content by default. |
| `fill`, `stroke`, `color` | `"#RRGGBB"` or `"#RRGGBBAA"`, `"style:Brand/Primary"` (a paint style), `"var:color/primary"` (a variable), `{ "gradient": ["#a", "#b"], "angle": 90 }`, or `null`. |
| Text | `text`, `font` (`"Inter"` or `"Inter:Bold"`), `weight` (`400`–`900`), `size`, `lineHeight` (`1.5`, `24` or `"150%"`), `letterSpacing`, `align`, `case`, `maxLines`, `textStyle: "style:Heading/H1"`. |
| Effects | `radius` (number or 4 corners), `opacity`, `shadow` (`true`, an object, a list, or `"style:Name"`), `blur`, `backgroundBlur`. |
| Variables | `gap`, `padding` and `radius` also accept `"var:spacing/md"`. |
| Other types | `rect`, `ellipse`, `line`, `svg` (`{ "svg": "<svg…>" }`), `component` (a frame that becomes a component). |

The result lists the id of every named layer (`ids`), so the AI can edit them afterwards. Missing fonts fall back to
Inter and are reported in `warnings`, and a broken child is skipped without stopping the rest.

---

## Writing scripts

You normally never write scripts: the AI does. This section is for reference or for writing your own.

A script is the **body of an async function** that receives `figma`, `console`, `utils` and `lib`:

```js
// Rename every text layer of the selection after its content
const texts = [];
for (const n of figma.currentPage.selection) if ("findAll" in n) texts.push(...n.findAll((c) => c.type === "TEXT"));
for (const t of texts) t.name = t.characters.slice(0, 30);
console.log("renamed", texts.length);   // shows up in `logs`
return texts.length;                     // the tool's result
```

### Helpers

| Helper | What it does |
|---|---|
| `await utils.loadFonts("Inter:Bold", …)` | Loads fonts before you edit text. Accepts `"Family:Style"`, `{ family, style }` or a text node. Cached. |
| `await utils.build(spec, { parentId })` | Same as the `build` tool, from a script (icons and image `src` need the tool itself). |
| `await utils.describe(nodeOrId, depth)` | Same outline as the `describe` tool, as text. |
| `await utils.node("12:34")` | Gets a node by id (on any page). |
| `await utils.page("Page name")` | Switches to a page and returns it. |
| `utils.solid("#A259FF", 0.8?)` / `utils.hex("#A259FF")` | A solid fill (`Paint[]`) / a Figma colour `{ r, g, b }`. |
| `await lib.myHelper(args)` | Runs a snippet saved with the `snippets` tool. |

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
- The server only goes online for what you ask: icons (`api.iconify.design`, only the icon name is sent) and image URLs
  passed to `place_image` or `build`.
- `run_script` runs **arbitrary code** in your Figma file, which is the point. Only connect agents you trust, and keep
  normal Figma version history in mind (**File → Show version history**) if you want to roll back.

---

## Development

```
src/server.ts      MCP server (stdio) and the 17 tools
src/bridge.ts      WebSocket hub: sessions, request routing, large-message chunking, port takeover
src/icons.ts       Iconify icons (fetch and search)
src/snippets.ts    the snippet library (~/.figma-bridge/snippets)
src/image.ts       reads image format and size from file headers (no dependencies)
plugin/code.ts     plugin main thread, bundled with plugin/lib/*.ts into plugin/code.js
plugin/lib/        build, describe, design system, audit, checkpoints, shared helpers
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

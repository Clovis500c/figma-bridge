# FigJam, Slides and several files

The plugin runs in Figma Design, FigJam and Figma Slides. `list_sessions` shows each connected file with its editor
(`figma`, `figjam` or `slides`).

## Several files at once

Every tool takes an optional `file`: a file name (exact or a unique part of it) or a session id. The call goes to that
file without changing the selected one, so an agent can read a design file and write into a FigJam board in the same
conversation. Calls to different files run in parallel.

```json
{ "file": "Team board", "spec": { "type": "sticky", "text": "Ship the beta" } }
```

`select_session` still sets the default file for calls without `file`.

## FigJam

`build` creates FigJam nodes in a FigJam file. Any node can set `key`, a stable handle for connectors.

| Type | Spec |
|---|---|
| `sticky` | `{type:"sticky", text, color, wide?, author?}`. Colors: white, gray, green, teal, blue, violet, pink, red, orange, yellow or a hex value. |
| `shape` | `{type:"shape", shape, text, w, h, fill, stroke, strokeWidth, size?, color?}`. Shapes: square, rounded, ellipse, diamond, triangle, parallelogram, database, queue, file, folder, trapezoid, process, shield, document, documents, input, hexagon, chevron, pentagon, octagon, star, plus, arrow-left, arrow-right, speech, storage. |
| `connector` | `{type:"connector", from, to, label?, line:"elbowed"\|"straight"\|"curved", dashed?, color?, strokeWidth?, startArrow?, endArrow?, fromMagnet?, toMagnet?}`. `from` and `to` are a `key`, a layer name from the same build, or a node id. Connectors are created last, so they can point at nodes defined after them. |
| `section` | `{type:"section", name, children, w?, h?, fill?}`. Children are placed with `x`/`y`. Without a size, the section wraps its children with a 40 px margin. Sections work in Figma Design too. |
| `table` | `{type:"table", rows:[["Task","Owner"],["Docs","Ada"]], header?, headerFill?}`. |
| `codeBlock` | `{type:"codeBlock", code, language}`: TypeScript, JavaScript, Python, Go, Rust, SQL, Bash, JSON, HTML, CSS and the other FigJam languages (`ts`, `py`, `sh`… work too). |

### Diagrams

`{type:"diagram", source}` turns a Mermaid flowchart into shapes and connectors, laid out in layers, inside a section:

```json
{
  "type": "diagram",
  "name": "Checkout",
  "source": "flowchart LR\n  A([Cart]) --> B{Signed in?}\n  B -->|yes| C[Payment]\n  B -.->|no| D[Sign in] --> C\n  subgraph Billing\n    C --> E[(Orders)]\n  end"
}
```

- Directions: `TB`/`TD`, `BT`, `LR`, `RL`.
- Node shapes: `[rect]`, `(rounded)`, `([stadium])`, `[[subroutine]]`, `[(database)]`, `((circle))`, `{diamond}`, `{{hexagon}}`, `[/parallelogram/]`, `>flag]`.
- Edges: `-->`, `---`, `-.->` (dashed), `==>` (thick), with labels as `-->|label|` or `-- label -->`. Chains (`A --> B --> C`) and `&` (`A & B --> C`) work.
- `subgraph Name [Title] … end` becomes a nested section.
- `as:"stickies"` uses stickies instead of shapes; `line` sets the connector style.

Layers come from the longest path; crossings are reduced by barycenter ordering, and cycles are allowed.

## Slides

In a Slides file, `{slides:[…]}` creates one 1920×1080 slide per entry:

```json
{ "slides": [
  { "name": "Title", "fill": "#0D0D0D", "children": [{ "text": "Q3 review", "size": 120, "color": "#FFFFFF", "x": 120, "y": 420 }] },
  { "name": "Agenda", "layout": "column", "padding": 120, "gap": 32, "children": [{ "text": "Results", "size": 64 }, { "text": "Next quarter", "size": 64 }] }
] }
```

A slide accepts everything a frame does (auto-layout, fills, children). `{type:"slide"}` creates a single slide.

## Wrong editor

Tools and node types that an editor doesn't support return `WRONG_EDITOR` with a clear message:

- FigJam nodes in a Design file;
- slides outside Slides;
- `prototype` outside Figma Design;
- `annotate` in FigJam or Slides;
- `design_tokens` in FigJam.

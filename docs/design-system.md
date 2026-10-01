# Design system: tokens, health and fixes

## Writing tokens

`design_tokens` with `tokens` creates or updates variable collections (with modes) and paint, text and effect styles
from simple JSON, W3C (DTCG) tokens or a Tailwind theme. Everything is matched by name, so running it again updates
values instead of duplicating them. See the tool description for the accepted shapes.

## Exporting tokens

```json
{ "action": "export", "formats": ["css", "tailwind4", "ts"], "path": "C:/app/src/styles" }
```

Every local variable is exported with all its modes; aliases stay references to the variable they point to. Paint,
text and effect styles are exported too. Files are written to `path` (a folder, created if needed) only when their
content changed, and the result says `created`, `updated` or `unchanged` for each. Without `path` the files come back
as text. `collections` limits the export to some collections.

| Format | File | Content |
|---|---|---|
| `dtcg` | `tokens.json` | W3C Design Tokens. One top-level group per collection, other modes in `$extensions.modes`, aliases as `{Collection.path.to.token}`. Styles are in a `styles` group (color, gradient, typography, shadow). `design_tokens` reads it back into the same collections and modes. |
| `css` | `tokens.css` | Custom properties: default modes in `:root`, every other mode in its own block (`[data-theme="dark"]` by default, see `modeSelector`). Aliases are `var(--…)`. Paint and effect styles become `--color-*` and `--shadow-*`, text styles `.text-*` classes. |
| `tailwind` | `tailwind.preset.js` + `tokens.css` | Tailwind v3 preset (`presets: [require("./tailwind.preset.js")]`) whose values are the CSS variables, so modes keep working. |
| `tailwind4` | `theme.css` | Tailwind v4 `@theme` block using the theme namespaces (`--color-*`, `--spacing-*`, `--radius-*`, `--text-*` with `--line-height`, `--font-*`, `--shadow-*`…), plus mode overrides. |
| `scss` | `_tokens.scss` | SCSS variables (aliases as `$references`, ordered so targets come first), other modes as maps (`$theme-dark`), text style mixins. |
| `ts` | `tokens.ts` | A typed `as const` object. Default values keep aliases as references to other constants; `modes`, `textStyles`, `shadows` and `paints` follow. |
| `json` | `figma-tokens.json` | The simple format `design_tokens` accepts, for copying a design system between files. |

Variables are sorted into Tailwind categories by their scopes, then their names: colors; radius (`CORNER_RADIUS`,
`radius`); font size; font weight; line height; letter spacing; opacity; spacing (`GAP`, `WIDTH_HEIGHT`, `space`,
`gap`, `padding`, `size`). Numbers are written in px except weights, opacities and ratios. Variable names that exist in
two collections get the collection as a prefix.

## Design system health

`audit {scope: "design-system"}` scores the whole file (or `nodeId`) from 0 to 100, with a score per category and
concrete issues (layer id, message):

| Category | Weight | Measures |
|---|---|---|
| tokens | 25 | Share of colors (fills, strokes) and numbers (gap, padding, corner radius) bound to variables or styles. |
| contrast | 20 | Text layers that pass WCAG AA against the solid color behind them. |
| typography | 15 | Text layers that use a text style. |
| components | 15 | Frames named like a component or a variant (probably detached instances), instances with more than 12 overridden properties. |
| styles | 15 | Duplicate styles (same value), styles, variables and components that nothing in the file uses. |
| naming | 10 | Default layer names (`Frame 12`), and token names that don't follow the file's main convention (kebab-case, camelCase, Title Case…). |

The insides of instances are skipped: they belong to their component, which is checked where it is defined.

## Safe fixes

`audit {fix: true}` changes the selection (or `nodeId`, or the current page) and returns every change with the report
after fixing. One fix run is one Ctrl+Z.

| Fix | What it does |
|---|---|
| `colors` | Binds solid fills and strokes to the color variable with the same color (ΔE2000 below 2 and the same opacity), as the layer's own mode sees it. Variable scopes are respected (text fills, frame fills, strokes). Layers using a paint style are left alone. |
| `numbers` | Binds gap, padding and corner radii to a number variable with exactly the same value and a fitting scope (`GAP`, `CORNER_RADIUS`). Zero is never bound. |
| `textStyles` | Applies a local text style whose font, size, line height and letter spacing are exactly those of the text. |
| `names` | Renames default layer names after their content: the first text inside, `Image`, `Icon`, or `Row` / `Column` / `Grid`. |

`fixes: ["colors", "names"]` runs only some of them. Locked layers and instance contents are never changed.

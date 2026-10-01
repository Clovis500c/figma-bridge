# Importing websites and HTML

`import_web` renders a page in a real browser and rebuilds it as editable Figma layers: auto-layout frames, text
layers, vectors and images, with one frame per viewport width.

```json
{ "url": "https://example.com", "viewports": [1440, 390] }
```

| Parameter | Description |
|---|---|
| `url` · `html` · `path` | The page: an http(s) or file URL, HTML markup (a full document or a fragment), or a local `.html` file. Give exactly one. |
| `viewports` | Widths in px, default `[1440, 390]`. Each one becomes a frame; the frames are placed side by side. |
| `selector` | Import one element only, e.g. `"#pricing"` or `"main > section:nth-of-type(2)"`. |
| `parentId` | Frame or section that receives the frames (default: the current page, at the viewport center). |
| `name` | Frame name prefix (default: the page title). |
| `maxHeight` | Import at most this many px from the top of the page (default 12000). |
| `waitMs` | Extra wait after the page has loaded, for pages that render late. |

The result lists each frame with its `rootId`, its layer count and `reference`: a screenshot of the page at that
width. Run `compare {nodeId: rootId, reference}` to measure the difference and fix what stands out.

## Requirements

The page is rendered with [playwright-core](https://www.npmjs.com/package/playwright-core), installed as an optional
dependency of the npm package and loaded only when `import_web` runs. It drives a browser that is already installed,
in this order:

1. `FIGMA_BRIDGE_BROWSER`: path to any Chromium-based browser executable;
2. Google Chrome;
3. Microsoft Edge;
4. a Chromium installed by Playwright.

Nothing is downloaded. Without a browser the tool returns `NO_BROWSER`; without playwright-core (installed with
`--no-optional`), `MISSING_DEPENDENCY`.

## How the layout is rebuilt

The browser computes every box. The importer reads them, infers a layout for each container, then checks it by
simulating Figma's auto-layout. A container keeps auto-layout only if every child lands within 1.5 px of its place in
the page; otherwise its children keep x/y positions (the result lists how many containers this happened to).

| Web | Figma |
|---|---|
| `display: flex` | Auto-layout row or column. `justify-content` → justify (start, center, end, space between), `align-items` → align, `gap` → spacing, `flex-grow` → fill, stretched items → fill. |
| `flex-wrap: wrap`, inline blocks on several lines | Wrapping row with row gap. |
| `display: grid` | Grid auto-layout with the computed tracks (equal tracks become `1fr`), gaps and spans. |
| Block flow (stacked elements) | Column. Equal margins become the gap; different ones add `Spacer` layers. A child aligned differently from its siblings gets an `Align` wrapper. |
| `position: absolute / fixed` | Absolute layer inside the auto-layout frame. |
| `padding` + `border` | Padding (Figma strokes are inside, so borders add to the padding). |
| `overflow: hidden / auto` | Clip content. |
| Background color, `linear-gradient`, `radial-gradient`, `url()` | Fills, in the same stacking order. |
| `border` | Stroke, inside; per-side widths; dashed and dotted. |
| `border-radius` | Corner radius (percentages resolved). |
| `box-shadow` | Drop and inner shadows. |
| `opacity`, `filter: blur()`, `backdrop-filter: blur()` | Opacity, layer blur, background blur. |
| Text | Text layer: font, weight, italic, size, line height, letter spacing, color, alignment, case, underline and strike-through. Inline elements (`<a>`, `<strong>`, `<span>`…) become rich-text spans; links stay links. |
| `::before` / `::after` | Real layers named `Decoration`. |
| `<img>`, `<picture>` | Image layers with `object-fit`. SVG files become vectors. |
| Inline `<svg>` | Vectors; `currentColor`, CSS fills and `<use>` sprites are resolved. |
| `<canvas>`, `<video>`, `<iframe>`, checkboxes, selects | Pictures taken from the rendered page. |
| `<input>`, `<textarea>` | A frame with its value or placeholder. |

Colors in any CSS color space (`oklch`, `lab`, `color()`…) are converted to sRGB. Wrappers that add nothing (same
box as their only child, no visible style) are removed.

**Names** come from `aria-label`, `alt`, the element id, then the first meaningful class (`pricing-card` →
"Pricing card"; utility classes such as Tailwind's and generated hashes are skipped), then the tag: Header, Nav,
Footer, Section, Button, Link, List… Other containers are named Row, Column or Grid.

## Fonts

Each CSS font stack is matched against the fonts installed in Figma: the first installed family wins and the weight
picks the closest style (600 → Semi Bold). Generic families map to common fonts (`sans-serif` and `system-ui` →
Inter, `serif` → Georgia, `monospace` → Roboto Mono). When the page's first choice is missing, the result reports it
in `fontSubstitutions`, e.g. `{"Satoshi": "Inter"}`. Install the font and import again to get exact text widths.

## Limits

- One build call per viewport holds up to 2800 layers. Use `selector` or `maxHeight` for very large pages.
- Pages behind a login, cookie walls and content that needs scrolling interactions are imported as the browser
  sees them at load time. Animations are reduced (`prefers-reduced-motion`) and lazy images are loaded by scrolling
  once through the page.
- Transforms (rotation, scale), blend modes, masks, `conic-gradient`, CSS columns and list markers are not
  reproduced. Background images in formats Figma can't read (SVG, AVIF) are skipped with a warning.
- Text wraps differently when a web font is replaced by another font.

# Figma to Roblox UI

`export_roblox` turns a Figma frame into Roblox UI that looks the same. It uses native Roblox UI objects wherever they
can match the design, and pictures only for what Roblox can't draw.

By default everything is in **scale**: sizes, positions, padding, gaps, grid cells, corner radii, strokes and shadows
are fractions of their parent, so the UI keeps its proportions on every screen. Nothing is in offset unless you ask for
`mode: "offset"` or `"hybrid"`. Instances get professional PascalCase names (`ShopGui`, `ItemCard`, `TitleLabel`,
`BuyButton`, `CoinIcon`): see [Names](#names).

```json
{ "nodeId": "12:34", "targetResolution": [1920, 1080], "rasterize": "auto" }
```

It writes to a new folder (or `outDir`):

| File | What it is |
|---|---|
| `<Name>.rbxmx` | A Roblox model: a `ScreenGui` with the UI, or the root `Frame` with `asRootFrame: true`. Drag it into Studio. |
| `<Name>.luau` | The same UI as a builder script for Studio's command bar or a Studio MCP's `execute_luau` (see below). |
| `01-<layer>.png`… | The pictures: rasterized layers and 9-slice panels at 2×, and the original image fills. |
| `assets.json` | One entry per picture: `placeholder`, `file`, `layer`, `kind`, and `assetId` once uploaded. |

The tool returns the paths, the asset list, font substitutions, warnings (everything approximated or skipped), a `next`
step for the agent, and the Luau itself.

## With a Roblox Studio MCP

The usual workflow, also available as the **figma-to-roblox** prompt:

1. `export_roblox` on the frame.
2. Upload each picture in `assets[]` with the Studio MCP's upload tool (e.g. `upload_image`).
3. Replace each `rbxassetid://PENDING_n` in the Luau with the id it returned.
4. Run the Luau with `execute_luau`. It creates the UI under `PARENT` (default `StarterGui`), replaces a previous copy
   with the same name, and returns the root, so it can be run again after each change.
5. Take a Studio screenshot and compare it with a `screenshot` of the Figma frame; fix and repeat.

Pass `parent` to build somewhere else, for example `"game:GetService(\"Players\").LocalPlayer.PlayerGui"` for a
live test.

## Automatic upload (optional)

With `upload: true`, pictures are uploaded through the Roblox Open Cloud Assets API and their ids are written into
the model and the script directly.

1. On [create.roblox.com](https://create.roblox.com) → **Open Cloud → API Keys**, create a key with the **Assets API**
   (Read and Write) and the experience's creator (you or your group).
2. Add it to the Figma Bridge entry of your AI client:

   ```json
   "env": { "ROBLOX_API_KEY": "…", "ROBLOX_CREATOR_ID": "123456" }
   ```

   `ROBLOX_CREATOR_ID` is your user id, or `group:<id>` for a group.

Pictures are uploaded as **Image** assets (their ids work in `ImageLabel.Image`, unlike decal ids). Each upload is
polled until Roblox has processed it, and ids are cached by content hash in `~/.figma-bridge/roblox-assets.json`, so
an unchanged picture is never uploaded twice. Rate limits (429) and server errors are retried. Without the variables,
`upload: true` adds a warning with these steps and the export still returns placeholders.

## Options

| Option | Default | Effect |
|---|---|---|
| `mode` | `scale` | `scale`: no offsets at all (see [Scale](#scale)). `offset`: pixels everywhere. `hybrid`: scale for free-positioned layers, pixels inside auto-layout. Use the last two only when asked. |
| `targetResolution` | `[1920, 1080]` | The screen the UI is designed for: sizes the root and scales text (below). |
| `rasterize` | `auto` | `auto`: pictures only where needed. `none`: never, approximate instead (with a warning). `all`: every styled layer becomes a picture (pixel-exact, not editable). |
| `asRootFrame` | `false` | The root is a `Frame` instead of a `ScreenGui` (to insert into an existing GUI). |
| `textScaled` | `false` | `TextScaled` on every label in `offset` and `hybrid` modes (always on in `scale` mode). |
| `fonts` | | Figma family → Roblox family name or `rbxasset`/`rbxassetid` URL, e.g. `{"Inter":"GothamSSm"}`. |
| `parent` | `game:GetService("StarterGui")` | Luau expression for the parent of the UI in the script. |

## Scale

In `scale` mode no `UDim` or `UDim2` has an offset:

| What | Scale value |
|---|---|
| Size and position | Fraction of the parent (its content box, inside `UIPadding`, for auto-layout children) |
| Hug sizing | The designed size as a fraction (no `AutomaticSize`, which works in pixels) |
| `UIPadding` | Top and bottom ÷ the frame's height, left and right ÷ its width |
| `UIListLayout.Padding` | Gap ÷ the content box along the fill direction |
| `UIGridLayout` | `CellSize` and `CellPadding` ÷ the content box |
| `UICorner` | Radius ÷ the shortest side (0.5 for pills and circles) |
| `UIStroke` | `StrokeSizingMode = ScaledSize`, `Thickness` = stroke weight ÷ the shortest side |
| `UIShadow` | `BlurRadius` ÷ the shortest side; `Offset` and `Spread` ÷ width and height |
| Text | `TextScaled = true` with a `UITextSizeConstraint` (below) |

Text sized to its content (auto width or auto height in Figma) may grow up to twice its design size on larger screens;
text in a fixed box stays at most at its design size, so a loose box doesn't blow it up. `MinTextSize` is half the
design size.

## Mapping

### Root

- `ScreenGui` with `ResetOnSpawn = false`, `ZIndexBehavior = Sibling`, `IgnoreGuiInset = true`.
- The frame inside it is centered: `AnchorPoint (0.5, 0.5)`, `Position {0.5, 0}, {0.5, 0}`.
- Size: `offset` mode keeps the design size in pixels. Otherwise a frame with the target's aspect ratio (within 10%)
  and at least 40% of its width is a full screen (`{1, 0}, {1, 0}`); anything else is sized as a fraction of the target
  resolution.
- A `UIAspectRatioConstraint` keeps the frame's proportions.
- A full-screen design drawn at another size (say 960×540 for 1920×1080) scales its text by target width ÷ design
  width, except in `offset` mode.

### Which object each layer becomes

| Figma layer | Roblox |
|---|---|
| Text | `TextLabel`; `TextButton` if it has a click/press interaction or its name contains Button, Btn or CTA |
| Frame, group, rectangle, ellipse with a native look | `Frame`; `CanvasGroup` when it has children and opacity < 1; `TextButton` (`Text = ""`) when clickable or named like a button |
| Single image fill, no children, no stroke or effects | `ImageLabel` (`ImageButton` for buttons) |
| Vector, boolean, star, polygon, line, or a frame made only of vectors (icons) | Picture: `ImageLabel` with the 2× PNG |
| Layer with children whose background Roblox can't draw | 9-slice panel: `ImageLabel` with `ScaleType = Slice`, children on top |
| Hidden layer | Skipped (counted in the warnings) |

Roblox draws natively: one solid or linear-gradient fill, one solid stroke, corner radii, drop shadows and opacity. Anything else
(several fills, radial, angular or diamond gradients, a stroke with a gradient or several strokes, dashed strokes,
blurs, inner shadows, an oval ellipse, an image with a stroke or effects) is rasterized. With `rasterize: "none"` it is
approximated (first fill, largest radius) and listed in the warnings.

All buttons get `AutoButtonColor = false` so they keep the design's colors.

### Frames

| Figma | Roblox |
|---|---|
| Solid fill | `BackgroundColor3`, `BackgroundTransparency = 1 − fill opacity × layer opacity` |
| No fill | `BackgroundTransparency = 1` |
| Linear gradient | White background + `UIGradient`: `Color` (ColorSequence), `Transparency` (NumberSequence), `Rotation` = gradient angle; at most 20 stops |
| Image fill behind children | `ImageLabel` named BackgroundImage filling the frame, below the children |
| Corner radius | `UICorner` with the largest radius (scale: ÷ shortest side; offset: pixels); `{0.5, 0}` for circles and full pills, so they stay round at any size |
| Solid stroke | `UIStroke`: `ApplyStrokeMode = Border`, `Color`, `Thickness`, `Transparency`, `LineJoinMode = Round`, `BorderStrokePosition` Inner / Center / Outer from the stroke's alignment; `StrokeSizingMode = ScaledSize` in scale mode |
| Clip content | `ClipsDescendants = true` |
| Opacity with children | `CanvasGroup` with `GroupTransparency` |
| Rotation | `Rotation` (degrees, clockwise) |
| Every frame | `BorderSizePixel = 0` |
| Drop shadow | Native `UIShadow`: `Color`, `Transparency = 1 − alpha`, `BlurRadius`, `Offset`, `Spread` (2 × Figma's spread); the largest one when there are several (warning). Also on images and 9-slice panels. Text shadows are ignored (warning). |

### Auto-layout

| Figma | Roblox |
|---|---|
| Horizontal / vertical | `UIListLayout`: `FillDirection`, `SortOrder = LayoutOrder`, `Padding` = gap |
| Main-axis alignment start / center / end | `HorizontalAlignment` or `VerticalAlignment` Left/Top, Center, Right/Bottom |
| Space between | `HorizontalFlex` / `VerticalFlex = SpaceBetween`, `Padding = 0` |
| Cross-axis alignment | The other alignment property; baseline becomes top (warning) |
| Wrap | `Wraps = true` |
| Padding | `UIPadding` (`PaddingTop`, `PaddingRight`, `PaddingBottom`, `PaddingLeft`) |
| Grid | `UIGridLayout`: `CellSize` from the first cell, `CellPadding` = column and row gaps, `FillDirectionMaxCells` = columns (cells of different sizes: warning) |
| Child order | `LayoutOrder` 1, 2, 3… |
| Fill on the main axis | `UIFlexItem` with `FlexMode = Fill` |
| Fill on the cross axis | Size scale 1 on that axis |
| Hug | `scale`: the designed size; `offset` and `hybrid`: size 0 on that axis + `AutomaticSize` X, Y or XY (text and auto-layout frames) |
| Fixed | `scale` mode: fraction of the parent's content box; `offset` and `hybrid`: pixels |
| Absolute-positioned children | The layout and the flow children go into a transparent `Content` frame (`Size {1, 0}, {1, 0}`); absolute children sit next to it, placed by their constraints, with a `ZIndex` that keeps Figma's stacking order |

### Constraints (free-positioned layers)

In `offset` mode (pixels):

| Constraint | AnchorPoint | Position | Size |
|---|---|---|---|
| Left / Top | 0 | `{0, x}` | `{0, w}` |
| Right / Bottom | 1 | `{1, −distance to the far edge}` | `{0, w}` |
| Center | 0.5 | `{0.5, center − parent center}` | `{0, w}` |
| Left & right / Top & bottom | 0 | `{0, x}` | `{1, −(left + right margins)}` |
| Scale | as Left, Right or Center | scale | scale |

With scale (`scale` mode, and free-positioned layers in `hybrid`), positions and sizes are fractions of the parent:
Right/Bottom anchors at 1 with position `(x + w) / parent`, Center anchors at 0.5 with position
`(x + w/2) / parent`, the rest anchor at 0 with position `x / parent`; size is `w / parent`.

Free-positioned layers get `ZIndex` 1, 2, 3… in Figma's order (later layers on top).

### Text

| Figma | Roblox |
|---|---|
| Characters | `Text` (text case applied) |
| Font family | `FontFace` family `rbxasset://fonts/families/<Name>.json` (table below; `fonts` overrides it) |
| Font weight | `FontFace` weight: the closest of Thin 100, ExtraLight 200, Light 300, Regular 400, Medium 500, SemiBold 600, Bold 700, ExtraBold 800, Heavy 900 |
| Italic / oblique style | `FontFace` style Italic |
| Font size | `TextSize` (scaled for full screens, see Root) + `UITextSizeConstraint` (`MinTextSize` = half; `MaxTextSize` = size, or twice the size for auto-sized text in scale mode) + `TextScaled` in scale mode |
| Fill color and opacity | `TextColor3`, `TextTransparency` |
| Horizontal alignment | `TextXAlignment` Left, Center, Right (justified: Left) |
| Vertical alignment | `TextYAlignment` Top, Center, Bottom |
| Fixed width or fixed size | `TextWrapped = true` |
| Auto width | No wrapping (`AutomaticSize` in offset and hybrid modes) |
| Line height | `LineHeight` = line height ÷ (1.2 × size), between 1 and 3 |
| Truncate with max lines | `TextTruncate = AtEnd` |
| Several styles in one text | `RichText = true`, the longest run sets the label's style and the others become tags: `<font color size weight family transparency>`, `<i>`, `<u>`, `<s>`, `<uc>`, `<sc>` |
| Underline / strikethrough on the whole text | `RichText` with `<u>` / `<s>` |
| Letter spacing | Not supported by Roblox: ignored (warning) |
| Background | `BackgroundTransparency = 1` |

Fonts with the same name in Roblox map directly: Builder Sans, Montserrat, Roboto (Condensed, Mono), Source Sans Pro,
Nunito, Oswald, Merriweather, Ubuntu, Titillium Web, Press Start 2P, Fredoka One, Bangers, Creepster, Luckiest Guy,
Permanent Marker, Patrick Hand, Indie Flower, Amatic SC, Kalam, Michroma, Jura, Sarpanch, Special Elite, Denk One,
Inconsolata, Arimo, and Gotham (GothamSSm). Close matches stand in for the others and are listed in
`fontSubstitutions`:

| Figma | Roblox |
|---|---|
| Inter, SF Pro, Open Sans, Lato, DM Sans, Manrope, Plus Jakarta Sans, Work Sans, Segoe UI | Builder Sans |
| Poppins | Montserrat |
| IBM Plex Sans | Source Sans Pro |
| Arial, Helvetica, Helvetica Neue | Arimo |
| JetBrains Mono, Fira Code, Source Code Pro, SF Mono, Courier New | Roboto Mono |
| Georgia, Times New Roman, Playfair Display | Merriweather |
| Bebas Neue, Anton | Oswald |
| Comic Sans MS | Patrick Hand |
| Anything else | Builder Sans |

### Images and pictures

| Case | Roblox |
|---|---|
| Image fill: fill or crop | `ImageLabel`, `ScaleType = Crop` |
| Image fill: fit | `ScaleType = Fit` |
| Image fill: tile | `ScaleType = Tile` |
| Image corner radius | `UICorner` |
| Every image layer and picture | `UIAspectRatioConstraint` with its proportions |
| Picture of a layer | `ImageLabel`, `ScaleType = Stretch`, 2× PNG; when the picture is larger than the layer (shadows, outside strokes) the box grows by that overflow (as a fraction of the parent in scale mode) |
| 9-slice panel | Picture of the layer's own fill and stroke (no children, no effects), `ScaleType = Slice`, `SliceScale = 0.5`, `SliceCenter` inset by radius + stroke + 2 px (at 2×) |
| Layer opacity | `ImageTransparency` |

Image fills keep their original file (Roblox takes PNG, JPG, BMP and TGA: other formats get a warning).

### Names

Instance names follow the convention of Roblox's own UI examples (`HUDContainer`, `CloseButton`, `HeaderTextLabel`,
`MeterBar`): PascalCase, no spaces, the role first and the kind of instance last.

- A layer with a real name keeps it in PascalCase: `Shop card` → `ShopCard`, `Button/Primary` → `PrimaryButton`,
  `icon/lucide:coins` → `CoinsIcon`.
- A layer Figma named (`Frame 12`, `Rectangle 3`, a text layer named after its text) gets its role, the same rules as
  `build` and `audit {fix:true}` use in Figma ([docs/naming.md](naming.md)): `Header`, `Card`, `CardList`, `Actions`,
  `Row`, `Container`, `Title`, `Description`, `Label`, `Value`, `Button`, `Badge`, `Icon`, `Image`, `Avatar`, `Divider`…
- The kind of instance is added when the name doesn't say it: `TextLabel` → `…Label` (`TitleLabel`), buttons →
  `…Button` (`Btn` becomes `Button`), icons → `…Icon`, images → `…Image`, frames with a background → `…Frame`, other
  frames → `…Container`, unless the name already ends with a role word (`Card`, `Panel`, `Bar`, `List`, `Header`,
  `Badge`, `Content`…).
- The `ScreenGui` is the root's name + `Gui` (`ShopCardGui`).
- Siblings that would share a name are numbered: `Card1`, `Card2`, `Card3`.

The Luau script declares one `local` per instance (camelCase of its name, made unique), groups each top-level section
under a comment, sets every property before `Parent`, and uses `Font.new` / `FontFace`, never the deprecated `Font`
enum property. Up to 2000 layers are exported per call.

## Limits

- Not verifiable without Roblox Studio: how close a font substitution looks, and exact text metrics (Roblox and Figma
  lay out text differently: check line breaks in the Studio screenshot).
- Text strokes, text shadows, paragraph spacing and letter spacing have no Roblox equivalent.
- `TextScaled` fits text to its box: rich text with several sizes may not keep their ratio (warning).
- `UIShadow` blur and spread are converted 1:1 from Figma's values; how close the softness looks is only visible in
  Studio.
- Prototype interactions are not converted to scripts: buttons are created, their behavior is up to you.
- Component variants export as their current state only.

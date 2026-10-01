import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import luaparse from "luaparse";
import { exportRoblox } from "../src/roblox/export";
import { robloxFamily, robloxWeight } from "../src/roblox/fonts";
import { decide, mapToRoblox, pictureRequests, type RbxInstance, type RbxValue, type RNode, type RobloxOptions, robloxName } from "../src/roblox/map";
import { luauString, substituteAssets, toLuau, toRbxmx } from "../src/roblox/output";
import { creatorFrom, RobloxUploader } from "../src/roblox/upload";

const card = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "roblox", "card.json"), "utf8")) as RNode;
const OPTS: RobloxOptions = { mode: "scale", targetResolution: [1920, 1080], rasterize: "auto", scale: 2 };

// A 1×1 PNG header is all the exporter reads.
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(1), ...u32(1), 8, 6, 0, 0, 0]);
const PNG64 = Buffer.from(PNG).toString("base64");

/** The plugin side: roblox_tree returns the fixture, roblox_images a picture per request. */
function fakePlugin(tree: RNode = card) {
  const calls: { method: string; params: any }[] = [];
  const request = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
    if (method === "roblox_tree") return { tree, images: { abc: PNG64 }, nodes: 12, truncated: false, fileName: "Shop UI" } as T;
    if (method === "roblox_images") {
      const items = params.items as { id: string; mode: string; scale: number }[];
      return {
        images: items.map((it) => ({ id: it.id, mode: it.mode, b64: PNG64, offset: { x: 0, y: 0 }, size: { w: 72, h: 28 } })),
      } as T;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request, calls };
}

const find = (i: RbxInstance, name: string): RbxInstance | undefined => (i.name === name ? i : i.children.map((c) => find(c, name)).find(Boolean));
const prop = (i: RbxInstance | undefined, k: string): RbxValue | undefined => i?.props.find(([p]) => p === k)?.[1];
const kids = (i: RbxInstance | undefined) => (i?.children ?? []).map((c) => c.className);

function mapCard(opts: Partial<RobloxOptions> = {}, tree: RNode = card) {
  return mapToRoblox(tree, { ...OPTS, ...opts }, (key) => ({ url: `rbxassetid://${key}` }));
}

/** Every UDim and UDim2 in the tree, with the instance and property they belong to. */
function udims(i: RbxInstance, out: { at: string; v: RbxValue }[] = []) {
  for (const [k, v] of i.props) if (v.t === "UDim" || v.t === "UDim2") out.push({ at: `${i.name}.${k}`, v });
  for (const c of i.children) udims(c, out);
  return out;
}

describe("mapping", () => {
  test("pictures only for what Roblox can't draw", () => {
    expect(pictureRequests(card, OPTS)).toEqual([
      { id: "1:6", mode: "full" },
      { id: "1:9", mode: "panel" },
    ]);
    // A drop shadow is native (UIShadow): the card stays a frame.
    expect(decide(card, OPTS)).toMatchObject({ kind: "frame" });
    expect(decide(card.children![2]!, OPTS).kind).toBe("image");
    expect(pictureRequests(card, { ...OPTS, rasterize: "none" })).toEqual([]);
    expect(pictureRequests(card, { ...OPTS, rasterize: "all" }).map((p) => p.mode)).toEqual(["panel", "full", "full", "panel", "panel"]);
  });

  test("scale mode (the default) has no offset anywhere", () => {
    const { root } = mapCard();
    const all = udims(root);
    expect(all.length).toBeGreaterThan(20);
    const offsets = all.filter(({ v }) => (v.t === "UDim" ? v.o !== 0 : v.t === "UDim2" && (v.xo !== 0 || v.yo !== 0)));
    expect(offsets).toEqual([]);
    const strokes: RbxInstance[] = [];
    const walk = (i: RbxInstance) => (i.className === "UIStroke" && strokes.push(i), i.children.forEach(walk));
    walk(root);
    for (const s of strokes) expect(prop(s, "StrokeSizingMode")).toEqual({ t: "enum", e: "StrokeSizingMode", v: "ScaledSize" });
    const automatic: string[] = [];
    const auto = (i: RbxInstance) => (prop(i, "AutomaticSize") && automatic.push(i.name), i.children.forEach(auto));
    auto(root);
    expect(automatic).toEqual([]);
  });

  test("ScreenGui root, centered card with a native shadow", () => {
    const { root, warnings, fontSubstitutions } = mapCard();
    expect(root.className).toBe("ScreenGui");
    expect(root.name).toBe("ShopCardGui");
    expect(prop(root, "ResetOnSpawn")).toEqual({ t: "bool", v: false });
    expect(prop(root, "ZIndexBehavior")).toEqual({ t: "enum", e: "ZIndexBehavior", v: "Sibling" });
    const panel = root.children[0]!;
    expect(panel).toMatchObject({ className: "Frame", name: "ShopCard" });
    expect(prop(panel, "AnchorPoint")).toEqual({ t: "Vector2", x: 0.5, y: 0.5 });
    expect(prop(panel, "Size")).toEqual({ t: "UDim2", xs: 0.2083, xo: 0, ys: 0.2778, yo: 0 });
    expect(kids(panel)).toEqual(["UICorner", "UIStroke", "UIShadow", "Frame", "ImageLabel", "UIAspectRatioConstraint"]);
    expect(prop(panel, "BackgroundColor3")).toEqual({ t: "Color3", r: 1, g: 1, b: 1 });
    expect(prop(panel, "ClipsDescendants")).toEqual({ t: "bool", v: true });
    // Radius 16 on a 300 px short side; 1 px inside stroke.
    expect(prop(find(panel, "UICorner"), "CornerRadius")).toEqual({ t: "UDim", s: 0.0533, o: 0 });
    const stroke = find(panel, "UIStroke")!;
    expect(prop(stroke, "Thickness")).toEqual({ t: "float", v: 0.0033 });
    expect(prop(stroke, "BorderStrokePosition")).toEqual({ t: "enum", e: "BorderStrokePosition", v: "Inner" });
    const shadow = find(panel, "UIShadow")!;
    expect(prop(shadow, "Transparency")).toEqual({ t: "float", v: 0.8 });
    expect(prop(shadow, "BlurRadius")).toEqual({ t: "UDim", s: 0.08, o: 0 });
    expect(prop(shadow, "Offset")).toEqual({ t: "UDim2", xs: 0, xo: 0, ys: 0.0267, yo: 0 });
    expect(warnings).toContain("1 hidden layer(s) skipped");
    expect(warnings).toContain("Label: letter spacing has no Roblox equivalent: ignored");
    expect(fontSubstitutions).toEqual({ Inter: "BuilderSans" });
  });

  test("professional names: roles for Figma's default names, Roblox suffixes, unique siblings", () => {
    const { root } = mapCard();
    const names: string[] = [];
    const walk = (i: RbxInstance) => (!/^UI/.test(i.className) && names.push(`${i.className} ${i.name}`), i.children.forEach(walk));
    walk(root);
    expect(names).toEqual([
      "ScreenGui ShopCardGui",
      "Frame ShopCard",
      "Frame Content",
      "TextLabel TitleLabel",
      "TextLabel PriceLabel",
      "ImageLabel Image",
      "Frame Row",
      "ImageLabel Icon",
      "TextButton BuyButton",
      "TextLabel Label",
      "ImageLabel Badge",
      "TextLabel Label",
    ]);
    expect(robloxName("Close", "button")).toBe("CloseButton");
    expect(robloxName("PlayBtn", "button")).toBe("PlayButton");
    expect(robloxName("Coin", "icon")).toBe("CoinIcon");
    expect(robloxName("Preview", "image")).toBe("PreviewImage");
    expect(robloxName("Inventory", "frame")).toBe("InventoryFrame");
    expect(robloxName("Stats", "container")).toBe("Stats");
    expect(robloxName("Items", "container")).toBe("ItemsContainer");
    const list: RNode = {
      id: "l",
      name: "Frame 3",
      type: "FRAME",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      layout: { mode: "VERTICAL", padding: [0, 0, 0, 0], gap: 8, primary: "MIN", counter: "MIN" },
      children: [1, 2, 3].map((k) => ({ id: `c${k}`, name: `Frame ${k}`, type: "FRAME", x: 0, y: (k - 1) * 100, w: 400, h: 92, fills: [{ type: "SOLID", opacity: 1, color: "#FFFFFF" }], radius: [8, 8, 8, 8], children: [{ id: `t${k}`, name: "Item", type: "TEXT", x: 8, y: 8, w: 100, h: 20, text: { characters: "Item", align: "LEFT", valign: "TOP", autoResize: "WIDTH_AND_HEIGHT", maxLines: 0, segments: [] } }, { id: `d${k}`, name: "Rectangle", type: "RECTANGLE", x: 0, y: 90, w: 400, h: 1, fills: [{ type: "SOLID", opacity: 1, color: "#EEEEEE" }] }] })),
    };
    const out = mapCard({ asRootFrame: true }, list).root;
    expect(out.name).toBe("CardList");
    expect(out.children.filter((c) => c.className === "Frame").map((c) => c.name)).toEqual(["Card1", "Card2", "Card3"]);
    expect(out.children[1]!.children.map((c) => c.name)).toContain("Divider");
  });

  test("auto-layout becomes UIListLayout + UIPadding in scale, absolute children an overlay", () => {
    const panel = mapCard().root.children[0]!;
    const content = find(panel, "Content")!;
    expect(kids(content)).toEqual(["UIPadding", "UIListLayout", "TextLabel", "TextLabel", "ImageLabel", "Frame"]);
    const list = find(content, "UIListLayout")!;
    expect(prop(list, "FillDirection")).toEqual({ t: "enum", e: "FillDirection", v: "Vertical" });
    // 12 px gap over a 252 px tall content box, 24 px padding over 300 × 400.
    expect(prop(list, "Padding")).toEqual({ t: "UDim", s: 0.0476, o: 0 });
    expect(prop(list, "SortOrder")).toEqual({ t: "enum", e: "SortOrder", v: "LayoutOrder" });
    expect(prop(find(content, "UIPadding"), "PaddingLeft")).toEqual({ t: "UDim", s: 0.06, o: 0 });
    expect(prop(find(content, "UIPadding"), "PaddingTop")).toEqual({ t: "UDim", s: 0.08, o: 0 });
    // Badge sits outside the layout, pinned to the right edge with a scale position, above the content.
    const badge = panel.children.find((c) => c.name === "Badge")!;
    expect(prop(badge, "AnchorPoint")).toEqual({ t: "Vector2", x: 1, y: 0 });
    expect(prop(badge, "Position")).toEqual({ t: "UDim2", xs: 0.98, xo: 0, ys: -0.0333, yo: 0 });
    expect(prop(badge, "ZIndex")).toEqual({ t: "int", v: 5 });
    expect(prop(badge, "ScaleType")).toEqual({ t: "enum", e: "ScaleType", v: "Slice" });
    expect(prop(badge, "SliceCenter")).toEqual({ t: "Rect", x0: 32, y0: 27, x1: 112, y1: 29 });
  });

  test("fill, fixed and grow in scale; hug only in offset or hybrid", () => {
    const panel = mapCard().root.children[0]!;
    const title = find(panel, "TitleLabel")!;
    expect(prop(title, "Size")).toEqual({ t: "UDim2", xs: 0.4545, xo: 0, ys: 0.119, yo: 0 });
    expect(prop(title, "LayoutOrder")).toEqual({ t: "int", v: 1 });
    expect(prop(find(panel, "PriceLabel"), "Size")).toEqual({ t: "UDim2", xs: 1, xo: 0, ys: 0.0873, yo: 0 });
    const row = find(panel, "Row")!;
    expect(prop(find(row, "UIListLayout"), "HorizontalFlex")).toEqual({ t: "enum", e: "UIFlexAlignment", v: "SpaceBetween" });
    expect(prop(find(row, "UIListLayout"), "VerticalAlignment")).toEqual({ t: "enum", e: "VerticalAlignment", v: "Center" });
    const buy = find(row, "BuyButton")!;
    expect(buy.className).toBe("TextButton");
    expect(prop(buy, "AutoButtonColor")).toEqual({ t: "bool", v: false });
    expect(prop(buy, "Text")).toEqual({ t: "string", v: "" });
    expect(kids(buy)).toEqual(["UIGradient", "UICorner", "UIPadding", "UIListLayout", "TextLabel", "UIFlexItem"]);
    expect(prop(find(buy, "UICorner"), "CornerRadius")).toEqual({ t: "UDim", s: 0.5, o: 0 });
    expect(prop(find(buy, "UIFlexItem"), "FlexMode")).toEqual({ t: "enum", e: "UIFlexMode", v: "Fill" });
    expect(prop(find(buy, "UIGradient"), "Color")).toMatchObject({ t: "ColorSequence", keys: [{ time: 0 }, { time: 1 }] });
    const icon = find(row, "Icon")!;
    expect(icon.className).toBe("ImageLabel");
    expect(prop(icon, "Image")).toEqual({ t: "Content", url: "rbxassetid://1:6:full" });
    const image = find(panel, "Image")!;
    expect(prop(image, "ScaleType")).toEqual({ t: "enum", e: "ScaleType", v: "Crop" });
    expect(kids(image)).toEqual(["UICorner", "UIAspectRatioConstraint"]);
    // Hybrid keeps pixels inside auto-layout and sizes hugging layers from their content.
    const hybrid = mapCard({ mode: "hybrid" }).root.children[0]!;
    const hTitle = find(hybrid, "TitleLabel")!;
    expect(prop(hTitle, "Size")).toEqual({ t: "UDim2", xs: 0, xo: 0, ys: 0, yo: 0 });
    expect(prop(hTitle, "AutomaticSize")).toEqual({ t: "enum", e: "AutomaticSize", v: "XY" });
    expect(prop(find(hybrid, "UIListLayout"), "Padding")).toEqual({ t: "UDim", s: 0, o: 12 });
    expect(prop(find(hybrid, "UICorner"), "CornerRadius")).toEqual({ t: "UDim", s: 0, o: 16 });
    expect(prop(find(hybrid, "UIStroke"), "StrokeSizingMode")).toBeUndefined();
  });

  test("text: fonts, weights, rich text, TextScaled sizes", () => {
    const panel = mapCard().root.children[0]!;
    const title = find(panel, "TitleLabel")!;
    expect(prop(title, "FontFace")).toEqual({ t: "Font", family: "rbxasset://fonts/families/BuilderSans.json", weight: 700, weightName: "Bold", style: "Normal" });
    expect(prop(title, "TextSize")).toEqual({ t: "int", v: 24 });
    expect(prop(title, "TextScaled")).toEqual({ t: "bool", v: true });
    expect(prop(title, "LineHeight")).toEqual({ t: "float", v: 1.0417 });
    expect(prop(title, "TextWrapped")).toBeUndefined();
    // Text sized to its content may grow with the screen; text in a fixed box stays at most at its design size.
    expect(prop(find(title, "UITextSizeConstraint"), "MaxTextSize")).toEqual({ t: "int", v: 48 });
    const price = find(panel, "PriceLabel")!;
    expect(prop(price, "RichText")).toEqual({ t: "bool", v: true });
    expect(prop(price, "Text")).toEqual({ t: "string", v: '<font color="#6B7280" weight="400">Only </font>250 coins' });
    expect(prop(price, "TextWrapped")).toEqual({ t: "bool", v: true });
    const label = find(find(panel, "BuyButton")!, "Label")!;
    expect(prop(label, "FontFace")).toMatchObject({ family: "rbxasset://fonts/families/Montserrat.json", weightName: "SemiBold" });
    expect(prop(label, "TextXAlignment")).toEqual({ t: "enum", e: "TextXAlignment", v: "Center" });
    const badgeText = find(find(panel, "Badge")!, "Label")!;
    expect(prop(badgeText, "TextTruncate")).toEqual({ t: "enum", e: "TextTruncate", v: "AtEnd" });
    expect(prop(find(badgeText, "UITextSizeConstraint"), "MaxTextSize")).toEqual({ t: "int", v: 12 });
    expect(prop(find(mapCard({ mode: "offset" }).root, "TitleLabel"), "TextScaled")).toBeUndefined();
    expect(prop(find(mapCard({ mode: "offset", textScaled: true }).root, "TitleLabel"), "TextScaled")).toEqual({ t: "bool", v: true });
  });

  test("a full-screen design scales its text to the target resolution", () => {
    const screen: RNode = { id: "9:1", name: "HUD", type: "FRAME", x: 0, y: 0, w: 960, h: 540, fills: [], children: [{ ...card.children![0]!, constraints: { h: "MIN", v: "MIN" }, sizing: undefined }] };
    const { root } = mapCard({}, screen);
    expect(root.name).toBe("HUDGui");
    const hud = root.children[0]!;
    expect(prop(hud, "Size")).toEqual({ t: "UDim2", xs: 1, xo: 0, ys: 1, yo: 0 });
    expect(prop(find(hud, "TitleLabel"), "TextSize")).toEqual({ t: "int", v: 48 });
    expect(prop(mapCard({ mode: "offset" }, screen).root.children[0]!.children.find((c) => c.name === "TitleLabel"), "TextSize")).toEqual({ t: "int", v: 24 });
  });

  test("scale vs offset geometry for constraints", () => {
    const box = (id: string, h: string, v: string): RNode => ({ id, name: id, type: "FRAME", x: 100, y: 50, w: 200, h: 100, constraints: { h, v }, fills: [{ type: "SOLID", opacity: 1, color: "#123456" }] });
    const screen: RNode = { id: "0", name: "Screen", type: "FRAME", x: 0, y: 0, w: 1000, h: 500, children: [box("Max", "MAX", "MAX"), box("Center", "CENTER", "CENTER"), box("Stretch", "STRETCH", "MIN")] };
    const off = mapCard({ mode: "offset" }, screen).root.children[0]!;
    expect(prop(find(off, "MaxFrame"), "AnchorPoint")).toEqual({ t: "Vector2", x: 1, y: 1 });
    expect(prop(find(off, "MaxFrame"), "Position")).toEqual({ t: "UDim2", xs: 1, xo: -700, ys: 1, yo: -350 });
    expect(prop(find(off, "CenterFrame"), "Position")).toEqual({ t: "UDim2", xs: 0.5, xo: -300, ys: 0.5, yo: -150 });
    expect(prop(find(off, "StretchFrame"), "Size")).toEqual({ t: "UDim2", xs: 1, xo: -800, ys: 0, yo: 100 });
    expect(prop(off, "Size")).toEqual({ t: "UDim2", xs: 0, xo: 1000, ys: 0, yo: 500 });
    const scale = mapCard({ mode: "scale" }, screen).root.children[0]!;
    expect(prop(find(scale, "MaxFrame"), "Position")).toEqual({ t: "UDim2", xs: 0.3, xo: 0, ys: 0.3, yo: 0 });
    expect(prop(find(scale, "CenterFrame"), "Position")).toEqual({ t: "UDim2", xs: 0.2, xo: 0, ys: 0.2, yo: 0 });
    expect(prop(find(scale, "StretchFrame"), "Size")).toEqual({ t: "UDim2", xs: 0.2, xo: 0, ys: 0.2, yo: 0 });
    expect(prop(find(scale, "MaxFrame"), "ZIndex")).toEqual({ t: "int", v: 1 });
  });

  test("rasterize none approximates and says so", () => {
    const { root, warnings } = mapCard({ rasterize: "none" });
    const panel = root.children[0]!;
    expect(find(panel, "Badge")!.className).toBe("Frame");
    expect(prop(find(panel, "Badge"), "BackgroundColor3")).toEqual({ t: "Color3", r: 0.9373, g: 0.2667, b: 0.2667 });
    expect(find(panel, "UIShadow")).toBeDefined();
    expect(warnings).toContain("Badge: several fills: approximated (rasterize is none)");
    expect(warnings).toContain("Icon: vector shape skipped (rasterize is none)");
  });

  test("asRootFrame returns the frame itself", () => {
    expect(mapCard({ asRootFrame: true }).root).toMatchObject({ className: "Frame", name: "ShopCard" });
  });
});

describe("fonts", () => {
  test("families and weights", () => {
    expect(robloxFamily("Inter")).toEqual({ url: "rbxasset://fonts/families/BuilderSans.json", substituted: true });
    expect(robloxFamily("Montserrat")).toEqual({ url: "rbxasset://fonts/families/Montserrat.json", substituted: false });
    expect(robloxFamily("Gotham")).toEqual({ url: "rbxasset://fonts/families/GothamSSm.json", substituted: false });
    expect(robloxFamily("Unknown Sans").url).toBe("rbxasset://fonts/families/BuilderSans.json");
    expect(robloxFamily("inter", { Inter: "Gotham SSm" })).toEqual({ url: "rbxasset://fonts/families/GothamSSm.json", substituted: false });
    expect(robloxFamily("Brand", { Brand: "rbxassetid://123" }).url).toBe("rbxassetid://123");
    expect(robloxWeight(650)).toEqual({ value: 600, name: "SemiBold" });
    expect(robloxWeight(950)).toEqual({ value: 900, name: "Heavy" });
  });
});

// ─── Output ─────────────────────────────────────────────────────────────────

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** A strict little XML parser: enough to prove the model is well-formed and read it back. */
function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: "#doc", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<(\/?)([\w:]+)((?:\s+[\w:]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let pos = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index !== pos) throw new Error(`Unexpected markup at ${pos}: ${src.slice(pos, pos + 30)}`);
    pos = re.lastIndex;
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(m[5])) throw new Error(`Bad text: ${m[5]}`);
      top.text += m[5].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      continue;
    }
    if (m[1]) {
      if (top.tag !== m[2]) throw new Error(`</${m[2]}> closes <${top.tag}>`);
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3]!.matchAll(/([\w:]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
    const node: XmlNode = { tag: m[2]!, attrs, children: [], text: "" };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  if (pos !== src.length || stack.length !== 1) throw new Error("Unclosed tags");
  return root.children[0]!;
}

const items = (x: XmlNode): XmlNode[] => x.children.filter((c) => c.tag === "Item");
const props = (item: XmlNode) => item.children.find((c) => c.tag === "Properties")!.children;
const propOf = (item: XmlNode, name: string) => props(item).find((p) => p.attrs.name === name);

describe("rbxmx", () => {
  const { root } = mapCard();
  const doc = parseXml(toRbxmx(root));

  test("well-formed model with the same hierarchy", () => {
    expect(doc.tag).toBe("roblox");
    expect(doc.attrs.version).toBe("4");
    const gui = items(doc)[0]!;
    expect(gui.attrs.class).toBe("ScreenGui");
    expect(propOf(gui, "Name")!.text).toBe("ShopCardGui");
    const count = (x: XmlNode): number => items(x).reduce((a, c) => a + 1 + count(c), 0);
    const countI = (i: RbxInstance): number => 1 + i.children.reduce((a, c) => a + countI(c), 0);
    expect(count(doc)).toBe(countI(root));
    const refs = new Set<string>();
    const walk = (x: XmlNode) => items(x).forEach((c) => (refs.add(c.attrs.referent!), walk(c)));
    walk(doc);
    expect(refs.size).toBe(countI(root));
  });

  test("typed properties", () => {
    const gui = items(doc)[0]!;
    expect(propOf(gui, "ZIndexBehavior")).toMatchObject({ tag: "token", text: "1" });
    const panel = items(gui)[0]!;
    const size = propOf(panel, "Size")!;
    expect(size.tag).toBe("UDim2");
    expect(size.children.map((c) => `${c.tag}=${c.text}`)).toEqual(["XS=0.2083", "XO=0", "YS=0.2778", "YO=0"]);
    const content = items(panel).find((i) => propOf(i, "Name")!.text === "Content")!;
    const price = items(content).find((i) => propOf(i, "Name")!.text === "PriceLabel")!;
    // Rich text survives the XML escaping.
    expect(propOf(price, "Text")!.text).toBe('<font color="#6B7280" weight="400">Only </font>250 coins');
    const font = propOf(price, "FontFace")!;
    expect(font.tag).toBe("Font");
    expect(font.children.map((c) => c.tag)).toEqual(["Family", "Weight", "Style"]);
    const buy = items(items(content).find((i) => propOf(i, "Name")!.text === "Row")!).find((i) => i.attrs.class === "TextButton")!;
    const gradient = items(buy).find((i) => i.attrs.class === "UIGradient")!;
    expect(propOf(gradient, "Color")!.text.trim().split(/\s+/)).toHaveLength(10);
    const stroke = items(panel).find((i) => i.attrs.class === "UIStroke")!;
    expect(propOf(stroke, "StrokeSizingMode")).toMatchObject({ tag: "token", text: "1" });
    expect(propOf(stroke, "BorderStrokePosition")).toMatchObject({ tag: "token", text: "2" });
    const shadow = items(panel).find((i) => i.attrs.class === "UIShadow")!;
    expect(propOf(shadow, "BlurRadius")!.children.map((c) => c.text)).toEqual(["0.08", "0"]);
  });
});

describe("Luau", () => {
  const { root } = mapCard();
  const luau = toLuau(root, { source: 'Shop card" in "Shop UI' });

  test("parses, replaces a previous copy, returns the root", () => {
    expect(() => luaparse.parse(luau, { luaVersion: "5.3" })).not.toThrow();
    expect(luau).toContain('local existing = PARENT:FindFirstChild("ShopCardGui")');
    expect(luau).toContain("existing:Destroy()");
    expect(luau.trimEnd().endsWith("return shopCardGui")).toBe(true);
    expect(luau).not.toMatch(/UDim2\.fromOffset|UDim2\.new\([^)]*[1-9]\d*\)|UDim\.new\([^,]+, [1-9]/);
    // One local per instance, parents set after properties.
    const countI = (i: RbxInstance): number => 1 + i.children.reduce((a, c) => a + countI(c), 0);
    expect(luau.match(/= Instance\.new\(/g)).toHaveLength(countI(root));
    expect(luau).not.toMatch(/\bFont\s*=|Enum\.Font\.|BorderColor3|\.Style\s*=/);
  });

  test("snapshot", () => {
    expect(luau).toMatchSnapshot();
  });

  test("strings and identifiers are safe", () => {
    expect(luauString('a "b"\n\\c\u0001')).toBe('"a \\"b\\"\\n\\\\c\\1"');
    const odd: RbxInstance = { className: "Frame", name: "end", props: [["Name", { t: "string", v: "end" }]], children: [{ className: "Frame", name: "2 cols", props: [], children: [] }, { className: "Frame", name: "2 cols", props: [], children: [] }] };
    const code = toLuau(odd);
    expect(() => luaparse.parse(code, { luaVersion: "5.3" })).not.toThrow();
    expect(code).toContain("local endGui = ");
    expect(code).toContain("local frame2Cols = ");
    expect(code).toContain("local frame2Cols2 = ");
  });

  test("placeholders are replaced by uploaded ids", () => {
    expect(substituteAssets('Image = "rbxassetid://PENDING_1" -- rbxassetid://PENDING_12', { "rbxassetid://PENDING_1": "111" })).toBe('Image = "rbxassetid://111" -- rbxassetid://PENDING_12');
  });
});

// ─── Export and upload ─────────────────────────────────────────────────────

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("export_roblox", () => {
  test("writes the model, the script and the pictures with placeholders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-roblox-"));
    try {
      const plugin = fakePlugin();
      const out = await exportRoblox({ nodeId: "1:1", upload: true }, { request: plugin.request, outDir: dir, env: {} });
      expect(plugin.calls.map((c) => c.method)).toEqual(["roblox_tree", "roblox_images"]);
      expect(plugin.calls[1]!.params.items).toEqual([
        { id: "1:6", mode: "full", scale: 2 },
        { id: "1:9", mode: "panel", scale: 2 },
      ]);
      const r = out.result;
      expect(r.uploaded).toBe(false);
      expect(r.options.mode).toBe("scale");
      expect(r.assets.map((a) => [a.placeholder, a.kind, a.layer])).toEqual([
        ["rbxassetid://PENDING_1", "picture", "Icon"],
        ["rbxassetid://PENDING_2", "picture", "Badge"],
        ["rbxassetid://PENDING_3", "image", "Rectangle 4"],
      ]);
      for (const a of r.assets) expect(existsSync(a.file)).toBe(true);
      expect(existsSync(r.rbxmx) && existsSync(r.luau)).toBe(true);
      expect(readFileSync(r.luau, "utf8")).toContain('"rbxassetid://PENDING_3"');
      expect(r.warnings!.some((w) => /upload skipped: ROBLOX_API_KEY/.test(w))).toBe(true);
      expect(r.next).toMatch(/execute_luau/);
      expect(JSON.parse(readFileSync(join(r.dir, "assets.json"), "utf8"))).toHaveLength(3);
      expect(() => parseXml(out.rbxmx)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uploads through Open Cloud, polls, caches and fills in the ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-roblox-"));
    try {
      const seen: { url: string; init?: RequestInit }[] = [];
      let next = 100;
      const fetchImpl = async (url: string, init?: RequestInit) => {
        seen.push({ url, init });
        if (url.endsWith("/assets/v1/assets")) return json(200, { path: `operations/op${next}`, operationId: `op${next}`, done: false });
        const id = /op(\d+)$/.exec(url)![1];
        return json(200, { done: true, response: { assetId: String(Number(id) + 1000) } });
      };
      const env = { ROBLOX_API_KEY: "key", ROBLOX_CREATOR_ID: "group:42", FIGMA_BRIDGE_HOME: dir };
      const plugin = fakePlugin();
      const out = await exportRoblox({ upload: true, outDir: join(dir, "out") }, { request: plugin.request, outDir: dir, env, fetchImpl, sleep: async () => {} });
      // Every picture is the same tiny PNG: uploaded once, then served from the cache.
      expect(seen.filter((s) => s.url.endsWith("/assets/v1/assets"))).toHaveLength(1);
      expect(out.result.uploaded).toBe(true);
      expect(out.result.assets.map((a) => [a.assetId, !!a.cached])).toEqual([
        ["1100", false],
        ["1100", true],
        ["1100", true],
      ]);
      expect(out.luau).not.toContain("PENDING");
      expect(out.rbxmx).toContain("<url>rbxassetid://1100</url>");
      const post = seen[0]!.init!;
      expect((post.headers as Record<string, string>)["x-api-key"]).toBe("key");
      const form = post.body as FormData;
      expect(JSON.parse(String(form.get("request")))).toMatchObject({ assetType: "Image", creationContext: { creator: { groupId: "42" } } });
      expect(form.get("fileContent")).toBeInstanceOf(Blob);
      expect(JSON.parse(readFileSync(join(dir, "roblox-assets.json"), "utf8"))).toEqual({ [RobloxUploader.hash(PNG)]: "1100" });
      expect(out.result.next).toMatch(/Run the Luau/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upload errors are explained, 429 is retried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-roblox-"));
    try {
      const waits: number[] = [];
      const replies = [json(429, {}, { "retry-after": "3" }), json(200, { done: true, response: { assetId: "7" } })];
      const ok = new RobloxUploader({ apiKey: "k", creatorId: "1", cacheFile: join(dir, "a.json"), fetchImpl: async () => replies.shift()!, sleep: async (ms) => void waits.push(ms) });
      expect(await ok.upload(PNG, "x")).toEqual({ assetId: "7", cached: false });
      expect(waits).toEqual([3000]);
      const denied = new RobloxUploader({ apiKey: "k", creatorId: "1", cacheFile: join(dir, "b.json"), fetchImpl: async () => json(403, { message: "Invalid API key" }), sleep: async () => {} });
      await expect(denied.upload(PNG, "x")).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Invalid API key") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creator ids", () => {
    expect(creatorFrom("123")).toEqual({ userId: "123" });
    expect(creatorFrom("user:9")).toEqual({ userId: "9" });
    expect(creatorFrom("Group/77")).toEqual({ groupId: "77" });
    expect(() => creatorFrom("me")).toThrow(/ROBLOX_CREATOR_ID/);
  });
});

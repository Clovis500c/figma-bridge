import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import luaparse from "luaparse";
import { exportRoblox } from "../src/roblox/export";
import { robloxFamily, robloxWeight } from "../src/roblox/fonts";
import { decide, mapToRoblox, pictureRequests, robloxName, type RbxInstance, type RbxValue, type RNode, type RobloxOptions } from "../src/roblox/map";
import { luauString, substituteAssets, toLuau, toRbxmx } from "../src/roblox/output";
import { creatorFrom, RobloxUploader } from "../src/roblox/upload";

const card = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "roblox", "card.json"), "utf8")) as RNode;
const OPTS: RobloxOptions = { mode: "hybrid", targetResolution: [1920, 1080], rasterize: "auto", scale: 2 };

// A 1×1 PNG header is all the exporter reads.
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(1), ...u32(1), 8, 6, 0, 0, 0]);
const PNG64 = Buffer.from(PNG).toString("base64");

/** The plugin side: roblox_tree returns the fixture, roblox_images a picture per request (shadows overflow the layer). */
function fakePlugin(tree: RNode = card) {
  const calls: { method: string; params: any }[] = [];
  const request = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
    if (method === "roblox_tree") return { tree, images: { abc: PNG64 }, nodes: 12, truncated: false, fileName: "Shop UI" } as T;
    if (method === "roblox_images") {
      const items = params.items as { id: string; mode: string; scale: number }[];
      return {
        images: items.map((it) =>
          it.mode === "shadow" ? { id: it.id, mode: it.mode, b64: PNG64, offset: { x: -24, y: -16 }, size: { w: 448, h: 356 } } : { id: it.id, mode: it.mode, b64: PNG64, offset: { x: 0, y: 0 }, size: { w: 72, h: 28 } },
        ),
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
  return mapToRoblox(tree, { ...OPTS, ...opts }, (key) => ({ url: `rbxassetid://${key}`, ...(key.endsWith(":shadow") ? { offset: { x: -24, y: -16 }, size: { w: 448, h: 356 } } : {}) }));
}

describe("mapping", () => {
  test("pictures only for what Roblox can't draw", () => {
    expect(pictureRequests(card, OPTS)).toEqual([
      { id: "1:1", mode: "shadow" },
      { id: "1:6", mode: "full" },
      { id: "1:9", mode: "panel" },
    ]);
    expect(decide(card, OPTS)).toMatchObject({ kind: "frame", shadow: true });
    expect(decide(card.children![2]!, OPTS).kind).toBe("image");
    expect(pictureRequests(card, { ...OPTS, rasterize: "none" })).toEqual([]);
    expect(pictureRequests(card, { ...OPTS, rasterize: "all" }).map((p) => p.mode)).toEqual(["panel", "shadow", "full", "full", "panel", "panel"]);
    // A 9-slice panel keeps its drop shadow as a separate picture.
    const all = mapCard({ rasterize: "all" }).root.children[0]!;
    expect(kids(all).slice(0, 2)).toEqual(["ImageLabel", "ImageLabel"]);
    expect(prop(all.children[0], "Name")).toEqual({ t: "string", v: "Shadow" });
  });

  test("9-slice centers follow the picture's real scale and pixel size", () => {
    const { root } = mapToRoblox(card, { ...OPTS, rasterize: "all" }, (key) => ({ url: `rbxassetid://${key}`, scale: 1.5, px: { w: 600, h: 450 } }));
    const panel = root.children[0]!.children.find((c) => c.className === "ImageLabel" && (prop(c, "Name") as any).v !== "Shadow")!;
    expect(prop(panel, "SliceScale")).toEqual({ t: "float", v: 0.667 });
    const rect = prop(panel, "SliceCenter") as any;
    expect([600 - rect.x1, 450 - rect.y1]).toEqual([rect.x0, rect.y0]);
  });

  test("fit mode: fixed-size panels are stretched pictures (exact), not 9-slices", () => {
    const fixed = { ...card, sizing: { h: "FIXED", v: "FIXED" } };
    const { root } = mapToRoblox(fixed, { ...OPTS, mode: "fit", rasterize: "all" }, (key) => ({ url: `rbxassetid://${key}` }));
    const panel = root.children[0]!.children.find((c) => c.className === "ImageLabel" && (prop(c, "Name") as any).v !== "Shadow")!;
    expect(prop(panel, "ScaleType")).toEqual({ t: "enum", e: "ScaleType", v: "Stretch" });
    expect(prop(panel, "SliceCenter")).toBeUndefined();
  });

  test("scale mode: every size, position, padding, gap and radius is scale, never offset", () => {
    const { root } = mapToRoblox(card, { ...OPTS, mode: "scale" }, (key) => ({
      url: `rbxassetid://${key}`,
      ...(key.endsWith(":shadow") ? { offset: { x: -24, y: -16 }, size: { w: 448, h: 356 } } : {}),
    }));
    const offsets: string[] = [];
    const walk = (i: RbxInstance) => {
      for (const [k, v] of i.props) {
        if (v.t === "UDim2" && (v.xo !== 0 || v.yo !== 0)) offsets.push(`${i.name}.${k}`);
        if (v.t === "UDim" && v.o !== 0) offsets.push(`${i.name}.${k}`);
        if (k === "AutomaticSize") offsets.push(`${i.name}.AutomaticSize`);
      }
      i.children.forEach(walk);
    };
    walk(root);
    expect(offsets).toEqual([]);
    const title = find(root, "Title")!;
    expect(prop(title, "TextScaled")).toEqual({ t: "bool", v: true });
    // The root keeps the design's proportions on every screen.
    expect(root.children[0]!.children.some((c) => c.className === "UIAspectRatioConstraint")).toBe(true);
  });

  test("professional names: PascalCase, role last, buttons by name", () => {
    const box = (name: string, extra: Partial<RNode> = {}): RNode => ({ id: name, name, type: "FRAME", x: 0, y: 0, w: 1, h: 1, ...extra });
    const text = (name: string, characters: string): RNode =>
      box(name, { type: "TEXT", text: { characters, align: "LEFT", valign: "TOP", autoResize: "WIDTH_AND_HEIGHT", maxLines: 0, segments: [] } });
    expect(robloxName(box("Gift popup v2.2"), "Frame")).toBe("GiftPopup");
    expect(robloxName(box("Icon · search", { type: "VECTOR" }), "ImageLabel")).toBe("SearchIcon");
    expect(robloxName(box("Button / Primary"), "TextButton")).toBe("PrimaryButton");
    expect(robloxName(box("Close"), "ImageButton")).toBe("CloseButton");
    expect(robloxName(box("Frame 12", { layout: { mode: "HORIZONTAL" } as any }), "Frame")).toBe("Row");
    expect(robloxName(text("@clovis500c", "@clovis500c"), "TextLabel")).toBe("Clovis500cLabel");
    expect(robloxName(text("899", "899"), "TextLabel")).toBe("Value899Label");
    expect(robloxName(text("Title", "GIFT"), "TextLabel")).toBe("Title");
  });

  test("ScreenGui root, centered card with its shadow behind", () => {
    const { root, warnings, fontSubstitutions } = mapCard();
    expect(root.className).toBe("ScreenGui");
    expect(prop(root, "ResetOnSpawn")).toEqual({ t: "bool", v: false });
    expect(prop(root, "ZIndexBehavior")).toEqual({ t: "enum", e: "ZIndexBehavior", v: "Sibling" });
    const wrapper = root.children[0]!;
    expect(wrapper.className).toBe("Frame");
    expect(prop(wrapper, "AnchorPoint")).toEqual({ t: "Vector2", x: 0.5, y: 0.5 });
    expect(prop(wrapper, "Size")).toEqual({ t: "UDim2", xs: 0.208, xo: 0, ys: 0.278, yo: 0 });
    expect(kids(wrapper)).toEqual(["ImageLabel", "Frame", "UIAspectRatioConstraint"]);
    const [shadow, panel] = wrapper.children;
    expect(shadow!.name).toBe("Shadow");
    expect(prop(shadow, "ScaleType")).toEqual({ t: "enum", e: "ScaleType", v: "Slice" });
    expect(prop(shadow, "Position")).toEqual({ t: "UDim2", xs: 0, xo: -24, ys: 0, yo: -16 });
    expect(prop(shadow, "Size")).toEqual({ t: "UDim2", xs: 1, xo: 48, ys: 1, yo: 56 });
    expect(prop(panel, "ZIndex")).toEqual({ t: "int", v: 2 });
    expect(prop(panel, "BackgroundColor3")).toEqual({ t: "Color3", r: 1, g: 1, b: 1 });
    expect(prop(panel, "ClipsDescendants")).toEqual({ t: "bool", v: true });
    expect(prop(find(panel!, "UICorner"), "CornerRadius")).toEqual({ t: "UDim", s: 0, o: 16 });
    expect(prop(find(panel!, "UIStroke"), "ApplyStrokeMode")).toEqual({ t: "enum", e: "ApplyStrokeMode", v: "Border" });
    expect(warnings).toContain("1 hidden layer(s) skipped");
    expect(warnings).toContain("Label: letter spacing has no Roblox equivalent: ignored");
    expect(fontSubstitutions).toEqual({ Inter: "BuilderSans" });
  });

  test("auto-layout becomes UIListLayout + UIPadding, absolute children an overlay", () => {
    const panel = mapCard().root.children[0]!.children[1]!;
    const content = find(panel, "Content")!;
    expect(kids(content)).toEqual(["UIPadding", "UIListLayout", "TextLabel", "TextLabel", "ImageLabel", "Frame"]);
    const list = find(content, "UIListLayout")!;
    expect(prop(list, "FillDirection")).toEqual({ t: "enum", e: "FillDirection", v: "Vertical" });
    expect(prop(list, "Padding")).toEqual({ t: "UDim", s: 0, o: 12 });
    expect(prop(list, "SortOrder")).toEqual({ t: "enum", e: "SortOrder", v: "LayoutOrder" });
    expect(prop(find(content, "UIPadding"), "PaddingLeft")).toEqual({ t: "UDim", s: 0, o: 24 });
    // Badge sits outside the layout, pinned to the right edge with a scale position.
    const badge = panel.children.find((c) => c.name === "Badge")!;
    expect(prop(badge, "AnchorPoint")).toEqual({ t: "Vector2", x: 1, y: 0 });
    expect(prop(badge, "Position")).toEqual({ t: "UDim2", xs: 0.98, xo: 0, ys: -0.033, yo: 0 });
    expect(prop(badge, "ScaleType")).toEqual({ t: "enum", e: "ScaleType", v: "Slice" });
    expect(prop(badge, "SliceCenter")).toEqual({ t: "Rect", x0: 32, y0: 27, x1: 112, y1: 29 });
  });

  test("fill, hug, grow and space-between", () => {
    const panel = mapCard().root.children[0]!.children[1]!;
    const title = find(panel, "Title")!;
    expect(prop(title, "Size")).toEqual({ t: "UDim2", xs: 0, xo: 0, ys: 0, yo: 0 });
    expect(prop(title, "AutomaticSize")).toEqual({ t: "enum", e: "AutomaticSize", v: "XY" });
    expect(prop(title, "LayoutOrder")).toEqual({ t: "int", v: 1 });
    const price = find(panel, "PriceLabel")!;
    expect(prop(price, "Size")).toEqual({ t: "UDim2", xs: 1, xo: 0, ys: 0, yo: 0 });
    expect(prop(price, "AutomaticSize")).toEqual({ t: "enum", e: "AutomaticSize", v: "Y" });
    const actions = find(panel, "Actions")!;
    expect(prop(find(actions, "UIListLayout"), "HorizontalFlex")).toEqual({ t: "enum", e: "UIFlexAlignment", v: "SpaceBetween" });
    expect(prop(find(actions, "UIListLayout"), "VerticalAlignment")).toEqual({ t: "enum", e: "VerticalAlignment", v: "Center" });
    const buy = find(actions, "BuyButton")!;
    expect(buy.className).toBe("TextButton");
    expect(prop(buy, "AutoButtonColor")).toEqual({ t: "bool", v: false });
    expect(prop(buy, "Text")).toEqual({ t: "string", v: "" });
    expect(kids(buy)).toEqual(["UIGradient", "UICorner", "UIPadding", "UIListLayout", "TextLabel", "UIFlexItem"]);
    expect(prop(find(buy, "UICorner"), "CornerRadius")).toEqual({ t: "UDim", s: 0.5, o: 0 });
    expect(prop(find(buy, "UIFlexItem"), "FlexMode")).toEqual({ t: "enum", e: "UIFlexMode", v: "Fill" });
    expect(prop(find(buy, "UIGradient"), "Color")).toMatchObject({ t: "ColorSequence", keys: [{ time: 0 }, { time: 1 }] });
    const icon = find(actions, "Icon")!;
    expect(icon.className).toBe("ImageLabel");
    expect(prop(icon, "Image")).toEqual({ t: "Content", url: "rbxassetid://1:6:full" });
    const preview = find(panel, "Preview")!;
    expect(prop(preview, "ScaleType")).toEqual({ t: "enum", e: "ScaleType", v: "Crop" });
    expect(kids(preview)).toEqual(["UICorner", "UIAspectRatioConstraint"]);
  });

  test("text: fonts, weights, rich text, sizes", () => {
    const panel = mapCard().root.children[0]!.children[1]!;
    const title = find(panel, "Title")!;
    expect(prop(title, "FontFace")).toEqual({ t: "Font", family: "rbxasset://fonts/families/BuilderSans.json", weight: 700, weightName: "Bold", style: "Normal" });
    expect(prop(title, "TextSize")).toEqual({ t: "int", v: 24 });
    expect(prop(title, "LineHeight")).toEqual({ t: "float", v: 1.042 });
    expect(prop(title, "TextWrapped")).toBeUndefined();
    expect(prop(find(title, "UITextSizeConstraint"), "MaxTextSize")).toEqual({ t: "int", v: 24 });
    const price = find(panel, "PriceLabel")!;
    expect(prop(price, "RichText")).toEqual({ t: "bool", v: true });
    expect(prop(price, "Text")).toEqual({ t: "string", v: '<font color="#6B7280" weight="400">Only </font>250 coins' });
    expect(prop(price, "TextWrapped")).toEqual({ t: "bool", v: true });
    const label = find(panel, "Label")!;
    expect(prop(label, "FontFace")).toMatchObject({ family: "rbxasset://fonts/families/Montserrat.json", weightName: "SemiBold" });
    expect(prop(label, "TextXAlignment")).toEqual({ t: "enum", e: "TextXAlignment", v: "Center" });
    const badgeText = find(panel, "NewLabel")!;
    expect(prop(badgeText, "TextTruncate")).toEqual({ t: "enum", e: "TextTruncate", v: "AtEnd" });
    expect(prop(find(mapCard({ textScaled: true }).root, "Title"), "TextScaled")).toEqual({ t: "bool", v: true });
  });

  test("a full-screen design scales its text to the target resolution", () => {
    const screen: RNode = { id: "9:1", name: "HUD", type: "FRAME", x: 0, y: 0, w: 960, h: 540, fills: [], children: [{ ...card.children![0]!, constraints: { h: "MIN", v: "MIN" }, sizing: undefined }] };
    const { root } = mapCard({}, screen);
    const hud = root.children[0]!;
    expect(prop(hud, "Size")).toEqual({ t: "UDim2", xs: 1, xo: 0, ys: 1, yo: 0 });
    expect(prop(find(hud, "Title"), "TextSize")).toEqual({ t: "int", v: 48 });
    expect(prop(mapCard({ mode: "offset" }, screen).root.children[0]!.children.find((c) => c.name === "Title"), "TextSize")).toEqual({ t: "int", v: 24 });
  });

  test("scale vs offset geometry for constraints", () => {
    const box = (id: string, h: string, v: string): RNode => ({ id, name: id, type: "FRAME", x: 100, y: 50, w: 200, h: 100, constraints: { h, v }, fills: [{ type: "SOLID", opacity: 1, color: "#123456" }] });
    const screen: RNode = { id: "0", name: "Screen", type: "FRAME", x: 0, y: 0, w: 1000, h: 500, children: [box("max", "MAX", "MAX"), box("center", "CENTER", "CENTER"), box("stretch", "STRETCH", "MIN")] };
    const off = mapCard({ mode: "offset" }, screen).root.children[0]!;
    expect(prop(find(off, "Max"), "AnchorPoint")).toEqual({ t: "Vector2", x: 1, y: 1 });
    expect(prop(find(off, "Max"), "Position")).toEqual({ t: "UDim2", xs: 1, xo: -700, ys: 1, yo: -350 });
    expect(prop(find(off, "Center"), "Position")).toEqual({ t: "UDim2", xs: 0.5, xo: -300, ys: 0.5, yo: -150 });
    expect(prop(find(off, "Stretch"), "Size")).toEqual({ t: "UDim2", xs: 1, xo: -800, ys: 0, yo: 100 });
    expect(prop(off, "Size")).toEqual({ t: "UDim2", xs: 0, xo: 1000, ys: 0, yo: 500 });
    const scale = mapCard({ mode: "scale" }, screen).root.children[0]!;
    expect(prop(find(scale, "Max"), "Position")).toEqual({ t: "UDim2", xs: 0.3, xo: 0, ys: 0.3, yo: 0 });
    expect(prop(find(scale, "Center"), "Position")).toEqual({ t: "UDim2", xs: 0.2, xo: 0, ys: 0.2, yo: 0 });
    expect(prop(find(scale, "Stretch"), "Size")).toEqual({ t: "UDim2", xs: 0.2, xo: 0, ys: 0.2, yo: 0 });
    expect(prop(find(scale, "Max"), "ZIndex")).toEqual({ t: "int", v: 1 });
  });

  test("rasterize none approximates and says so", () => {
    const { root, warnings } = mapCard({ rasterize: "none" });
    const panel = root.children[0]!;
    expect(kids(panel)).not.toContain("ImageLabel");
    expect(find(panel, "Badge")!.className).toBe("Frame");
    expect(prop(find(panel, "Badge"), "BackgroundColor3")).toEqual({ t: "Color3", r: 0.937, g: 0.267, b: 0.267 });
    expect(warnings).toContain("Shop card: drop shadow skipped (rasterize is none)");
    expect(warnings).toContain("Badge: several fills: approximated (rasterize is none)");
    expect(warnings).toContain("Icon: vector shape skipped (rasterize is none)");
  });

  test("asRootFrame returns the frame itself", () => {
    expect(mapCard({ asRootFrame: true }).root.className).toBe("Frame");
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
    const wrapper = items(gui)[0]!;
    const size = propOf(wrapper, "Size")!;
    expect(size.tag).toBe("UDim2");
    expect(size.children.map((c) => `${c.tag}=${c.text}`)).toEqual(["XS=0.208", "XO=0", "YS=0.278", "YO=0"]);
    const panel = items(wrapper)[1]!;
    const content = items(panel).find((i) => propOf(i, "Name")!.text === "Content")!;
    const price = items(content).find((i) => propOf(i, "Name")!.text === "PriceLabel")!;
    // Rich text survives the XML escaping.
    expect(propOf(price, "Text")!.text).toBe('<font color="#6B7280" weight="400">Only </font>250 coins');
    const font = propOf(price, "FontFace")!;
    expect(font.tag).toBe("Font");
    expect(font.children.map((c) => c.tag)).toEqual(["Family", "Weight", "Style"]);
    const buy = items(items(content).find((i) => propOf(i, "Name")!.text === "Actions")!).find((i) => i.attrs.class === "TextButton")!;
    const gradient = items(buy).find((i) => i.attrs.class === "UIGradient")!;
    expect(propOf(gradient, "Color")!.text.trim().split(/\s+/)).toHaveLength(10);
    expect(propOf(items(panel)[0]!, "ScaleType")).toBeUndefined();
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
        { id: "1:1", mode: "shadow", scale: 2 },
        { id: "1:6", mode: "full", scale: 2 },
        { id: "1:9", mode: "panel", scale: 2 },
      ]);
      const r = out.result;
      expect(r.uploaded).toBe(false);
      expect(r.assets.map((a) => [a.placeholder, a.kind, a.layer])).toEqual([
        ["rbxassetid://PENDING_1", "picture", "Shop card"],
        ["rbxassetid://PENDING_2", "picture", "Icon"],
        ["rbxassetid://PENDING_3", "picture", "Badge"],
        ["rbxassetid://PENDING_4", "image", "Preview"],
      ]);
      for (const a of r.assets) expect(existsSync(a.file)).toBe(true);
      expect(existsSync(r.rbxmx) && existsSync(r.luau)).toBe(true);
      expect(readFileSync(r.luau, "utf8")).toContain('"rbxassetid://PENDING_4"');
      expect(r.warnings!.some((w) => /upload skipped: ROBLOX_API_KEY/.test(w))).toBe(true);
      expect(r.next).toMatch(/execute_luau/);
      expect(JSON.parse(readFileSync(join(r.dir, "assets.json"), "utf8"))).toHaveLength(4);
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

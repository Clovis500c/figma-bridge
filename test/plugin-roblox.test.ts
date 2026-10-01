import { describe, expect, test } from "bun:test";
import { installFigma, node, page } from "./figma-mock";

const lib = (name: string) => import(`../plugin/lib/${name}`) as Promise<any>;
const { robloxTree, robloxImages } = await lib("roblox");

const box = (x: number, y: number, width: number, height: number) => ({ absoluteBoundingBox: { x, y, width, height }, width, height });

function setup() {
  const title = node("TEXT", {
    name: "Title",
    ...box(124, 224, 120, 30),
    characters: "Hello",
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
    textAutoResize: "WIDTH_AND_HEIGHT",
    textTruncation: "DISABLED",
    layoutSizingHorizontal: "HUG",
    layoutSizingVertical: "HUG",
    getStyledTextSegments: () => [
      { characters: "Hel", fontName: { family: "Inter", style: "Bold" }, fontSize: 24, fontWeight: 700, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }], textDecoration: "NONE", textCase: "ORIGINAL", letterSpacing: { unit: "PERCENT", value: 10 }, lineHeight: { unit: "PERCENT", value: 150 } },
      { characters: "lo", fontName: { family: "Inter", style: "Regular" }, fontSize: 24, fontWeight: 400, fills: [], textDecoration: "UNDERLINE", textCase: "UPPER", letterSpacing: { unit: "PIXELS", value: 0 }, lineHeight: { unit: "AUTO" } },
    ],
  });
  const icon = node("FRAME", { name: "Icon", ...box(124, 270, 24, 24) }, [node("VECTOR", { ...box(126, 272, 20, 20) })]);
  const photo = node("RECTANGLE", { name: "Photo", ...box(124, 300, 100, 50), fills: [{ type: "IMAGE", imageHash: "h1", scaleMode: "FIT", visible: true }], cornerRadius: 6 });
  const card = node(
    "FRAME",
    {
      name: "Card",
      ...box(100, 200, 300, 200),
      absoluteRenderBounds: { x: 90, y: 196, width: 320, height: 220 },
      layoutMode: "VERTICAL",
      paddingTop: 24,
      paddingRight: 24,
      paddingBottom: 24,
      paddingLeft: 24,
      itemSpacing: 8,
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "CENTER",
      constraints: { horizontal: "CENTER", vertical: "MIN" },
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "HUG",
      fills: [{ type: "GRADIENT_LINEAR", visible: true, opacity: 1, gradientTransform: [[0, 1, 0], [-1, 0, 1]], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }] }],
      strokes: [{ type: "SOLID", visible: true, color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 1 }],
      strokeWeight: 2,
      strokeAlign: "INSIDE",
      dashPattern: [],
      topLeftRadius: 12,
      topRightRadius: 12,
      bottomRightRadius: 12,
      bottomLeftRadius: 12,
      clipsContent: true,
      opacity: 0.9,
      effects: [
        { type: "DROP_SHADOW", visible: true, offset: { x: 0, y: 4 }, radius: 10, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 } },
        { type: "LAYER_BLUR", visible: false, radius: 4 },
      ],
      reactions: [{ trigger: { type: "ON_CLICK" }, actions: [] }],
    },
    [title, icon, photo, node("FRAME", { name: "Gone", visible: false, ...box(0, 0, 1, 1) })],
  );
  const pg = page("Page", [card]);
  const { figma } = installFigma({ pages: [pg] });
  figma.base64Encode = (b: Uint8Array) => Buffer.from(b).toString("base64");
  figma.getImageByHash = (h: string) => (h === "h1" ? { getBytesAsync: async () => new Uint8Array([1, 2, 3]) } : null);
  return { figma, pg, card };
}

describe("roblox_tree", () => {
  test("layers with what the Roblox mapping needs", async () => {
    const { card } = setup();
    const r = await robloxTree({ nodeId: card.id });
    expect(r).toMatchObject({ nodes: 5, truncated: false, fileName: "Mock file", images: { h1: "AQID" } });
    const t = r.tree;
    expect(t).toMatchObject({
      name: "Card",
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      opacity: 0.9,
      clip: true,
      clickable: true,
      constraints: { h: "CENTER", v: "MIN" },
      sizing: { h: "FIXED", v: "HUG" },
      render: { x: -10, y: -4, w: 320, h: 220 },
      strokeWeight: 2,
      strokeAlign: "INSIDE",
      radius: [12, 12, 12, 12],
      layout: { mode: "VERTICAL", padding: [24, 24, 24, 24], gap: 8, primary: "MIN", counter: "CENTER" },
    });
    expect(t.fills[0]).toMatchObject({ type: "GRADIENT_LINEAR", angle: 90, stops: [{ color: "#FF0000", alpha: 1, at: 0 }, { color: "#0000FF", alpha: 0.5, at: 1 }] });
    expect(t.effects).toEqual([{ type: "DROP_SHADOW", x: 0, y: 4, blur: 10, spread: 0, color: "#000000", alpha: 0.25 }]);
    expect(t.dashed).toBeUndefined();
    const [title, icon, photo, gone] = t.children;
    expect(title).toMatchObject({ x: 24, y: 24, sizing: { h: "HUG", v: "HUG" } });
    expect(title.text).toMatchObject({ characters: "Hello", align: "LEFT", autoResize: "WIDTH_AND_HEIGHT", maxLines: 0 });
    expect(title.text.segments[0]).toEqual({ text: "Hel", family: "Inter", style: "Bold", weight: 700, size: 24, color: "#000000", alpha: 0.5, letterSpacing: 2.4, lineHeight: 36 });
    expect(title.text.segments[1]).toMatchObject({ text: "lo", decoration: "UNDERLINE", textCase: "UPPER" });
    expect(icon.vector).toBe(true);
    expect(icon.children).toBeUndefined();
    expect(photo).toMatchObject({ radius: [6, 6, 6, 6], fills: [{ type: "IMAGE", imageHash: "h1", scaleMode: "FIT" }] });
    expect(gone.hidden).toBe(true);
  });

  test("selection by default, pages refused", async () => {
    const { pg, card } = setup();
    pg.selection = [card];
    expect((await robloxTree({})).tree.name).toBe("Card");
    await expect(robloxTree({ nodeId: pg.id })).rejects.toThrow(/frame, not a page/);
  });
});

describe("roblox_images", () => {
  test("panel and shadow pictures come from a temporary copy", async () => {
    const { card } = setup();
    const copies: any[] = [];
    const exported: any[] = [];
    const exportAsync = async function (this: any, settings: any) {
      exported.push({ name: this.name, effects: this.effects, strokes: this.strokes, children: (this.children ?? []).length, settings });
      return new Uint8Array([9]);
    };
    card.exportAsync = exportAsync;
    card.clone = () => {
      const c = node("FRAME", { name: "Card copy", ...box(100, 200, 300, 200), effects: card.effects, strokes: card.strokes, exportAsync }, [node("TEXT")]);
      c.absoluteRenderBounds = { x: 90, y: 196, width: 320, height: 220 };
      copies.push(c);
      return c;
    };
    const r = await robloxImages({ items: [{ id: card.id, mode: "full", scale: 2 }, { id: card.id, mode: "panel", scale: 3 }, { id: card.id, mode: "shadow" }, { id: "9:9", mode: "full" }] });
    expect(r.images.slice(0, 3).map((i: any) => [i.mode, i.scale, i.b64])).toEqual([
      ["full", 2, "CQ=="],
      ["panel", 3, "CQ=="],
      ["shadow", 2, "CQ=="],
    ]);
    expect(r.images[2]).toMatchObject({ offset: { x: -10, y: -4 }, size: { w: 320, h: 220 } });
    expect(r.images[3]).toMatchObject({ id: "9:9", error: expect.stringContaining("Node not found") });
    expect(exported[1]).toMatchObject({ effects: [], children: 0, settings: { format: "PNG", constraint: { type: "SCALE", value: 3 } } });
    expect(exported[2].effects.map((e: any) => e.type)).toEqual(["DROP_SHADOW"]);
    expect(exported[2].strokes).toEqual([]);
    expect(copies.every((c) => c.removed)).toBe(true);
  });
});

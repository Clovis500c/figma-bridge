import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser } from "../src/web/browser";
import { convert, type Spec } from "../src/web/convert";
import { backgroundPaints, border, gradientPaint, radius, shadows } from "../src/web/css";
import type { RawNode, Snapshot } from "../src/web/dom";
import { closestStyle, FontIndex } from "../src/web/fonts";
import { importWeb } from "../src/web/import";
import { imageInfo } from "../src/image";

const FIXTURES = join(import.meta.dir, "fixtures", "web");
const fonts = new FontIndex([
  { family: "Inter", styles: ["Regular", "Medium", "Semi Bold", "Bold", "Italic", "Bold Italic"] },
  { family: "Georgia", styles: ["Regular", "Bold"] },
  { family: "Roboto Mono", styles: ["Regular"] },
]);

describe("fonts", () => {
  test("closest style by weight and slant", () => {
    const styles = ["Thin", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black", "Italic", "Bold Italic"];
    expect(closestStyle(styles, 400, false)).toBe("Regular");
    expect(closestStyle(styles, 600, false)).toBe("SemiBold");
    expect(closestStyle(styles, 650, false)).toBe("Bold");
    expect(closestStyle(styles, 700, true)).toBe("Bold Italic");
    expect(closestStyle(styles, 300, true)).toBe("Italic");
    expect(closestStyle(["Regular", "Bold"], 500, false)).toBe("Regular");
  });

  test("stacks resolve to installed families, generic ones without a warning", () => {
    expect(fonts.resolve('"Inter", sans-serif', 600, false)).toEqual({ family: "Inter", style: "Semi Bold" });
    expect(fonts.resolve('"Satoshi", "Helvetica Neue", sans-serif', 700, false)).toEqual({ family: "Inter", style: "Bold", substituted: "Satoshi" });
    expect(fonts.resolve("ui-monospace, monospace", 400, false)).toEqual({ family: "Roboto Mono", style: "Regular" });
    expect(fonts.resolve("serif", 700, false)).toEqual({ family: "Georgia", style: "Bold" });
    expect(fonts.resolve("Unknown", 400, false)).toEqual({ family: "Inter", style: "Regular", substituted: "Unknown" });
  });
});

describe("css values", () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };
  test("linear gradients: angle, keywords and stop positions", () => {
    expect(gradientPaint("linear-gradient(180deg, #EEF2FF 0%, #FFFFFF 100%)", box)).toEqual({ gradient: [{ color: "#EEF2FF", at: 0 }, { color: "#FFFFFF", at: 1 }], angle: 90 });
    expect(gradientPaint("linear-gradient(to right, #000000, #FF000080 25%, #FFFFFF)", box)).toEqual({
      gradient: [{ color: "#000000", at: 0 }, { color: "#FF000080", at: 0.25 }, { color: "#FFFFFF", at: 1 }],
      angle: 0,
    });
    expect((gradientPaint("linear-gradient(to bottom right, #000000, #FFFFFF)", { x: 0, y: 0, w: 100, h: 100 }) as any).angle).toBe(45);
    expect(gradientPaint("radial-gradient(circle at center, #000000 0%, #FFFFFF 100%)", box)).toMatchObject({ type: "radial" });
    expect(gradientPaint("conic-gradient(#000000, #FFFFFF)", box)).toBeNull();
  });

  test("backgrounds are listed bottom first", () => {
    const warnings: string[] = [];
    const paints = backgroundPaints(
      { backgroundColor: "#FF0000", backgroundImage: 'url("https://x/a.png"), linear-gradient(90deg, #000000, #FFFFFF)', backgroundSize: "cover, auto", backgroundRepeat: "no-repeat, repeat" },
      box,
      (m) => warnings.push(m),
    );
    expect(paints).toEqual(["#FF0000", { gradient: [{ color: "#000000", at: 0 }, { color: "#FFFFFF", at: 1 }], angle: 0 }, { image: "https://x/a.png", fit: "fill" }]);
    expect(warnings).toEqual([]);
  });

  test("shadows, radii and borders", () => {
    expect(shadows("#0000001A 0px 1px 3px 0px, #0000000F 0px 1px 2px -1px inset")).toEqual([
      { x: 0, y: 1, blur: 2, spread: -1, color: "#0000000F", inner: true },
      { x: 0, y: 1, blur: 3, spread: 0, color: "#0000001A" },
    ]);
    expect(radius({ borderTopLeftRadius: "50%", borderTopRightRadius: "50%", borderBottomRightRadius: "50%", borderBottomLeftRadius: "50%" }, { x: 0, y: 0, w: 40, h: 40 })).toBe(20);
    expect(radius({ borderTopLeftRadius: "8px", borderTopRightRadius: "8px", borderBottomRightRadius: "0px", borderBottomLeftRadius: "0px" }, box)).toEqual([8, 8, 0, 0]);
    const side = (w: string, style = "solid", color = "#E5E7EB") => ({ w, style, color });
    const css = (t: any, r: any, b: any, l: any) => ({
      borderTopWidth: t.w, borderRightWidth: r.w, borderBottomWidth: b.w, borderLeftWidth: l.w,
      borderTopStyle: t.style, borderRightStyle: r.style, borderBottomStyle: b.style, borderLeftStyle: l.style,
      borderTopColor: t.color, borderRightColor: r.color, borderBottomColor: b.color, borderLeftColor: l.color,
    });
    const none = side("0px", "none");
    expect(border(css(none, none, side("1px"), none), () => {})).toEqual({ stroke: "#E5E7EB", strokeWidth: [0, 0, 1, 0], strokeAlign: "inside" });
    expect(border(css(side("2px", "dashed"), side("2px", "dashed"), side("2px", "dashed"), side("2px", "dashed")), () => {})).toEqual({
      stroke: "#E5E7EB",
      strokeWidth: 2,
      strokeAlign: "inside",
      strokeDash: [6, 4],
    });
  });
});

// ─── Layout inference on hand-made snapshots ────────────────────────────────

let seq = 0;
function el(box: [number, number, number, number], css: Record<string, string>, children: RawNode[] = [], name = ""): RawNode {
  return { kind: "box", tag: "div", name: name || `n${seq++}`, box: { x: box[0], y: box[1], w: box[2], h: box[3] }, css, children };
}
function txt(box: [number, number, number, number], text: string, autoWidth = false): RawNode {
  const style = { family: "Inter", weight: 400, italic: false, size: 14, lineHeight: "20px", letterSpacing: "normal", color: "#111111", decoration: "none", transform: "none" };
  return { kind: "text", tag: "#text", name: "", box: { x: box[0], y: box[1], w: box[2], h: box[3] }, css: { textAlign: "start" }, children: [], runs: [{ text, style }], lines: 1, autoWidth };
}
const visible = { backgroundColor: "#FFFFFF" };
function run(root: RawNode, maxNodes = 500, grid = true): ReturnType<typeof convert> {
  root.tag = "body";
  const snap: Snapshot = { title: "Test", url: "https://example.com/", width: root.box.w, height: root.box.h, root, nodes: 0, truncated: false, warnings: [] };
  return convert(snap, { fonts, maxNodes, grid });
}
const child = (s: Spec, ...path: number[]) => path.reduce((n, i) => n.children[i], s);

describe("layout inference", () => {
  test("flex row with space-between keeps its CSS intent", () => {
    const header = el([0, 0, 800, 60], { ...visible, display: "flex", justifyContent: "space-between", alignItems: "center", paddingLeft: "32px", paddingRight: "32px" }, [
      el([32, 20, 100, 20], visible),
      el([668, 10, 100, 40], visible),
    ]);
    const { spec } = run(el([0, 0, 800, 60], { display: "block" }, [header]));
    expect(child(spec, 0)).toMatchObject({ layout: "row", justify: "between", align: "center", padding: [0, 32], w: "fill", h: 60 });
  });

  test("block flow: margins become gap and spacers, full-width children fill", () => {
    const page = el([0, 0, 400, 300], { ...visible, display: "block", paddingTop: "10px", paddingLeft: "20px", paddingRight: "20px" }, [
      txt([20, 10, 360, 20], "Title"),
      el([20, 38, 360, 50], visible),
      el([20, 96, 360, 50], visible),
      el([20, 186, 120, 50], visible),
    ]);
    const { spec } = run(page);
    expect(spec).toMatchObject({ layout: "column", gap: 8 });
    expect(spec.children.map((c: Spec) => c.name ?? "text")).toEqual(["text", expect.stringMatching(/^n/), expect.stringMatching(/^n/), "Spacer", expect.stringMatching(/^n/)]);
    expect(child(spec, 3)).toMatchObject({ h: 24 });
    expect(child(spec, 0).w).toBe("fill");
    expect(child(spec, 4).w).toBe(120);
  });

  test("a centered child among left-aligned ones gets an alignment wrapper", () => {
    const page = el([0, 0, 400, 200], { ...visible, display: "block" }, [el([0, 0, 100, 50], visible), el([150, 50, 100, 50], visible), el([0, 100, 100, 50], visible)]);
    const { spec } = run(page);
    expect(spec.layout).toBe("column");
    expect(child(spec, 1)).toMatchObject({ name: "Align", layout: "row", justify: "center", w: "fill" });
  });

  test("overlapping children keep free positions", () => {
    const page = el([0, 0, 400, 200], { ...visible, display: "block" }, [el([0, 0, 200, 150], visible), el([100, 100, 200, 100], visible)]);
    const r = run(page);
    expect(r.spec.layout).toBeUndefined();
    expect(child(r.spec, 1)).toMatchObject({ x: 100, y: 100, w: 200, h: 100 });
    expect(r.stats.free).toBe(1);
  });

  test("absolute children are positioned inside auto-layout", () => {
    const card = el([0, 0, 300, 100], { ...visible, display: "flex", flexDirection: "column", paddingTop: "16px", paddingLeft: "16px", paddingRight: "16px", paddingBottom: "16px" }, [
      txt([16, 16, 268, 20], "Pro"),
      el([200, -10, 60, 20], { ...visible, position: "absolute" }, [], "Badge"),
    ]);
    const { spec } = run(el([0, -20, 300, 140], { display: "block" }, [card]));
    const badge = child(spec, 0).children.find((c: Spec) => c.name === "Badge");
    expect(badge).toMatchObject({ absolute: true, x: 200, y: -10, w: 60, h: 20 });
  });

  test("positioned backgrounds stay under content that has a higher z-index", () => {
    const bg = el([0, 0, 400, 200], { ...visible, position: "absolute" }, [], "Background");
    const content = el([0, 0, 400, 200], { display: "block", position: "relative", zIndex: "1" }, [el([20, 20, 100, 40], visible, [], "Card")], "Content");
    const { spec } = run(el([0, 0, 400, 200], { display: "block" }, [bg, content]));
    const parent = find(spec, (n) => Array.isArray(n.children) && n.children.some((c: Spec) => c.name === "Background"))!;
    const names = parent.children.map((c: Spec) => c.name);
    expect(names.indexOf("Background")).toBe(0);
    // Without z-index, a positioned box paints over in-flow content.
    const top = run(el([0, 0, 400, 200], { display: "block" }, [el([0, 0, 400, 200], { ...visible, position: "absolute" }, [], "Overlay"), el([0, 0, 400, 200], visible, [], "Flow")])).spec;
    const p2 = find(top, (n) => Array.isArray(n.children) && n.children.some((c: Spec) => c.name === "Overlay"))!;
    expect(p2.children.map((c: Spec) => c.name)).toEqual(["Flow", "Overlay"]);
  });

  test("CSS grid becomes a grid with spans", () => {
    const grid = el([0, 0, 420, 220], { ...visible, display: "grid", gridTemplateColumns: "200px 200px", gridTemplateRows: "100px 100px", columnGap: "20px", rowGap: "20px" }, [
      el([0, 0, 420, 100], visible),
      el([0, 120, 200, 100], visible),
      el([220, 120, 200, 100], visible),
    ]);
    const { spec } = run(el([0, 0, 420, 220], { display: "block" }, [grid]));
    const g = child(spec, 0);
    expect(g).toMatchObject({ layout: "grid", columns: ["1fr", "1fr"], rows: [100, 100], columnGap: 20, rowGap: 20 });
    expect(child(g, 0)).toMatchObject({ colSpan: 2, w: "fill", h: "fill" });
    // Measured boxes for when Figma's grid API fails.
    expect(g.gridSize).toEqual([420, 220]);
    expect(child(g, 2).place).toEqual([220, 120, 200, 100]);
    // Default import: grid items at their measured positions.
    const free = child(run(el([0, 0, 420, 220], { display: "block" }, [JSON.parse(JSON.stringify(grid))]), 500, false).spec, 0);
    expect(free.layout).toBeUndefined();
    expect(child(free, 2)).toMatchObject({ x: 220, y: 120, w: 200, h: 100 });
  });

  test("empty wrappers collapse and names carry over", () => {
    const wrapped = el([0, 0, 200, 40], { display: "block" }, [el([0, 0, 200, 40], visible, [], "")], "Pricing");
    wrapped.children[0]!.name = "";
    const { spec } = run(el([0, 0, 200, 40], { display: "block" }, [wrapped, el([0, 40, 0, 0], { display: "block" })]));
    expect(spec.children).toHaveLength(1);
    expect(child(spec, 0).name).toBe("Pricing");
  });

  test("stops at maxNodes with a warning", () => {
    const kids = Array.from({ length: 20 }, (_, i) => el([0, i * 10, 100, 10], visible));
    const r = run(el([0, 0, 100, 200], { display: "block" }, kids), 5);
    expect(r.truncated).toBe(true);
    expect(r.warnings.join()).toContain("Stopped after 5 layers");
  });
});

// ─── Real pages in a real browser ───────────────────────────────────────────

if (!process.env.FIGMA_BRIDGE_BROWSER && existsSync("/opt/pw-browsers/chromium")) process.env.FIGMA_BRIDGE_BROWSER = "/opt/pw-browsers/chromium";
const browserAvailable = await launchBrowser().then(
  (b) => b.close().then(() => true),
  () => false,
);

const deps = {
  fonts: [{ family: "Inter", styles: ["Regular", "Medium", "Semi Bold", "Bold"] }],
  readLocal: async (src: string) => {
    const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(src);
    if (m) return new Uint8Array(m[1] ? Buffer.from(m[2]!, "base64") : Buffer.from(decodeURIComponent(m[2]!)));
    return new Uint8Array(readFileSync(src));
  },
  imageFormat: (b: Uint8Array) => imageInfo(b)?.format ?? null,
};

function find(spec: Spec, pred: (s: Spec) => boolean): Spec | undefined {
  if (pred(spec)) return spec;
  for (const c of spec.children ?? []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
}

describe.skipIf(!browserAvailable)("import_web in a browser", () => {
  test("landing page: header, hero, pricing grid, badge, links", async () => {
    const r = await importWeb({ path: join(FIXTURES, "landing.html"), viewports: [1440, 390] }, deps);
    expect(r.viewports.map((v) => v.viewport)).toEqual([1440, 390]);
    const spec = r.viewports[0]!.spec;
    expect(spec).toMatchObject({ name: "Acme · 1440", w: 1440, clip: true });
    expect(find(spec, (s) => s.name === "Site header")).toMatchObject({ layout: "row", justify: "between", align: "center" });
    expect(find(spec, (s) => s.name === "Hero")).toMatchObject({ layout: "column", align: "center", fill: { angle: 90 } });
    // CSS grid: items where the page shows them (Figma's grid API is unreliable).
    const pricing = find(spec, (s) => s.name === "Pricing")!;
    expect(pricing.layout).toBeUndefined();
    const xs = pricing.children.map((c: Spec) => c.x);
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 0);
    expect(find(spec, (s) => s.text === "Popular" || s.name === "Decoration")).toBeTruthy();
    const badge = find(spec, (s) => s.name === "Decoration")!;
    expect(badge).toMatchObject({ absolute: true, fill: "#4F46E5" });
    const link = find(spec, (s) => (s.spans ?? []).some((sp: Spec) => sp.link?.endsWith("/privacy")));
    expect(link!.spans.find((sp: Spec) => sp.link)).toMatchObject({ text: "privacy policy", decoration: "underline", color: "#FFFFFF" });
    expect(find(spec, (s) => s.type === "svg")!.svg).toContain("<path");
    expect(Object.keys(r.viewports[0]!.images)).toHaveLength(1);
    expect(r.viewports[0]!.screenshot && imageInfo(r.viewports[0]!.screenshot)?.width).toBe(1440);
    expect(r.viewports[1]!.width).toBe(390);
  }, 60_000);

  test("dashboard: wide-gamut colors, tables, a canvas pictured from the page", async () => {
    const r = await importWeb({ path: join(FIXTURES, "dashboard.html"), viewports: [1280] }, deps);
    const v = r.viewports[0]!;
    expect(v.spec.fill).toMatch(/^#[0-9A-F]{6}$/);
    expect(find(v.spec, (s) => s.name === "Badge")!.fill).toMatch(/^#[0-9A-F]{6}$/);
    expect(find(v.spec, (s) => s.name === "Sidebar")).toMatchObject({ layout: "column", fill: "#0F172A" });
    const chart = find(v.spec, (s) => s.name === "Chart")!;
    expect(chart).toMatchObject({ type: "image", w: 300, h: 80 });
    expect(imageInfo(v.images[chart.imageKey]!)).toMatchObject({ format: "png", width: 300, height: 80 });
    expect(r.warnings.join()).toContain("background image");
  }, 60_000);

  test("selector imports one element; the bundled snapshot still runs", async () => {
    // Inside the project, so the bundle resolves playwright-core from node_modules.
    const cache = join(import.meta.dir, "..", "node_modules", ".cache");
    mkdirSync(cache, { recursive: true });
    const out = mkdtempSync(join(cache, "fb-web-"));
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "src", "web", "import.ts")], target: "node", outdir: out, external: ["playwright-core"] });
    expect(built.success).toBe(true);
    const bundled = (await import(join(out, "import.js"))) as typeof import("../src/web/import");
    const r = await bundled.importWeb({ html: readFileSync(join(FIXTURES, "landing.html"), "utf8"), selector: "#pricing", viewports: [1024] }, deps);
    rmSync(out, { recursive: true, force: true });
    expect(r.viewports[0]!.spec).toMatchObject({ w: 1024 });
    expect(r.viewports[0]!.spec.children.length).toBe(3);
  }, 60_000);
});

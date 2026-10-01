import { describe, expect, test } from "bun:test";
import { generateCode, tailwind, type IrNode, type Segment } from "../src/codegen";

const seg = (text: string, o: Partial<Segment> = {}): Segment => ({ text, family: "Inter", style: (o.weight ?? 400) >= 600 ? "Semi Bold" : "Regular", weight: 400, size: 14, color: "#111111", ...o });
const card: IrNode = {
  id: "1:1", name: "Pricing Card", type: "FRAME", x: 0, y: 0, w: 320, h: 260, sizeH: "fixed", sizeV: "hug",
  css: { background: "#FFF", "border-radius": "16px", border: "1px solid #E5E7EB", "box-shadow": "0 4px 16px 0 rgba(0, 0, 0, 0.12)" },
  layout: { mode: "column", padding: [24, 24, 24, 24], gap: 12, justify: "MIN", align: "MIN" },
  children: [
    { id: "1:2", name: "Title", type: "TEXT", x: 24, y: 24, w: 80, h: 24, sizeH: "hug", sizeV: "hug", css: {}, text: { autoResize: "WIDTH_AND_HEIGHT", align: "LEFT", valign: "TOP", truncate: 0, segments: [seg("Pro plan", { size: 24, weight: 700, style: "Bold" })] } },
    { id: "1:3", name: "Body", type: "TEXT", x: 24, y: 60, w: 272, h: 40, sizeH: "fill", sizeV: "hug", css: {}, text: { autoResize: "HEIGHT", align: "LEFT", valign: "TOP", truncate: 0, segments: [seg("Everything you need. Read the "), seg("docs", { color: "#0D99FF", link: "https://figma.com", decoration: "underline" }), seg(" {now}.")] } },
    { id: "1:4", name: "Feature", type: "FRAME", x: 24, y: 110, w: 200, h: 20, sizeH: "hug", sizeV: "hug", css: {}, layout: { mode: "row", padding: [0, 0, 0, 0], gap: 8, justify: "MIN", align: "CENTER" }, children: [
      { id: "1:5", name: "icon/check", type: "FRAME", x: 0, y: 2, w: 16, h: 16, sizeH: "fixed", sizeV: "fixed", css: {}, asset: { file: "icon-check.svg", kind: "svg" } },
      { id: "1:6", name: "Label", type: "TEXT", x: 24, y: 0, w: 120, h: 20, sizeH: "hug", sizeV: "hug", css: {}, text: { autoResize: "WIDTH_AND_HEIGHT", align: "LEFT", valign: "TOP", truncate: 0, segments: [seg("Unlimited projects")] } },
    ] },
    { id: "1:7", name: "Grid", type: "FRAME", x: 24, y: 140, w: 272, h: 40, sizeH: "fill", sizeV: "hug", css: {}, layout: { mode: "grid", padding: [0, 0, 0, 0], columns: ["1fr", "1fr", "1fr"], rows: ["auto"], columnGap: 8, rowGap: 8 }, children: [
      { id: "1:8", name: "Cell", type: "RECTANGLE", x: 0, y: 0, w: 180, h: 40, sizeH: "fill", sizeV: "fixed", colSpan: 2, css: { background: "#F3F4F6", "border-radius": "8px" } },
      { id: "1:9", name: "Photo", type: "RECTANGLE", x: 188, y: 0, w: 84, h: 40, sizeH: "fill", sizeV: "fixed", css: { "border-radius": "8px" }, asset: { file: "photo.img", kind: "image", fit: "cover" } },
    ] },
    { id: "1:10", name: "Button", type: "FRAME", x: 24, y: 200, w: 272, h: 40, sizeH: "fill", sizeV: "hug", css: { background: "var(--color-primary, #0D99FF)", "border-radius": "8px" }, layout: { mode: "row", padding: [10, 16, 10, 16], gap: 0, justify: "CENTER", align: "CENTER" }, children: [
      { id: "1:11", name: "Label", type: "TEXT", x: 0, y: 0, w: 60, h: 20, sizeH: "hug", sizeV: "hug", css: {}, text: { autoResize: "WIDTH_AND_HEIGHT", align: "LEFT", valign: "TOP", truncate: 0, segments: [seg("Upgrade", { color: "#FFFFFF", weight: 600 })] } },
    ] },
  ],
};

const assetPath = (f: string) => `assets/${f.replace(/\.img$/, ".png")}`;
const gen = (framework: "html" | "react", styling: "css" | "tailwind") => generateCode(card, { framework, styling, assetPath });

describe("HTML + CSS", () => {
  const { files, fonts } = gen("html", "css");
  const html = files[0]!.content;

  test("one standalone page", () => {
    expect(files.map((f) => f.path)).toEqual(["index.html"]);
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain('family=Inter:wght@400;600;700');
    expect(fonts).toEqual(["Inter"]);
  });

  test("auto-layout becomes flexbox and grid", () => {
    expect(html).toMatch(/\.pricing-card \{[^}]*width: 320px;[^}]*display: flex;[^}]*flex-direction: column;[^}]*gap: 12px;[^}]*align-items: flex-start;[^}]*padding: 24px;/);
    expect(html).toMatch(/\.grid \{[^}]*display: grid;[^}]*grid-template-columns: 1fr 1fr 1fr;[^}]*column-gap: 8px;/);
    expect(html).toMatch(/\.cell \{[^}]*grid-column: span 2 \/ span 2;/);
  });

  test("fill and hug sizing", () => {
    expect(html).toMatch(/\.body \{\s*align-self: stretch;/);
    expect(html).toMatch(/\.title \{\s*white-space: nowrap;/);
    expect(html).toMatch(/\.icon-check \{\s*width: 16px;\s*flex-shrink: 0;\s*height: 16px;/);
  });

  test("semantic tags, links and assets", () => {
    expect(html).toContain('<h2 class="title">Pro plan</h2>');
    expect(html).toContain('<a class="body-link" href="https://figma.com">docs</a>');
    expect(html).toContain('<button class="button" type="button"><span class="label-2">Upgrade</span></button>');
    expect(html).toContain('<img class="icon-check" src="assets/icon-check.svg" alt="" />');
    expect(html).toContain('<img class="photo" src="assets/photo.png" alt="Photo" />');
  });

  test("Figma CSS is kept, variables included", () => {
    expect(html).toContain("box-shadow: 0 4px 16px 0 rgba(0, 0, 0, 0.12);");
    expect(html).toContain("background: var(--color-primary, #0D99FF);");
  });
});

describe("React", () => {
  test("CSS: a component and its stylesheet, images imported", () => {
    const { files } = gen("react", "css");
    expect(files.map((f) => f.path)).toEqual(["PricingCard.jsx", "PricingCard.css"]);
    const jsx = files[0]!.content;
    expect(jsx).toContain('import "./PricingCard.css";');
    expect(jsx).toContain('import imgPhoto from "./assets/photo.png";');
    expect(jsx).toContain("export default function PricingCard()");
    expect(jsx).toContain('<img className="photo" src={imgPhoto} alt="Photo" />');
    expect(jsx).toContain('{"{"}now{"}"}');
    expect(jsx).not.toContain(' class="');
  });

  test("Tailwind: utility classes, no stylesheet", () => {
    const { files } = gen("react", "tailwind");
    expect(files.map((f) => f.path)).toEqual(["PricingCard.jsx"]);
    const jsx = files[0]!.content;
    expect(jsx).toContain('className="w-80 flex flex-col gap-3 items-start p-6 bg-[#FFF] rounded-2xl border border-[#E5E7EB] shadow-[0_4px_16px_0_rgba(0,_0,_0,_0.12)]"');
    expect(jsx).toContain("grid-cols-[1fr_1fr_1fr]");
    expect(jsx).toContain("col-span-2");
    expect(jsx).toContain("px-4 py-2.5");
  });
});

describe("tailwind()", () => {
  test("scale values when they match, arbitrary values otherwise", () => {
    expect(tailwind({ gap: "12px", width: "13px", "font-size": "14px", "font-weight": "600", "border-radius": "9999px" })).toEqual([
      "gap-3",
      "w-[13px]",
      "text-sm",
      "font-semibold",
      "rounded-full",
    ]);
    expect(tailwind({ padding: "8px 16px 4px 2px" })).toEqual(["pt-2", "pr-4", "pb-1", "pl-0.5"]);
    expect(tailwind({ left: "-10px", top: "1px" })).toEqual(["-left-[10px]", "top-px"]);
    expect(tailwind({ "font-family": "'Open Sans', sans-serif" })).toEqual(["font-['Open_Sans']"]);
    expect(tailwind({ border: "2px dashed #E5E7EB", opacity: "0.37" })).toEqual(["border-[2px]", "border-dashed", "border-[#E5E7EB]", "opacity-[0.37]"]);
    expect(tailwind({ "mix-blend-mode": "multiply" })).toEqual(["[mix-blend-mode:multiply]"]);
  });
});

test("absolute children inside a free-form frame", () => {
  const tree: IrNode = {
    id: "1", name: "Canvas", type: "FRAME", x: 0, y: 0, w: 200, h: 100, sizeH: "fixed", sizeV: "fixed", css: {},
    children: [{ id: "2", name: "Dot", type: "RECTANGLE", x: 10, y: 20, w: 8, h: 8, sizeH: "fixed", sizeV: "fixed", css: { background: "#F00" } }],
  };
  const html = generateCode(tree, { framework: "html", styling: "css", assetPath: (f) => f }).files[0]!.content;
  expect(html).toMatch(/\.canvas \{\s*width: 200px;\s*height: 100px;\s*position: relative;/);
  expect(html).toMatch(/\.dot \{\s*position: absolute;\s*left: 10px;\s*top: 20px;\s*width: 8px;\s*height: 8px;/);
});

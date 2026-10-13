import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lintSpec } from "../src/spec-lint";

describe("lintSpec", () => {
  test("converts CSS habits in place and says so", () => {
    const spec: any = {
      name: "Card",
      layout: "column",
      backgroundColor: "rgb(255, 255, 255)",
      borderRadius: "16px",
      padding: ["24px", 16],
      justifyContent: "space-between",
      alignItems: "flex-start",
      w: "100%",
      children: [{ content: "Pro plan", fontSize: 20, fontWeight: 600, textAlign: "start", color: "white", textTransform: "uppercase" }],
    };
    const { warnings } = lintSpec(spec);
    expect(spec).toEqual({
      name: "Card",
      layout: "column",
      fill: "#FFFFFF",
      radius: 16,
      padding: [24, 16],
      justify: "between",
      align: "start",
      w: "fill",
      children: [{ text: "Pro plan", size: 20, weight: 600, align: "left", color: "#FFFFFF", case: "upper" }],
    });
    expect(warnings).toContain('spec: "borderRadius": read as radius (not a build property)');
    expect(warnings).toContain('spec: justify: "space-between" read as "between"');
    expect(warnings).toContain('spec.children[0]: "fontSize": read as size (not a build property)');
  });

  test("reports unknown properties with the closest name, without touching them", () => {
    const spec: any = { layout: "row", paddng: 8, heigth: 40, wobble: true, children: [] };
    const { warnings } = lintSpec(spec);
    expect(warnings).toEqual(['spec: unknown property "paddng" ignored: did you mean padding?', 'spec: unknown property "heigth" ignored: did you mean height?', 'spec: unknown property "wobble" ignored']);
    expect(spec.paddng).toBe(8);
  });

  test("catches what the plugin would silently ignore", () => {
    const { warnings } = lintSpec({
      name: "Box",
      padding: 16,
      gap: 8,
      color: "#111111",
      children: [{ text: "Hi", children: [{ text: "nested" }] }, { w: "320" }, { justify: "space-around", layout: "row" }, { align: "stretch", layout: "column" }],
    });
    expect(warnings).toEqual([
      'spec: padding, gap need layout:"row"|"column"|"grid" on the same frame; ignored without it',
      "spec: color only applies to text and icons: use fill for a frame background",
      "spec.children[0]: a text can't have children: they are ignored (wrap them in a frame)",
      'spec.children[1]: w: "320" read as 320 (numbers are px, without units)',
      'spec.children[2]: justify: "space-around" not supported: use "between" or gap, ignored',
      'spec.children[3]: align: "stretch" not an align value: give the children w:"fill" (column) or h:"fill" (row), ignored',
    ]);
  });

  test("checks paints, shadows and spans", () => {
    const spec: any = {
      text: "",
      spans: [{ text: "Docs", fontWeight: 600, href: "https://x.dev", color: "rgba(0,0,0,0.5)" }],
      shadow: { y: "4px", blur: 12, offset: 2, color: "black" },
      stroke: { gradient: ["#000", "teal"], angel: 45 },
    };
    const { warnings } = lintSpec(spec);
    expect(spec.spans[0]).toEqual({ text: "Docs", weight: 600, link: "https://x.dev", color: "#00000080" });
    expect(spec.shadow).toEqual({ y: 4, blur: 12, offset: 2, color: "#000000" });
    expect(warnings).toContain('spec: shadow: unknown property "offset" (x, y, blur, spread, color, inner)');
    expect(warnings).toContain('spec: stroke: unknown paint property "angel" (paints: "#hex", {gradient:[…], angle, type:"radial"}, {image, fit})');
    expect(warnings).toContain('spec: stroke: "teal" is not a color: use "#RRGGBB[AA]", "style:Name" or "var:name"');
  });

  test("one line per issue, however many layers share it", () => {
    const spec = { layout: "column", children: Array.from({ length: 12 }, () => ({ layout: "row", borderRadius: 8 })) };
    expect(lintSpec(spec).warnings).toEqual(['spec.children[0]: "borderRadius": read as radius (not a build property) (12 layers)']);
  });

  test("FigJam, Slides, variants and diagrams keep their own vocabulary", () => {
    expect(
      lintSpec({
        type: "section",
        padding: 40,
        children: [
          { type: "sticky", text: "Idea", color: "yellow", wide: true, key: "a" },
          { type: "connector", from: "a", to: "b", label: "yes", line: "elbowed", endArrow: "arrow" },
          { type: "table", rows: [["A", "B"]], header: true, headerFill: "#EEEEEE" },
          { type: "diagram", source: "flowchart LR\n A --> B", as: "stickies", color: "blue" },
        ],
      }).warnings,
    ).toEqual([]);
    expect(lintSpec({ slides: [{ name: "Intro", fill: "#000000", children: [{ text: "Hi", size: 64, color: "#FFFFFF" }] }] }).warnings).toEqual([]);
    expect(
      lintSpec({
        type: "componentSet",
        name: "Button",
        base: { layout: "row", padding: [8, 16], radius: 8 },
        variants: [{ props: { Variant: "Primary" }, fill: "#0D99FF", padding: 12, children: [{ text: "Buy", bind: "Label" }] }],
        properties: { Label: "Button" },
      }).warnings,
    ).toEqual([]);
  });

  test("the bundled examples are clean", () => {
    const dir = join(import.meta.dir, "..", "examples");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes("tokens"))) {
      const example = JSON.parse(readFileSync(join(dir, f), "utf8"));
      expect({ file: f, warnings: lintSpec(example.spec ?? example).warnings }).toEqual({ file: f, warnings: [] });
    }
  });
});

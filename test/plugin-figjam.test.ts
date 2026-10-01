import { describe, expect, test } from "bun:test";
import { diagramSpec, layoutDiagram, parseDiagram } from "../src/diagram";
import { installFigma, type MockNode, page } from "./figma-mock";

const lib = (name: string) => import(`../plugin/lib/${name}`) as Promise<any>;
const { build } = await lib("build");

function setup(editorType: string) {
  const pg = page("Board", []);
  installFigma({ pages: [pg], editorType });
  return pg;
}
const all = (n: MockNode): MockNode[] => [n, ...(n.children ?? []).flatMap(all)];

describe("FigJam build", () => {
  test("stickies, shapes, tables, code blocks and connectors inside a section", async () => {
    const pg = setup("figjam");
    const r = await build({
      spec: {
        type: "section",
        name: "Retro",
        children: [
          { type: "sticky", text: "Went well", color: "green", key: "a", x: 40, y: 40 },
          { type: "shape", shape: "diamond", text: "Ship?", key: "b", x: 400, y: 40, w: 200, h: 120, fill: "#FFFFFF", stroke: "#111111" },
          { type: "table", name: "Owners", rows: [["Task", "Owner"], ["Docs", "Ada"]], x: 40, y: 400 },
          { type: "codeBlock", code: "npm test", language: "sh", x: 400, y: 400 },
          { type: "connector", from: "a", to: "b", label: "then", line: "curved", dashed: true },
          { type: "connector", from: "a", to: "nowhere" },
        ],
      },
    });
    const nodes = all(pg);
    const sticky = nodes.find((n) => n.type === "STICKY")!;
    const shape = nodes.find((n) => n.type === "SHAPE_WITH_TEXT")!;
    const connector = nodes.find((n) => n.type === "CONNECTOR")!;
    const section = nodes.find((n) => n.type === "SECTION")!;
    expect(sticky.text.characters).toBe("Went well");
    expect(sticky.fills[0].color.g).toBeCloseTo(0xef / 255, 2);
    expect(shape).toMatchObject({ shapeType: "DIAMOND", width: 200, height: 120 });
    expect(shape.text.characters).toBe("Ship?");
    expect(connector.connectorStart).toEqual({ endpointNodeId: sticky.id, magnet: "AUTO" });
    expect(connector.connectorEnd).toEqual({ endpointNodeId: shape.id, magnet: "AUTO" });
    expect(connector).toMatchObject({ connectorLineType: "CURVED", connectorEndStrokeCap: "ARROW_LINES", dashPattern: [8, 6] });
    expect(connector.text.characters).toBe("then");
    expect(connector.parent).toBe(section);
    const table = nodes.find((n) => n.type === "TABLE")!;
    expect(table.cellAt(1, 1).text.characters).toBe("Ada");
    expect(table.cellAt(0, 0).fills).toHaveLength(1);
    expect(nodes.find((n) => n.type === "CODE_BLOCK")).toMatchObject({ code: "npm test", codeLanguage: "BASH" });
    // The section wraps its children with a 40 px margin.
    expect(section.width).toBe(400 + 200 + 40);
    expect(r.warnings.join()).toContain('connector ends not found (from "a", to "nowhere")');
  });

  test("a diagram expands to shapes and connectors that build lays out", async () => {
    const pg = setup("figjam");
    const spec = diagramSpec({ type: "diagram", source: "flowchart TD\n A[Start] --> B{Valid?}\n B -->|yes| C(Done)\n B -.->|no| A", name: "Signup" });
    const r = await build({ spec });
    const nodes = all(pg);
    expect(nodes.filter((n) => n.type === "SHAPE_WITH_TEXT").map((n) => n.text.characters)).toEqual(["Start", "Valid?", "Done"]);
    expect(nodes.filter((n) => n.type === "CONNECTOR")).toHaveLength(3);
    expect(nodes.find((n) => n.type === "SHAPE_WITH_TEXT" && n.text.characters === "Valid?")!.shapeType).toBe("DIAMOND");
    expect(r.warnings).toBeUndefined();
  });

  test("FigJam types are refused in a Figma Design file", async () => {
    setup("figma");
    await expect(build({ spec: { type: "sticky", text: "x" } })).rejects.toMatchObject({ code: "WRONG_EDITOR" });
    await expect(build({ spec: { name: "Frame", children: [{ type: "connector", from: "a", to: "b" }] } })).rejects.toMatchObject({ code: "WRONG_EDITOR" });
  });
});

describe("Slides build", () => {
  test("{slides:[…]} creates one slide per entry with its content", async () => {
    const pg = setup("slides");
    const r = await build({ spec: { slides: [{ name: "Intro", children: [{ text: "Hello", size: 96, x: 120, y: 120 }] }, { name: "Plan", fill: "#111111" }] } });
    const slides = (pg.children ?? []).filter((n) => n.type === "SLIDE");
    expect(slides.map((s) => s.name)).toEqual(["Intro", "Plan"]);
    expect(slides[0]!.children![0]).toMatchObject({ type: "TEXT", characters: "Hello", x: 120, y: 120 });
    expect(slides[1]!.fills[0].color.r).toBeCloseTo(0x11 / 255, 2);
    expect(slides[0]!.width).toBe(1920);
    expect(r.rootIds).toHaveLength(2);
    setup("figjam");
    await expect(build({ spec: { type: "slide" } })).rejects.toMatchObject({ code: "WRONG_EDITOR" });
  });
});

describe("diagram parsing and layout", () => {
  test("Mermaid shapes, edge kinds, labels, chains, & and subgraphs", () => {
    const d = parseDiagram(`graph LR
      A([Begin]) --> B[[Load]] --> C[(DB)]
      B -- retry --> A
      C ==> D{{Done}} & E((End))
      subgraph Ops [Operations]
        D
      end
      %% comment`);
    expect(d.direction).toBe("LR");
    expect(d.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([
      ["A", "rounded", "Begin"],
      ["B", "process", "Load"],
      ["C", "database", "DB"],
      ["D", "hexagon", "Done"],
      ["E", "ellipse", "End"],
    ]);
    expect(d.edges.map((e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ""}${e.thick ? "!" : ""}`)).toEqual(["A>B", "B>C", "B>A:retry", "C>D!", "C>E!"]);
    expect(d.subgraphs).toEqual([{ id: "Ops", label: "Operations", nodes: ["D"] }]);
  });

  test("layers follow the edges, cycles don't loop, nodes never overlap", () => {
    const d = parseDiagram("flowchart TB\n A --> B\n A --> C\n B --> D\n C --> D\n D --> A");
    const { positions } = layoutDiagram(d);
    const y = (id: string) => positions.get(id)!.y;
    expect(y("A")).toBeLessThan(y("B"));
    expect(y("B")).toBe(y("C"));
    expect(y("D")).toBeGreaterThan(y("B"));
    const boxes = [...positions.values()];
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  });

  test("subgraphs become nested sections; stickies variant", () => {
    const spec = diagramSpec({ type: "diagram", source: "flowchart LR\n subgraph G [Group]\n A --> B\n end\n B --> C", as: "stickies", key: "d1" });
    expect(spec.type).toBe("section");
    const group = spec.children.find((c: any) => c.type === "section");
    expect(group).toMatchObject({ name: "Group" });
    expect(group.children.map((c: any) => c.type)).toEqual(["sticky", "sticky"]);
    expect(spec.children.filter((c: any) => c.type === "connector").map((c: any) => [c.from, c.to])).toEqual([["d1:A", "d1:B"], ["d1:B", "d1:C"]]);
    expect(() => diagramSpec({ source: "" })).toThrow(/no nodes/);
  });
});

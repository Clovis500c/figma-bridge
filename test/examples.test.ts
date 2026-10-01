// The files in examples/ are documentation: they must keep working.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diagramSpec } from "../src/diagram";
import { normalizeTokens } from "../src/tokens";
import { installFigma, type MockNode, page } from "./figma-mock";

const DIR = join(import.meta.dir, "..", "examples");
const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const { build } = (await import(`../plugin/lib/${"build"}`)) as any;

/** Icons are fetched by the server; here they become a plain SVG of the right size. */
function stubIcons(n: any) {
  if (!n || typeof n !== "object") return;
  if (n.icon) n.svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n.size ?? 24}" height="${n.size ?? 24}"></svg>`;
  for (const c of n.children ?? []) stubIcons(c);
}
const count = (n: MockNode): number => 1 + (n.children ?? []).reduce((a, c) => a + count(c), 0);

describe("examples", () => {
  test("every example is listed in examples/README.md", () => {
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    for (const f of readdirSync(DIR).filter((f) => f.endsWith(".json"))) expect(readme).toContain(`\`${f}\``);
  });

  for (const file of ["pricing-section.json", "dashboard.json", "mobile-login.json"]) {
    test(`${file} builds without warnings`, async () => {
      const pg = page("Page", []);
      installFigma({ pages: [pg] });
      const spec = load(file);
      stubIcons(spec);
      const r = await build({ spec });
      expect(r.warnings).toBeUndefined();
      expect(r.created).toBeGreaterThan(15);
      expect(count(pg.children![0]!)).toBe(r.created);
    });
  }

  test("checkout-flow.json becomes a FigJam diagram", async () => {
    const pg = page("Board", []);
    installFigma({ pages: [pg], editorType: "figjam" });
    const r = await build({ spec: diagramSpec(load("checkout-flow.json")) });
    expect(r.warnings).toBeUndefined();
    expect(r.created).toBeGreaterThan(15);
  });

  test("tailwind-tokens.json gives variables and text styles", () => {
    const set = normalizeTokens(load("tailwind-tokens.json"));
    expect(set.warnings).toEqual([]);
    const names = set.collections[0]!.variables.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(["color/indigo/600", "spacing/4", "radius/full", "font-size/3xl"]));
    expect(set.styles.text.map((t) => t.name)).toEqual(["text/sm", "text/base", "text/xl", "text/3xl"]);
  });
});

test("grid tracks from the pricing example reach the frame", async () => {
  const pg = page("Page", []);
  installFigma({ pages: [pg] });
  const spec = load("pricing-section.json");
  stubIcons(spec);
  await build({ spec });
  const grid = pg.children![0]!.children!.find((c) => c.name === "Plans")!;
  expect(grid.layoutMode).toBe("GRID");
  expect(grid.gridColumnCount).toBe(3);
  expect(grid.gridColumnSizes.map((t: any) => t.type)).toEqual(["FLEX", "FLEX", "FLEX"]);
});

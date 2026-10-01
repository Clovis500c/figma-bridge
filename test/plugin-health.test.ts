import { beforeEach, describe, expect, test } from "bun:test";
import { hex, installFigma, type MockNode, node, page, solid } from "./figma-mock";

// Plugin modules are loaded at run time: they are typed against the Figma typings, not Bun's.
const lib = (name: string) => import(`../plugin/lib/${name}`) as Promise<any>;
const { audit } = await lib("audit");
const { deltaE, invalidateCaches } = await lib("util");

const C = "c1";
const M = "m1";
const colorVar = (id: string, name: string, h: string, scopes = ["ALL_SCOPES"]) => ({ id, name, resolvedType: "COLOR" as const, valuesByMode: { [M]: hex(h, 1) }, variableCollectionId: C, scopes });
const numberVar = (id: string, name: string, n: number, scopes = ["ALL_SCOPES"]) => ({ id, name, resolvedType: "FLOAT" as const, valuesByMode: { [M]: n }, variableCollectionId: C, scopes });
const h1 = { id: "S:h1", name: "Heading/H1", fontName: { family: "Inter", style: "Bold" }, fontSize: 32, lineHeight: { unit: "PIXELS", value: 40 }, letterSpacing: { unit: "PERCENT", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE" };

let scene: Record<string, MockNode>;
function setup() {
  invalidateCaches();
  const title = node("TEXT", { name: "Pro plan", characters: "Pro plan", fontName: { family: "Inter", style: "Bold" }, fontSize: 32, lineHeight: { unit: "PIXELS", value: 40 }, fills: [solid("#111111")] });
  const faint = node("TEXT", { name: "Fine print", characters: "Fine print", fills: [solid("#DDDDDD")] });
  const styled = node("TEXT", { name: "Styled", characters: "Styled", fills: [solid("#111111")], textStyleId: "S:h1" });
  const card = node("FRAME", { name: "Frame 12", layoutMode: "VERTICAL", itemSpacing: 16, paddingTop: 24, paddingBottom: 24, topLeftRadius: 8, topRightRadius: 8, bottomRightRadius: 8, bottomLeftRadius: 8, fills: [solid("#0E99FE")], strokes: [solid("#E5E7EB")] }, [title, faint, styled]);
  const ghost = node("FRAME", { name: "Size=M, State=Hover", fills: [solid("#123456", 0.5)] });
  const button = node("COMPONENT", { name: "Button", fills: [solid("#0D99FF")] });
  const pg = page("Page 1", [card, ghost, button]);
  installFigma({
    pages: [pg],
    collections: [{ id: C, name: "Theme", modes: [{ modeId: M, name: "Light" }], defaultModeId: M }],
    variables: [colorVar("v1", "color/primary", "#0D99FF"), colorVar("v2", "color/text", "#111111", ["TEXT_FILL"]), colorVar("v3", "color/border", "#E5E7EB", ["STROKE_COLOR"]), numberVar("v4", "space/md", 16, ["GAP"]), numberVar("v5", "radius/sm", 8, ["CORNER_RADIUS"]), numberVar("v6", "opacity/half", 16, ["OPACITY"]), colorVar("v7", "color/unused", "#FF00FF")],
    paintStyles: [
      { id: "S:a", name: "Brand/A", paints: [solid("#0D99FF")] },
      { id: "S:b", name: "Brand/B", paints: [solid("#0D99FF")] },
    ],
    textStyles: [h1],
  });
  scene = { card, title, faint, styled, ghost, button };
}

beforeEach(setup);

test("deltaE (CIEDE2000) matches reference values", () => {
  // Sharma et al. test pairs, converted: identical colors, a just-noticeable step, a large difference.
  expect(deltaE(hex("#0D99FF"), hex("#0D99FF"))).toBe(0);
  expect(deltaE(hex("#0D99FF"), hex("#0E99FE"))).toBeLessThan(1);
  expect(deltaE(hex("#000000"), hex("#FFFFFF"))).toBeCloseTo(100, 0);
  expect(deltaE(hex("#FF0000"), hex("#00FF00"))).toBeGreaterThan(50);
});

describe("audit scope design-system", () => {
  test("scores every category and lists concrete issues", async () => {
    const r = await audit({ scope: "design-system" });
    expect(r.scope).toBe("the whole file");
    expect(Object.keys(r.categories).sort()).toEqual(["components", "contrast", "naming", "styles", "tokens", "typography"]);
    expect(r.categories.tokens.colors).toEqual({ bound: 0, total: 7 });
    expect(r.categories.tokens.numbers).toEqual({ bound: 0, total: 7 });
    expect(r.categories.typography).toMatchObject({ styled: 1, total: 3, score: 33 });
    expect(r.categories.contrast).toMatchObject({ passing: 2, total: 3 });
    expect(r.categories.components).toMatchObject({ detachedSuspects: 1, unused: 1 });
    expect(r.categories.naming.defaultLayerNames).toBe(1);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
    const messages = r.issues.map((i: any) => i.message).join("\n");
    expect(messages).toContain('Color style "Brand/B" duplicates "Brand/A"');
    expect(messages).toContain('Style "Brand/A" is not used');
    expect(messages).toContain('Variable "color/unused" is not used');
    expect(messages).toContain("probably a detached instance");
    expect(r.issues.some((i: any) => i.nodeId === scene.ghost!.id && i.category === "components")).toBe(true);
    expect(messages).toContain("Contrast");
  });
});

describe("audit fix", () => {
  test("binds colors and numbers to matching variables, applies text styles, renames layers", async () => {
    const r = await audit({ fix: true, nodeId: scene.card!.id });
    const { card, title, faint } = scene;
    // #0E99FE is within ΔE 2 of color/primary (#0D99FF).
    expect(card!.fills[0].boundVariables.color.id).toBe("v1");
    expect(card!.strokes[0].boundVariables.color.id).toBe("v3");
    expect(title!.fills[0].boundVariables.color.id).toBe("v2");
    expect(faint!.fills[0].boundVariables).toBeUndefined();
    expect(card!.boundVariables.itemSpacing.id).toBe("v4");
    expect(card!.boundVariables.topLeftRadius.id).toBe("v5");
    expect(card!.boundVariables.paddingTop).toBeUndefined(); // 24: no matching variable
    expect(title!.textStyleId).toBe("S:h1");
    expect(card!.name).toBe("Pro plan");
    expect(r.fixed).toEqual({ colors: 4, numbers: 5, textStyles: 1, names: 1 });
    expect(r.changes.find((c: any) => c.fix === "names")).toMatchObject({ from: "Frame 12", to: "Pro plan" });
    // The report after fixing is part of the result.
    expect(r.summary).toBeDefined();
  });

  test("fixes limits what is changed; opacity mismatches are never bound", async () => {
    const r = await audit({ fixes: ["names"] });
    expect(r.fixed).toEqual({ colors: 0, numbers: 0, textStyles: 0, names: 1 });
    expect(scene.card!.fills[0].boundVariables).toBeUndefined();
    await audit({ fixes: ["colors"], nodeId: scene.ghost!.id });
    expect(scene.ghost!.fills[0].boundVariables).toBeUndefined();
    await expect(audit({ fixes: ["everything"] })).rejects.toThrow(/Unknown fix/);
  });
});

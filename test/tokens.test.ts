import { describe, expect, test } from "bun:test";
import { cssColor, detectFormat, dimension, normalizeTokens } from "../src/tokens";

describe("cssColor", () => {
  test("hex, rgb(), hsl() and keywords", () => {
    expect(cssColor("#abc")).toBe("#AABBCC");
    expect(cssColor("#0d99ffcc")).toBe("#0D99FFCC");
    expect(cssColor("#0d99ffff")).toBe("#0D99FF");
    expect(cssColor("rgb(255 0 0 / 50%)")).toBe("#FF000080");
    expect(cssColor("rgba(0, 0, 0, 0.25)")).toBe("#00000040");
    expect(cssColor("hsl(210, 100%, 50%)")).toBe("#0080FF");
    expect(cssColor("transparent")).toBe("#00000000");
    expect(cssColor("currentColor")).toBeNull();
  });
});

test("dimension", () => {
  expect(dimension("16px")).toBe(16);
  expect(dimension("1.5rem")).toBe(24);
  expect(dimension({ value: 2, unit: "rem" })).toBe(32);
  expect(dimension(8)).toBe(8);
  expect(dimension("auto")).toBeNull();
});

describe("simple format", () => {
  const set = normalizeTokens({
    collections: [
      {
        name: "Theme",
        modes: ["Light", "Dark"],
        variables: {
          "color/primary": { Light: "#0D99FF", Dark: "#2AA5FF" },
          "space/md": 16,
          "color/link": "{color/primary}",
          "flag/beta": true,
          "font/body": { type: "string", value: "Inter", description: "Body font" },
          "color.with.dots": "rgb(0 0 0)",
        },
      },
    ],
    styles: { colors: { "Brand/Primary": "var:color/primary", Accent: "hsl(0, 100%, 50%)" }, text: { H1: { font: "Inter", weight: 700, size: 32 } }, effects: { Card: { y: 4, blur: 16 } } },
  });

  test("variables keep modes, types and aliases", () => {
    const [c] = set.collections;
    expect(c!.modes).toEqual(["Light", "Dark"]);
    const byName = Object.fromEntries(c!.variables.map((v) => [v.name, v]));
    expect(byName["color/primary"]).toEqual({ name: "color/primary", type: "color", values: { Light: "#0D99FF", Dark: "#2AA5FF" }, description: undefined, scopes: undefined });
    expect(byName["space/md"]!.values).toEqual({ "*": 16 });
    expect(byName["color/link"]).toMatchObject({ type: undefined, values: { "*": { alias: "color/primary" } } });
    expect(byName["flag/beta"]!.type).toBe("boolean");
    expect(byName["font/body"]).toMatchObject({ type: "string", values: { "*": "Inter" }, description: "Body font" });
    expect(byName["color_with_dots"]!.values).toEqual({ "*": "#000000" });
  });

  test("styles are lists of named entries", () => {
    expect(set.styles.colors).toEqual([
      { name: "Brand/Primary", value: "var:color/primary" },
      { name: "Accent", value: "#FF0000" },
    ]);
    expect(set.styles.text[0]).toMatchObject({ name: "H1", weight: 700 });
    expect(set.styles.effects[0]).toMatchObject({ name: "Card", y: 4 });
  });

  test("modes found in values are added to the collection", () => {
    const s = normalizeTokens({ collections: [{ name: "C", variables: { a: { Light: 1, Dim: 2 } } }] });
    expect(s.collections[0]!.modes).toEqual(["Light", "Dim"]);
  });
});

describe("W3C design tokens", () => {
  const tokens = {
    color: {
      $type: "color",
      blue: { 500: { $value: "#3B82F6", $extensions: { modes: { Dark: "#60A5FA" } } } },
      primary: { $value: "{color.blue.500}", $description: "Brand" },
      srgb: { $value: { colorSpace: "srgb", components: [1, 0, 0], alpha: 0.5 } },
    },
    space: { $type: "dimension", md: { $value: "1rem" } },
    type: { h1: { $type: "typography", $value: { fontFamily: ["Inter", "sans-serif"], fontWeight: 700, fontSize: "{space.md}", lineHeight: 1.2 } } },
    shadow: { card: { $type: "shadow", $value: [{ offsetX: "0px", offsetY: "4px", blur: "8px", spread: "0px", color: "#00000033" }] } },
    motion: { $type: "transition", fast: { $value: { duration: "100ms" } } },
  };

  test("is detected", () => expect(detectFormat(tokens)).toBe("w3c"));

  test("simple tokens become variables in the given collection and mode", () => {
    const set = normalizeTokens(tokens, { collection: "DS", mode: "Light" });
    const c = set.collections[0]!;
    expect(c.name).toBe("DS");
    expect(c.modes).toEqual(["Light", "Dark"]);
    const byName = Object.fromEntries(c.variables.map((v) => [v.name, v]));
    expect(byName["color/blue/500"]!.values).toEqual({ Light: "#3B82F6", Dark: "#60A5FA" });
    expect(byName["color/primary"]).toMatchObject({ type: "color", values: { Light: { alias: "color/blue/500" } }, description: "Brand" });
    expect(byName["color/srgb"]!.values).toEqual({ Light: "#FF000080" });
    expect(byName["space/md"]).toMatchObject({ type: "number", values: { Light: 16 } });
  });

  test("composite tokens become styles with aliases resolved", () => {
    const set = normalizeTokens(tokens);
    expect(set.styles.text).toEqual([{ name: "type/h1", font: "Inter", weight: 700, size: 16, lineHeight: 1.2, letterSpacing: undefined, description: undefined }]);
    expect(set.styles.effects[0]).toEqual({ name: "shadow/card", value: [{ x: 0, y: 4, blur: 8, spread: 0, color: "#00000033", inner: false }], description: undefined });
    expect(set.warnings.join()).toContain("transition");
  });
});

describe("Tailwind theme", () => {
  const theme = {
    theme: {
      colors: { primary: { DEFAULT: "#0D99FF", 50: "#EFF6FF" }, white: "#fff", current: "currentColor" },
      spacing: { "0.5": "0.125rem", 4: "1rem" },
      borderRadius: { md: "0.375rem", full: "9999px" },
      fontSize: { sm: ["0.875rem", { lineHeight: "1.25rem", letterSpacing: "-0.01em" }], base: ["1rem", "1.5"] },
      fontFamily: { sans: ["Geist", "sans-serif"] },
      extend: { colors: { brand: "rgb(10 20 30)" } },
    },
  };

  test("is detected", () => expect(detectFormat(theme)).toBe("tailwind"));

  test("produces variables and text styles", () => {
    const set = normalizeTokens(theme);
    const names = set.collections[0]!.variables.map((v) => v.name);
    expect(set.collections[0]!.name).toBe("Tailwind");
    expect(names).toEqual(
      expect.arrayContaining(["color/primary/default", "color/primary/50", "color/white", "color/brand", "spacing/0_5", "spacing/4", "radius/md", "radius/full", "font-size/sm"]),
    );
    expect(names).not.toContain("color/current");
    const radius = set.collections[0]!.variables.find((v) => v.name === "radius/full")!;
    expect(radius.values).toEqual({ Default: 9999 });
    expect(set.styles.text).toEqual([
      { name: "text/sm", font: "Geist", size: 14, lineHeight: 20, letterSpacing: "-1%", weight: undefined },
      { name: "text/base", font: "Geist", size: 16, lineHeight: 1.5, letterSpacing: undefined, weight: undefined },
    ]);
  });
});

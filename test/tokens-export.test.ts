import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExportData, exportTokenFiles, type Format, FORMATS } from "../src/tokens-export";
import { normalizeTokens } from "../src/tokens";

const data: ExportData = {
  fileName: "Acme DS",
  collections: [
    {
      name: "Primitives",
      modes: ["Value"],
      variables: [
        { name: "blue/500", type: "color", values: { Value: "#3B82F6" } },
        { name: "blue/400", type: "color", values: { Value: "#60A5FA" } },
      ],
    },
    {
      name: "Theme",
      modes: ["Light", "Dark"],
      variables: [
        { name: "color/primary", type: "color", values: { Light: { alias: { collection: "Primitives", name: "blue/500" } }, Dark: { alias: { collection: "Primitives", name: "blue/400" } } }, description: "Brand" },
        { name: "color/link", type: "color", values: { Light: { alias: { collection: "Theme", name: "color/primary" } }, Dark: { alias: { collection: "Theme", name: "color/primary" } } } },
        { name: "color/bg", type: "color", values: { Light: "#FFFFFF", Dark: "#111111CC" } },
        { name: "space/md", type: "number", values: { Light: 16, Dark: 16 }, scopes: ["GAP"] },
        { name: "radius/card", type: "number", values: { Light: 12, Dark: 12 } },
        { name: "font/body", type: "string", values: { Light: "Inter", Dark: "Inter" } },
        { name: "weight/bold", type: "number", values: { Light: 700, Dark: 700 } },
        { name: "flag/beta", type: "boolean", values: { Light: true, Dark: false } },
      ],
    },
  ],
  styles: {
    colors: [
      { name: "Brand/Primary", value: { alias: { collection: "Theme", name: "color/primary" } } },
      { name: "Brand/Hero", value: { gradient: [{ color: "#0D99FF", at: 0 }, { color: "#7C3AED", at: 1 }], angle: 90 } },
    ],
    text: [{ name: "Heading/H1", font: "Inter", style: "Bold", size: 32, lineHeight: 40, letterSpacing: "-1%" }],
    effects: [{ name: "Shadow/Card", value: [{ x: 0, y: 4, blur: 16, spread: 0, color: "#0000001F" }] }],
  },
};

const files = (formats: Format[], opts = {}) => Object.fromEntries(exportTokenFiles(data, formats, opts).files.map((f) => [f.format, f.content]));

describe("design token export", () => {
  test("CSS: one block per mode, aliases stay var() references", () => {
    const css = files(["css"]).css!;
    expect(css).toContain(":root {");
    expect(css).toContain("  --blue-500: #3B82F6;");
    expect(css).toContain("  --color-primary: var(--blue-500);");
    expect(css).toContain("  --color-link: var(--color-primary);");
    expect(css).toContain("  --space-md: 16px;");
    expect(css).toContain("  --weight-bold: 700;");
    expect(css).toContain("  --font-body: Inter;");
    expect(css).not.toContain("flag-beta");
    expect(css).toMatch(/\[data-theme="dark"\] \{\n  --color-primary: var\(--blue-400\);/);
    expect(css).toContain("  --color-bg: #111111CC;");
    expect(css).toContain("--color-brand-primary: var(--color-primary);");
    expect(css).toContain("--color-brand-hero: linear-gradient(180deg, #0D99FF 0%, #7C3AED 100%);");
    expect(css).toContain("--shadow-card: 0px 4px 16px 0px #0000001F;");
    expect(css).toMatch(/\.text-heading-h1 \{\n  font-family: Inter, sans-serif;\n  font-weight: 700;\n  font-size: 32px;\n  line-height: 40px;\n  letter-spacing: -0.01em;/);
    expect(files(["css"], { modeSelector: ".theme-{mode}" }).css).toContain(".theme-dark {");
  });

  test("Tailwind v3 preset comes with tokens.css", () => {
    const out = files(["tailwind"]);
    expect(Object.keys(out).sort()).toEqual(["css", "tailwind"]);
    const preset = new Function("module", `${out.tailwind}; return module.exports;`)({}) as any;
    const t = preset.theme.extend;
    expect(t.colors.primary).toBe("var(--color-primary)");
    expect(t.colors.blue["500"]).toBe("var(--blue-500)");
    expect(t.colors.brand.primary).toBe("var(--color-brand-primary)");
    expect(t.backgroundImage.brand.hero).toBe("var(--color-brand-hero)");
    expect(t.spacing.md).toBe("var(--space-md)");
    expect(t.borderRadius.card).toBe("var(--radius-card)");
    expect(t.fontWeight.bold).toBe("var(--weight-bold)");
    expect(t.fontSize["heading-h1"]).toEqual(["32px", { lineHeight: "40px", letterSpacing: "-0.01em", fontWeight: "700" }]);
    expect(t.boxShadow.card).toBe("var(--shadow-card)");
  });

  test("Tailwind v4 @theme uses the theme namespaces", () => {
    const css = files(["tailwind4"]).tailwind4!;
    expect(css).toContain("@theme {");
    expect(css).toContain("  --color-primary: var(--color-blue-500);");
    expect(css).toContain("  --spacing-md: 16px;");
    expect(css).toContain("  --radius-card: 12px;");
    expect(css).toContain("  --text-heading-h1: 32px;");
    expect(css).toContain("  --text-heading-h1--line-height: 40px;");
    expect(css).toContain("  --shadow-card: 0px 4px 16px 0px #0000001F;");
    expect(css).toMatch(/\[data-theme="dark"\] \{\n  --color-primary: var\(--color-blue-400\);/);
  });

  test("SCSS: targets before aliases, other modes as maps", () => {
    const scss = files(["scss"]).scss!;
    expect(scss.indexOf("$blue-500:")).toBeLessThan(scss.indexOf("$color-primary: $blue-500;"));
    expect(scss.indexOf("$color-primary:")).toBeLessThan(scss.indexOf("$color-link: $color-primary;"));
    expect(scss).toContain('$theme-dark: (\n  "color-primary": #60A5FA,');
    expect(scss).toContain("@mixin text-heading-h1 {");
  });

  test("TypeScript output runs and keeps aliases as references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-tokens-"));
    try {
      writeFileSync(join(dir, "tokens.ts"), files(["ts"]).ts!);
      expect(files(["ts"]).ts).toContain("const colorLink = colorPrimary;");
      const mod = await import(join(dir, "tokens.ts"));
      expect(mod.tokens.Theme.color.primary).toBe("#3B82F6");
      expect(mod.tokens.Theme.color.link).toBe("#3B82F6");
      expect(mod.tokens.Primitives.blue["500"]).toBe("#3B82F6");
      expect(mod.modes.Theme.Dark["color/primary"]).toBe("#60A5FA");
      expect(mod.textStyles["Heading/H1"]).toMatchObject({ fontFamily: "Inter", fontWeight: 700, fontSize: 32 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DTCG and JSON exports read back into the same collections, modes and aliases", () => {
    const out = files(["dtcg", "json"]);
    for (const text of [out.dtcg!, out.json!]) {
      const set = normalizeTokens(JSON.parse(text));
      const theme = set.collections.find((c) => c.name === "Theme")!;
      expect(theme.modes).toEqual(["Light", "Dark"]);
      const by = Object.fromEntries(theme.variables.map((v) => [v.name, v]));
      expect(by["color/primary"]!.values).toEqual({ Light: { alias: "Primitives/blue/500" }, Dark: { alias: "Primitives/blue/400" } });
      expect(by["color/bg"]!.values).toEqual({ Light: "#FFFFFF", Dark: "#111111CC" });
      expect(by["space/md"]).toMatchObject({ type: "number", values: { Light: 16, Dark: 16 }, scopes: ["GAP"] });
      expect(set.collections.find((c) => c.name === "Primitives")!.variables).toHaveLength(2);
      expect(set.styles.colors.find((s) => s.name === "Brand/Primary")!.value).toBe("var:Theme/color/primary");
      expect(set.styles.colors.find((s) => s.name === "Brand/Hero")!.value).toEqual({ gradient: [{ color: "#0D99FF", at: 0 }, { color: "#7C3AED", at: 1 }], angle: 90 });
      expect(set.styles.text[0]).toMatchObject({ name: "Heading/H1", font: "Inter:Bold", size: 32, lineHeight: 40 });
      expect(set.styles.effects[0]).toMatchObject({ name: "Shadow/Card" });
      expect(set.warnings).toEqual([]);
    }
  });

  test("every format is deterministic", () => {
    const a = exportTokenFiles(data, [...FORMATS]).files;
    const b = exportTokenFiles(structuredClone(data), [...FORMATS]).files;
    expect(a.map((f) => f.path)).toEqual(["tokens.json", "tokens.css", "tailwind.preset.js", "theme.css", "_tokens.scss", "tokens.ts", "figma-tokens.json"]);
    expect(a).toEqual(b);
  });

  test("names shared by two collections get a collection prefix", () => {
    const twice: ExportData = {
      collections: [
        { name: "Light", modes: ["A"], variables: [{ name: "bg", type: "color", values: { A: "#FFFFFF" } }] },
        { name: "Dark", modes: ["A"], variables: [{ name: "bg", type: "color", values: { A: "#000000" } }] },
      ],
      styles: { colors: [], text: [], effects: [] },
    };
    const css = exportTokenFiles(twice, ["css"]).files[0]!.content;
    expect(css).toContain("--light-bg: #FFFFFF;");
    expect(css).toContain("--dark-bg: #000000;");
  });
});

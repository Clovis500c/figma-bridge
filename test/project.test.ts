import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrNode, Segment } from "../src/codegen";
import { cvaVariants, indexComponents, parseMembers } from "../src/project/components";
import { detectStack, importPath } from "../src/project/detect";
import { matchValue } from "../src/project/mapping";
import { planProjectExport, writePlan } from "../src/project/plan";
import { anyColor, loadTokens, tailwind3Colors } from "../src/project/tokens";

const NEXT = join(import.meta.dir, "fixtures", "projects", "next-shadcn");
const VUE = join(import.meta.dir, "fixtures", "projects", "vue-modules");

const seg = (text: string, o: Partial<Segment> = {}): Segment => ({ text, family: "Inter", style: "Regular", weight: 400, size: 14, color: "#111827", ...o });
const text = (id: string, t: string, o: Partial<Segment> = {}): IrNode => ({
  id, name: t, type: "TEXT", x: 0, y: 0, w: 100, h: 20, sizeH: "hug", sizeV: "hug", css: {},
  text: { autoResize: "WIDTH_AND_HEIGHT", align: "LEFT", valign: "TOP", truncate: 0, segments: [seg(t, o)] },
});
const instance = (id: string, name: string, props: Record<string, string | boolean>, label?: string): IrNode => ({
  id, name, type: "INSTANCE", x: 0, y: 0, w: 120, h: 36, sizeH: "hug", sizeV: "hug", css: { background: "#000000" },
  layout: { mode: "row", padding: [8, 16, 8, 16], gap: 8, justify: "CENTER", align: "CENTER" },
  component: { name, props, text: label },
  children: label ? [text(`${id}t`, label, { color: "#FFFFFF" })] : [],
});
const card: IrNode = {
  id: "1:1", name: "Pricing card", type: "FRAME", x: 0, y: 0, w: 360, h: 220, sizeH: "fixed", sizeV: "hug",
  css: { background: "var(--color-surface, #FFFFFF)", border: "1px solid #E5E7EB", "border-radius": "12px" },
  layout: { mode: "column", padding: [24, 24, 24, 24], gap: 16, justify: "MIN", align: "MIN" },
  children: [
    text("1:2", "Pro", { size: 24, weight: 700, style: "Bold" }),
    text("1:3", "For growing teams", { color: "#0D99FF" }),
    { ...instance("1:4", "Button", { Variant: "Secondary", Size: "Small", State: "Default", "Show icon": false }, "Upgrade"), sizeH: "fill" },
    instance("1:5", "Badge", { Type: "Outline" }, "New"),
    instance("1:6", "Avatar", { Initials: "AB", Size: "Large", Online: true }),
    instance("1:7", "Chart/Legacy", {}),
    { id: "1:8", name: "Photo", type: "RECTANGLE", x: 0, y: 0, w: 80, h: 80, sizeH: "fixed", sizeV: "fixed", css: {}, asset: { file: "photo.png", kind: "image", fit: "cover" } },
  ],
};
const assets = { "photo.png": new Uint8Array([137, 80, 78, 71]) };

describe("stack detection", () => {
  test("Next + Tailwind v4 + shadcn + TypeScript", () => {
    const s = detectStack(NEXT);
    expect(s).toMatchObject({ kind: "next", framework: "react", styling: "tailwind", tailwind: 4, ui: ["shadcn"], typescript: true, componentsDir: "src/components", assets: { dir: "public/figma", url: "/figma" } });
    expect(s.aliases).toContainEqual({ prefix: "@/", target: "src/" });
    expect(s.cssFiles).toContain("src/app/globals.css");
    expect(importPath(s, "src/components/ui/button.tsx", "src/components/Card.tsx")).toBe("@/components/ui/button");
  });

  test("Vue + CSS modules", () => {
    const s = detectStack(VUE);
    expect(s).toMatchObject({ kind: "vue", framework: "vue", styling: "css-modules", typescript: true, componentsDir: "src/components", assets: { dir: "src/assets/figma" } });
    expect(s.aliases).toContainEqual({ prefix: "@/", target: "src/" });
  });

  test("a folder without package.json is refused", () => {
    expect(() => detectStack(join(import.meta.dir, "fixtures"))).toThrow(/No package.json/);
  });
});

describe("component index", () => {
  test("React: cva variants, prop interfaces, default and named exports", () => {
    const list = indexComponents(detectStack(NEXT));
    const button = list.find((c) => c.name === "Button")!;
    expect(button).toMatchObject({ file: "src/components/ui/button.tsx", exportKind: "named", source: "shadcn", children: true });
    expect(button.props.find((p) => p.name === "variant")!.values).toEqual(["default", "destructive", "outline", "secondary", "ghost", "link"]);
    expect(button.props.find((p) => p.name === "size")!.values).toEqual(["default", "sm", "lg", "icon"]);
    expect(list.find((c) => c.name === "Badge")!.exportKind).toBe("named");
    const avatar = list.find((c) => c.name === "UserAvatar")!;
    expect(avatar.exportKind).toBe("default");
    expect(avatar.props).toEqual([
      { name: "initials", type: "string", optional: false, values: undefined },
      { name: "size", type: '"sm" | "md" | "lg"', optional: true, values: ["sm", "md", "lg"] },
      { name: "online", type: "boolean", optional: true, values: undefined },
    ]);
    expect(list.some((c) => c.name === "buttonVariants")).toBe(false);
  });

  test("Vue: typed and runtime defineProps, slots", () => {
    const list = indexComponents(detectStack(VUE));
    expect(list.find((c) => c.name === "AppButton")).toMatchObject({ file: "src/components/AppButton.vue", children: true, props: [{ name: "variant", values: ["primary", "ghost", "danger"] }, { name: "size", values: ["sm", "md", "lg"] }, { name: "disabled", type: "boolean" }] });
    expect(list.find((c) => c.name === "UserBadge")!.props).toEqual([{ name: "label", type: "string", optional: false }, { name: "tone", type: "string", optional: true }]);
  });

  test("parsers", () => {
    expect(parseMembers("a: string; b?: 'x' | 'y'; // note\n c: { d: number }")).toEqual([
      { name: "a", type: "string", optional: false, values: undefined },
      { name: "b", type: "'x' | 'y'", optional: true, values: ["x", "y"] },
      { name: "c", type: "{ d: number }", optional: false, values: undefined },
    ]);
    expect(cvaVariants('cva("x", { variants: { tone: { info: "a", "very-bad": { b: 1 } } } })')).toEqual([{ name: "tone", type: '"info" | "very-bad"', optional: true, values: ["info", "very-bad"] }]);
    expect(matchValue("Primary", ["default", "secondary"])).toBe("default");
    expect(matchValue("Small", ["default", "sm", "lg"])).toBe("sm");
    expect(matchValue("Danger", ["primary", "ghost", "danger"])).toBe("danger");
    expect(matchValue("Weird", ["a"])).toBeNull();
  });
});

describe("project tokens", () => {
  test("oklch, hsl triplets and v3 config colors", () => {
    expect(anyColor("oklch(0.205 0 0)")).toBe("#171717");
    expect(anyColor("oklch(62.8% 0.2577 29.23)")).toBe("#FF0000");
    expect(anyColor("222.2 47.4% 11.2%")).toBe("#0F172A");
    expect(tailwind3Colors(`module.exports = { theme: { extend: { colors: { brand: { DEFAULT: "#0D99FF", dark: "#0A6FBF" }, ink: '#111' } } } }`)).toEqual([
      { cssVar: "", kind: "color", value: "#0D99FF", tw: "brand", twKind: "color" },
      { cssVar: "", kind: "color", value: "#0A6FBF", tw: "brand-dark", twKind: "color" },
      { cssVar: "", kind: "color", value: "#111111", tw: "ink", twKind: "color" },
    ]);
  });

  test("Tailwind v4 theme variables resolve through var() to their light value", () => {
    const t = loadTokens(detectStack(NEXT));
    expect(t.color("#0D99FF")).toMatchObject({ cssVar: "color-brand", tw: "brand" });
    expect(t.color("#171717")).toMatchObject({ tw: "primary" });
    expect(t.byName("color/brand")).toMatchObject({ tw: "brand" });
  });
});

describe("project export", () => {
  test("Next + shadcn: imports the project's components, uses theme colors, plans files", () => {
    const plan = planProjectExport(NEXT, card, assets);
    expect(plan.files.map((f) => f.path)).toEqual(["src/components/PricingCard.tsx", "public/figma/photo.png"]);
    const code = plan.files[0]!.content as string;
    expect(code).toContain('import { Button } from "@/components/ui/button";');
    expect(code).toContain('import { Badge } from "@/components/ui/badge";');
    expect(code).toContain('import UserAvatar from "@/components/user-avatar";');
    expect(code).toMatch(/<Button className="[^"]*self-stretch[^"]*" variant="secondary" size="sm">Upgrade<\/Button>/);
    expect(code).toContain('<Badge variant="outline">New</Badge>');
    expect(code).toContain('<UserAvatar initials="AB" size="lg" online />');
    expect(code).toContain("text-brand");
    expect(code).toContain('src="/figma/photo.png"');
    expect(code).toContain("max-w-[360px]");
    expect(code).toContain("export default function PricingCard()");
    expect(plan.components.used.map((u) => u.figma).sort()).toEqual(["Avatar", "Badge", "Button"]);
    expect(plan.components.unmatched).toEqual([{ figma: "Chart/Legacy", instances: 1 }]);
    expect(plan.tokens.used).toBeGreaterThan(0);
  });

  test("Vue + CSS modules: SFC with $style classes, CSS variables and the mapping file", () => {
    const vueCard: IrNode = { ...card, children: [...card.children!, instance("1:9", "Tag", { Text: "Pro", Tone: "Positive" }), instance("1:10", "Icon/Legacy", {}, "x")] };
    const plan = planProjectExport(VUE, vueCard, assets, { name: "Plan card" });
    expect(plan.files.map((f) => f.path)).toEqual(["src/components/PlanCard.vue", "src/assets/figma/photo.png"]);
    const sfc = plan.files[0]!.content as string;
    expect(sfc).toContain('<script setup lang="ts">');
    expect(sfc).toContain('import AppButton from "@/components/AppButton.vue";');
    expect(sfc).toContain('import imgPhoto from "../assets/figma/photo.png";');
    expect(sfc).toContain('<UserBadge label="Pro" tone="success" />');
    expect(sfc).toContain(':class="$style.pricingCard"');
    expect(sfc).toContain("<style module>");
    expect(sfc).toContain("color: var(--color-primary);");
    expect(sfc).toContain(':src="imgPhoto"');
    expect(plan.mapFile).toContain("figma-bridge.map.json");
    // "Icon/Legacy" is ignored by the mapping file: its layers are generated.
    expect(plan.components.used.map((u) => u.figma)).not.toContain("Icon/Legacy");
  });

  test("Vue: Button maps to AppButton through the index", () => {
    const plan = planProjectExport(VUE, { ...card, children: [instance("2:1", "App button", { Variant: "Ghost", Size: "Large" }, "Go")] }, {});
    expect(plan.files[0]!.content).toContain('<AppButton variant="ghost" size="lg">Go</AppButton>');
  });

  test("other frameworks and stylings", () => {
    const rn = planProjectExport(NEXT, card, assets, { framework: "react-native", styling: "css" });
    const rnCode = rn.files[0]!.content as string;
    expect(rnCode).toContain('from "react-native";');
    expect(rnCode).toContain("StyleSheet.create({");
    expect(rnCode).toContain("<Text style={styles.");
    expect(rnCode).toMatch(/pricingCard: \{ [^}]*padding: 24/);
    const svelte = planProjectExport(NEXT, card, assets, { framework: "svelte", styling: "css" });
    expect(svelte.files[0]!.path).toBe("src/components/PricingCard.svelte");
    expect(svelte.files[0]!.content).toContain("<style>");
    const styled = planProjectExport(NEXT, card, assets, { styling: "styled-components" });
    expect(styled.files[0]!.content).toContain("const PricingCard = styled.div`");
    expect(styled.files[0]!.content).toContain('import styled from "styled-components";');
    const modules = planProjectExport(NEXT, card, assets, { styling: "css-modules" });
    expect(modules.files.map((f) => f.path)).toEqual(["src/components/PricingCard.tsx", "src/components/PricingCard.module.css", "public/figma/photo.png"]);
    expect(modules.files[0]!.content).toContain("className={styles.pricingCard}");
  });

  test("writePlan creates files, keeps changed ones unless overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-project-"));
    try {
      cpSync(NEXT, dir, { recursive: true });
      const plan = planProjectExport(dir, card, assets);
      expect(writePlan(dir, plan.files, false).map((w) => w.status)).toEqual(["created", "created"]);
      expect(existsSync(join(dir, "public", "figma", "photo.png"))).toBe(true);
      expect(writePlan(dir, plan.files, false).map((w) => w.status)).toEqual(["unchanged", "unchanged"]);
      const changed = [{ ...plan.files[0]!, content: "// edited" }];
      expect(writePlan(dir, changed, false)[0]!.status).toBe("skipped (exists)");
      expect(writePlan(dir, changed, true)[0]!.status).toBe("updated");
      expect(readFileSync(join(dir, "src", "components", "PricingCard.tsx"), "utf8")).toBe("// edited");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { installFigma, type MockNode, page } from "./figma-mock";

const lib = (name: string) => import(`../plugin/lib/${name}`) as Promise<any>;
const { build } = await lib("build");
const { inferRoles, isGenericName, pascalName, uniqueSiblingNames } = await lib("naming");

const all = (n: MockNode): MockNode[] => [n, ...(n.children ?? []).flatMap(all)];

const frame = (name: string, extra: any = {}, children: any[] = []) => ({ kind: "frame", name, x: 0, y: 0, w: 300, h: 200, children, ...extra });
const text = (name: string, t: string, fontSize = 14, extra: any = {}) => ({ kind: "text", name, text: t, fontSize, x: 0, y: 0, w: 100, h: 20, children: [], ...extra });

describe("role names", () => {
  test("Figma's default names are generic, people's names are not", () => {
    for (const n of ["Frame 12", "Rectangle 3 copy", "Auto layout", "group", "Ellipse 2 copy 4", "Container"])
      expect(isGenericName({ kind: "frame", name: n, children: [] })).toBe(true);
    for (const n of ["Hero", "Product card", "Frame of mind"]) expect(isGenericName({ kind: "frame", name: n, children: [] })).toBe(false);
    expect(isGenericName(text("Buy now", "Buy now"))).toBe(true);
    expect(isGenericName(text("Price", "250 coins"))).toBe(false);
  });

  test("screens, bars, cards, lists, buttons, badges and text roles", () => {
    const button = (label: string) => frame("Frame", { w: 120, h: 40, background: true, radius: 8 }, [text(label, label)]);
    const card = (k: number) =>
      frame(`Frame ${k}`, { y: k * 120, w: 360, h: 110, background: true, radius: 12 }, [
        text("Golden Sword", "Golden Sword", 18),
        text(
          "A sharp blade forged in the fires of the northern mountains, sold by the smith.",
          "A sharp blade forged in the fires of the northern mountains, sold by the smith.",
          14,
        ),
        text("250", "250", 14),
        frame("Frame", { w: 40, h: 18, background: true, radius: 9 }, [text("NEW", "NEW", 10)]),
        { kind: "shape", name: "Rectangle", x: 0, y: 109, w: 360, h: 1, background: true, children: [] },
      ]);
    const root = frame("Frame 1", { w: 390, h: 844 }, [
      frame("Frame 2", { w: 390, h: 64, layout: "HORIZONTAL" }, [text("Shop", "Shop", 28), { kind: "vector", name: "Vector", x: 340, y: 20, w: 24, h: 24, children: [] }]),
      frame("Frame 3", { y: 80, w: 390, h: 600, layout: "VERTICAL" }, [card(1), card(2), card(3)]),
      frame("Frame 4", { y: 760, w: 390, h: 84, layout: "HORIZONTAL" }, [button("Buy"), button("Sell")]),
    ]);
    inferRoles(root);
    expect(root.role).toBe("Screen");
    const [header, list, footer] = root.children;
    expect(header.role).toBe("Header");
    expect(header.children.map((c: any) => c.role)).toEqual(["Title", "Icon"]);
    expect(list.role).toBe("CardList");
    expect(list.children[0].children.map((c: any) => c.role)).toEqual(["Title", "Description", "Value", "Badge", "Divider"]);
    expect(list.children[0].children[3].children[0].role).toBe("Label");
    expect(footer.role).toBe("Footer");
    expect(footer.children.map((c: any) => c.role)).toEqual(["Button", "Button"]);
    expect(footer.children[0].children[0].role).toBe("Label");
    const actions = frame("Frame", { w: 300, h: 40, layout: "HORIZONTAL" }, [button("Buy"), button("Sell")]);
    inferRoles(frame("Panel", {}, [actions]));
    expect(actions.role).toBe("Actions");
  });

  test("formatting", () => {
    expect(pascalName("shop card")).toBe("ShopCard");
    expect(pascalName("Button/Primary/Large")).toBe("PrimaryLargeButton");
    expect(pascalName("icon/lucide:house")).toBe("HouseIcon");
    expect(pascalName("Card/Product/Default")).toBe("ProductCard");
    expect(pascalName("HUD bar")).toBe("HUDBar");
    expect(pascalName("Écran d'accueil")).toBe("EcranDAccueil");
    expect(uniqueSiblingNames(["Card", "Title", "Card", "Card"])).toEqual(["Card1", "Title", "Card2", "Card3"]);
  });
});

describe("build names unnamed layers by role", () => {
  test("named layers keep their names, the others get roles", async () => {
    const pg = page("Page", []);
    installFigma({ pages: [pg] });
    await build({
      spec: {
        name: "Pricing",
        layout: "column",
        w: 360,
        padding: 24,
        gap: 16,
        fill: "#FFFFFF",
        radius: 16,
        children: [
          { text: "Pro plan", size: 24, weight: 700 },
          { text: "Everything you need to ship faster, with unlimited projects and priority support for teams.", w: "fill" },
          { name: "Price", text: "$12 / month" },
          {
            layout: "row",
            gap: 8,
            children: [
              { layout: "row", w: 120, h: 40, padding: [10, 16], fill: "#0D99FF", radius: 8, children: [{ text: "Buy" }] },
              { layout: "row", w: 120, h: 40, padding: [10, 16], stroke: "#D1D5DB", radius: 8, children: [{ text: "Learn more" }] },
            ],
          },
          { type: "rect", w: 312, h: 1, fill: "#EEEEEE" },
        ],
      },
    });
    const root = pg.children![0]!;
    expect(root.name).toBe("Pricing");
    expect(root.children!.map((c) => c.name)).toEqual(["Title", "Description", "Price", "Actions", "Divider"]);
    const actions = root.children![3]!;
    expect(actions.children!.map((c) => c.name)).toEqual(["Button", "Button"]);
    expect(
      all(actions)
        .filter((n) => n.type === "TEXT")
        .map((n) => n.name),
    ).toEqual(["Label", "Label"]);
  });
});

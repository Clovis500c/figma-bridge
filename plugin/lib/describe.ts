// Compact, token-cheap outline of a node tree: one line per layer.
import { getNode, isAutoLayout, round, styleName, toHex } from "./util";

export async function describe(p: any) {
  let targets: BaseNode[];
  if (p.nodeId) targets = [await getNode(p.nodeId)];
  else if (figma.currentPage.selection.length) targets = figma.currentPage.selection.slice();
  else targets = [figma.currentPage];
  for (let i = 0; i < targets.length; i++) if (targets[i].type === "PAGE") await (targets[i] as PageNode).loadAsync();
  const maxDepth = Math.max(0, Math.min(12, typeof p.depth === "number" ? p.depth : 3));
  const budget = Math.max(10, Math.min(2000, p.maxNodes || 300));
  const lines: string[] = [];
  let count = 0;
  let truncated = false;

  const walk = async function (node: BaseNode, depth: number) {
    if (count >= budget) {
      truncated = true;
      return;
    }
    count++;
    lines.push(repeat("  ", depth) + (await line(node)));
    const kids: readonly BaseNode[] = "children" in node ? (node as any).children : [];
    if (!kids.length) return;
    if (depth >= maxDepth) {
      lines.push(repeat("  ", depth + 1) + "… " + kids.length + " children (increase depth or describe " + node.id + ")");
      return;
    }
    for (let i = 0; i < kids.length; i++) {
      if (count >= budget) {
        lines.push(repeat("  ", depth + 1) + "… " + (kids.length - i) + " more");
        truncated = true;
        return;
      }
      await walk(kids[i], depth + 1);
    }
  };
  for (let i = 0; i < targets.length; i++) await walk(targets[i], 0);
  return { outline: lines.join("\n"), nodes: count, truncated: truncated };
}

function repeat(s: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += s;
  return out;
}

async function line(n: any): Promise<string> {
  const parts: string[] = [n.type, JSON.stringify(n.name), n.id];
  if (n.type === "PAGE" || n.type === "DOCUMENT") return parts.join(" ");
  if (n.visible === false) parts.push("[hidden]");
  if (typeof n.width === "number") parts.push(round(n.width) + "×" + round(n.height));
  if (n.parent && !isAutoLayout(n.parent) && typeof n.x === "number") parts.push("@" + round(n.x) + "," + round(n.y));
  if (n.parent && isAutoLayout(n.parent) && n.layoutSizingHorizontal) {
    parts.push("size:" + n.layoutSizingHorizontal.toLowerCase() + "/" + n.layoutSizingVertical.toLowerCase());
    if (n.layoutPositioning === "ABSOLUTE") parts.push("absolute");
  }
  if (isAutoLayout(n)) parts.push(layoutText(n));
  if (n.clipsContent) parts.push("clip");

  if (n.type === "TEXT") {
    const text = n.characters.length > 80 ? n.characters.slice(0, 77) + "…" : n.characters;
    parts.push(JSON.stringify(text));
    if (n.fontName !== figma.mixed) parts.push(n.fontName.family + " " + n.fontName.style);
    else parts.push("mixed fonts");
    if (n.fontSize !== figma.mixed) parts.push(String(round(n.fontSize)) + "px");
    const lh = n.lineHeight;
    if (lh !== figma.mixed && lh.unit !== "AUTO") parts.push("lh:" + round(lh.value) + (lh.unit === "PERCENT" ? "%" : "px"));
    const ts = await styleName(n.textStyleId);
    if (ts) parts.push("textStyle:" + JSON.stringify(ts));
  }

  const fills = await paintsText(n, "fills", "fillStyleId");
  if (fills) parts.push((n.type === "TEXT" ? "color:" : "fill:") + fills);
  const strokes = await paintsText(n, "strokes", "strokeStyleId");
  if (strokes && n.strokeWeight !== figma.mixed && n.strokeWeight > 0) parts.push("stroke:" + strokes + " " + round(n.strokeWeight));

  if ("cornerRadius" in n) {
    if (n.cornerRadius === figma.mixed) parts.push("radius:" + [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].join(","));
    else if (n.cornerRadius > 0) parts.push("radius:" + round(n.cornerRadius));
  }
  if (typeof n.opacity === "number" && n.opacity < 1) parts.push("opacity:" + round(n.opacity));
  if (n.effects && n.effects.length) {
    const es = await styleName(n.effectStyleId);
    parts.push(
      "effects:" +
        (es
          ? JSON.stringify(es)
          : n.effects
              .map(function (e: Effect) {
                return e.type.toLowerCase().replace("_shadow", "-shadow").replace("layer_", "").replace("background_", "bg-");
              })
              .join("+")),
    );
  }
  if (n.type === "INSTANCE") {
    const main = await n.getMainComponentAsync();
    if (main) {
      const setName = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : main.name;
      parts.push("of:" + JSON.stringify(setName));
    }
    const props = n.componentProperties;
    const keys = Object.keys(props);
    if (keys.length) {
      parts.push(
        "{" +
          keys
            .slice(0, 8)
            .map(function (k) {
              return k.split("#")[0] + "=" + props[k].value;
            })
            .join(", ") +
          "}",
      );
    }
  }
  if (n.type === "COMPONENT_SET") {
    const defs = n.componentPropertyDefinitions;
    parts.push(
      "variants{" +
        Object.keys(defs)
          .filter(function (k) {
            return defs[k].type === "VARIANT";
          })
          .map(function (k) {
            return k + ":" + (defs[k].variantOptions || []).join("|");
          })
          .join("; ") +
        "}",
    );
  }
  if (n.boundVariables && Object.keys(n.boundVariables).length) parts.push("vars:" + Object.keys(n.boundVariables).join(","));
  return parts.join(" ");
}

function layoutText(n: any): string {
  if (n.layoutMode === "GRID") {
    const gaps = n.gridColumnGap === n.gridRowGap ? "gap:" + round(n.gridColumnGap) : "gap:" + round(n.gridColumnGap) + "/" + round(n.gridRowGap);
    return "grid " + n.gridColumnCount + "×" + n.gridRowCount + (n.gridColumnGap || n.gridRowGap ? " " + gaps : "");
  }
  const out = [n.layoutMode === "HORIZONTAL" ? "row" : "column"];
  if (n.primaryAxisAlignItems === "SPACE_BETWEEN") out.push("gap:auto");
  else if (n.itemSpacing) out.push("gap:" + round(n.itemSpacing));
  const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(round);
  if (pad[0] || pad[1] || pad[2] || pad[3]) {
    out.push("pad:" + (pad[0] === pad[2] && pad[1] === pad[3] ? (pad[0] === pad[1] ? pad[0] : pad[0] + "," + pad[1]) : pad.join(",")));
  }
  const names: any = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" };
  if (n.primaryAxisAlignItems !== "MIN" && n.primaryAxisAlignItems !== "SPACE_BETWEEN") out.push("justify:" + names[n.primaryAxisAlignItems]);
  if (n.counterAxisAlignItems !== "MIN") out.push("align:" + names[n.counterAxisAlignItems]);
  if (n.layoutWrap === "WRAP") out.push("wrap");
  return out.join(" ");
}

async function paintsText(n: any, field: string, styleField: string): Promise<string | null> {
  if (!(field in n)) return null;
  const style = await styleName(n[styleField]);
  if (style) return "style:" + JSON.stringify(style);
  const paints = n[field];
  if (paints === figma.mixed) return "mixed";
  const visible = (paints as Paint[]).filter(function (p) {
    return p.visible !== false;
  });
  if (!visible.length) return null;
  return visible
    .map(function (p: any) {
      if (p.type === "SOLID") {
        const bound = p.boundVariables && p.boundVariables.color ? "var" : "";
        return (bound ? bound + ":" : "") + toHex(p.color, p.opacity);
      }
      if (p.type === "IMAGE") return "image(" + String(p.scaleMode).toLowerCase() + ")";
      if (p.type.indexOf("GRADIENT") === 0) {
        return p.type.replace("GRADIENT_", "").toLowerCase() + "-gradient(" + p.gradientStops.map(function (s: ColorStop) {
          return toHex(s.color);
        }).join(",") + ")";
      }
      return p.type.toLowerCase();
    })
    .join("+");
}

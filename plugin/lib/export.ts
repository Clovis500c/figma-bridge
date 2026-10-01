// export_code, plugin side: walks a layer tree into a compact description that the server turns
// into HTML or React. Visual CSS comes from getCSSAsync; layout and sizing are read directly
// so auto-layout maps to flexbox (Figma's own CSS hard-codes every size in px).
import { codeError, getNode, round, toHex } from "./util";

const MAX_NODES = 1500;
const MAX_ASSET_BYTES = 40 << 20;
const VECTOR_TYPES = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "ELLIPSE", "LINE"];
const VISUAL_CSS = [
  "background",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-radius",
  "box-shadow",
  "opacity",
  "filter",
  "backdrop-filter",
  "mix-blend-mode",
  "outline",
  "outline-offset",
];

interface Ctx {
  count: number;
  truncated: boolean;
  assets: { [file: string]: { b64?: string; svg?: string } };
  assetBytes: number;
  imageFiles: { [hash: string]: string };
  names: { [name: string]: number };
  warnings: string[];
}

export async function exportTree(p: any) {
  const node: any = p.nodeId ? await getNode(p.nodeId) : figma.currentPage.selection[0];
  if (!node) throw codeError("No nodeId given and nothing is selected", "BAD_ARGS");
  if (node.type === "PAGE" || node.type === "DOCUMENT") throw codeError("Export a frame or layer, not a page", "BAD_ARGS");
  const ctx: Ctx = { count: 0, truncated: false, assets: {}, assetBytes: 0, imageFiles: {}, names: {}, warnings: [] };
  const tree = await walk(node, null, ctx);
  return { tree: tree, assets: ctx.assets, nodes: ctx.count, truncated: ctx.truncated, warnings: ctx.warnings.slice(0, 40) };
}

function fileName(base: string, ext: string, ctx: Ctx): string {
  const clean =
    String(base)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "asset";
  const n = (ctx.names[clean + ext] = (ctx.names[clean + ext] || 0) + 1);
  return clean + (n > 1 ? "-" + n : "") + "." + ext;
}

function sizing(n: any, axis: "H" | "V"): string {
  const v = n["layoutSizing" + (axis === "H" ? "Horizontal" : "Vertical")];
  return v === "FILL" ? "fill" : v === "HUG" ? "hug" : "fixed";
}

function isVectorOnly(n: any): boolean {
  if (VECTOR_TYPES.indexOf(n.type) !== -1) return !hasImageFill(n);
  if (n.type === "TEXT" || hasImageFill(n)) return false;
  if (!("children" in n) || !n.children.length) return false;
  for (let i = 0; i < n.children.length; i++) if (n.children[i].visible && !isVectorOnly(n.children[i])) return false;
  return true;
}

function hasImageFill(n: any): boolean {
  return (
    "fills" in n &&
    n.fills !== figma.mixed &&
    n.fills.some(function (f: Paint) {
      return f.type === "IMAGE" && f.visible !== false;
    })
  );
}

async function imageAsset(n: any, ctx: Ctx): Promise<{ file: string; fit: string } | null> {
  const paint: any = (n.fills as Paint[]).filter(function (f) {
    return f.type === "IMAGE" && f.visible !== false;
  })[0];
  if (!paint || !paint.imageHash) return null;
  let file = ctx.imageFiles[paint.imageHash];
  if (!file) {
    const image = figma.getImageByHash(paint.imageHash);
    if (!image) return null;
    const bytes = await image.getBytesAsync();
    if (ctx.assetBytes + bytes.length > MAX_ASSET_BYTES) {
      ctx.warnings.push(n.name + ": image skipped (assets over " + (MAX_ASSET_BYTES >> 20) + " MB)");
      return null;
    }
    ctx.assetBytes += bytes.length;
    file = fileName(n.name, "img", ctx); // the server sets the real extension from the bytes
    ctx.assets[file] = { b64: figma.base64Encode(bytes) };
    ctx.imageFiles[paint.imageHash] = file;
  }
  return { file: file, fit: paint.scaleMode === "FIT" ? "contain" : paint.scaleMode === "TILE" ? "tile" : "cover" };
}

function tracks(list: any[]): string[] {
  return (list || []).map(function (t: any) {
    return t.type === "FIXED" ? round(t.value) + "px" : t.type === "HUG" ? "auto" : (t.value || 1) + "fr";
  });
}

async function walk(n: any, parent: any, ctx: Ctx): Promise<any> {
  ctx.count++;
  const box = n.absoluteBoundingBox || { x: 0, y: 0, width: n.width || 0, height: n.height || 0 };
  const pbox = parent && parent.absoluteBoundingBox;
  const out: any = {
    id: n.id,
    name: n.name,
    type: n.type,
    x: pbox ? round(box.x - pbox.x) : 0,
    y: pbox ? round(box.y - pbox.y) : 0,
    w: round(box.width),
    h: round(box.height),
    sizeH: sizing(n, "H"),
    sizeV: sizing(n, "V"),
  };
  if (n.layoutPositioning === "ABSOLUTE") out.absolute = true;
  if (n.layoutGrow === 1) out.grow = true;
  if (parent && parent.layoutMode === "GRID") {
    if (n.gridColumnSpan > 1) out.colSpan = n.gridColumnSpan;
    if (n.gridRowSpan > 1) out.rowSpan = n.gridRowSpan;
  }
  if (n.rotation && Math.abs(n.rotation) > 0.01 && n.type !== "TEXT") out.rotation = round(n.rotation);

  let css: any = {};
  try {
    css = await n.getCSSAsync();
  } catch (e) {}
  const visual: any = {};
  for (let i = 0; i < VISUAL_CSS.length; i++) if (css[VISUAL_CSS[i]] !== undefined) visual[VISUAL_CSS[i]] = css[VISUAL_CSS[i]];
  out.css = visual;

  // Icons and shapes become SVG files; images become files too.
  if (n.type !== "TEXT" && isVectorOnly(n)) {
    try {
      const svg = await n.exportAsync({ format: "SVG_STRING" });
      const file = fileName(n.name, "svg", ctx);
      ctx.assets[file] = { svg: svg };
      out.asset = { file: file, kind: "svg" };
      out.css = {};
      return out;
    } catch (e) {
      ctx.warnings.push(n.name + ": SVG export failed, kept as a box");
    }
  }
  if (hasImageFill(n)) {
    const img = await imageAsset(n, ctx);
    if (img) {
      delete out.css.background;
      if ("children" in n && n.children.length) out.bgImage = img;
      else out.asset = { file: img.file, kind: "image", fit: img.fit };
    }
  }

  if (n.type === "TEXT") {
    out.text = textOf(n);
    return out;
  }

  if ("layoutMode" in n && n.layoutMode && n.layoutMode !== "NONE") {
    const l: any = {
      mode: n.layoutMode === "HORIZONTAL" ? "row" : n.layoutMode === "VERTICAL" ? "column" : "grid",
      padding: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(round),
    };
    if (l.mode === "grid") {
      l.columns = tracks(n.gridColumnSizes);
      l.rows = tracks(n.gridRowSizes);
      l.columnGap = round(n.gridColumnGap || 0);
      l.rowGap = round(n.gridRowGap || 0);
    } else {
      l.gap = n.primaryAxisAlignItems === "SPACE_BETWEEN" ? 0 : round(n.itemSpacing || 0);
      l.justify = n.primaryAxisAlignItems;
      l.align = n.counterAxisAlignItems;
      if (n.layoutWrap === "WRAP") {
        l.wrap = true;
        l.rowGap = round(n.counterAxisSpacing || 0);
      }
    }
    out.layout = l;
  }
  if (n.clipsContent) out.clip = true;

  if ("children" in n && n.children.length && !out.asset) {
    out.children = [];
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (!c.visible) continue;
      if (ctx.count >= MAX_NODES) {
        ctx.truncated = true;
        break;
      }
      out.children.push(await walk(c, n, ctx));
    }
  }
  return out;
}

function textOf(t: TextNode) {
  const segments = t.getStyledTextSegments(["fontName", "fontSize", "fontWeight", "fills", "textDecoration", "hyperlink", "letterSpacing", "lineHeight", "textCase"]);
  return {
    autoResize: t.textAutoResize,
    align: t.textAlignHorizontal,
    valign: t.textAlignVertical,
    truncate: t.textTruncation === "ENDING" ? t.maxLines || 1 : 0,
    segments: segments.map(function (s: any) {
      const fill = (s.fills as Paint[]).filter(function (f) {
        return f.visible !== false;
      })[0] as any;
      const seg: any = {
        text: s.characters,
        family: s.fontName.family,
        style: s.fontName.style,
        weight: s.fontWeight,
        size: round(s.fontSize),
      };
      if (fill && fill.type === "SOLID") seg.color = toHex(fill.color, fill.opacity);
      if (s.textDecoration !== "NONE") seg.decoration = s.textDecoration === "UNDERLINE" ? "underline" : "line-through";
      if (s.hyperlink && s.hyperlink.type === "URL") seg.link = s.hyperlink.value;
      if (s.letterSpacing && s.letterSpacing.value) seg.letterSpacing = s.letterSpacing.unit === "PERCENT" ? round(s.letterSpacing.value / 100) + "em" : round(s.letterSpacing.value) + "px";
      if (s.lineHeight && s.lineHeight.unit !== "AUTO") seg.lineHeight = s.lineHeight.unit === "PERCENT" ? String(round(s.lineHeight.value / 100)) : round(s.lineHeight.value) + "px";
      if (s.textCase && s.textCase !== "ORIGINAL") seg.textCase = s.textCase === "UPPER" ? "uppercase" : s.textCase === "LOWER" ? "lowercase" : "capitalize";
      return seg;
    }),
  };
}

// export_roblox, plugin side: a layer tree with what Roblox UI needs (constraints, auto-layout, paints,
// effects, text runs), and PNG pictures of the parts Roblox can't draw natively.
// Syntax stays ES2017 (no ?. ?? object spread or optional catch binding): the sandbox parser is conservative.
import { codeError, getNode, round, toHex } from "./util";

const MAX_NODES = 2000;
const VECTORS = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"];

interface Ctx {
  count: number;
  truncated: boolean;
  images: { [hash: string]: string };
  imageBytes: number;
}

export async function robloxTree(p: any) {
  const node: any = p.nodeId ? await getNode(p.nodeId) : figma.currentPage.selection[0];
  if (!node) throw codeError("No nodeId given and nothing is selected", "BAD_ARGS");
  if (node.type === "PAGE" || node.type === "DOCUMENT") throw codeError("Export a frame, not a page", "BAD_ARGS");
  const ctx: Ctx = { count: 0, truncated: false, images: {}, imageBytes: 0 };
  const tree = await walk(node, null, ctx);
  return { tree: tree, images: ctx.images, nodes: ctx.count, truncated: ctx.truncated, fileName: figma.root.name };
}

function paints(list: any): any[] {
  if (!list || list === figma.mixed) return [];
  const out: any[] = [];
  for (let i = 0; i < list.length; i++) {
    const pt = list[i];
    if (pt.visible === false) continue;
    const o: any = { type: pt.type, opacity: pt.opacity === undefined ? 1 : round(pt.opacity) };
    if (pt.type === "SOLID") o.color = toHex(pt.color);
    else if (pt.type.indexOf("GRADIENT") === 0) {
      const t = pt.gradientTransform;
      o.angle = round((Math.atan2(t[0][1], t[0][0]) * 180) / Math.PI);
      o.stops = pt.gradientStops.map(function (s: ColorStop) {
        return { color: toHex({ r: s.color.r, g: s.color.g, b: s.color.b }), alpha: round(s.color.a), at: round(s.position) };
      });
    } else if (pt.type === "IMAGE") {
      o.imageHash = pt.imageHash;
      o.scaleMode = pt.scaleMode;
    }
    out.push(o);
  }
  return out;
}

function vectorOnly(n: any): boolean {
  if (VECTORS.indexOf(n.type) !== -1) return true;
  if (n.type === "TEXT" || !("children" in n) || !n.children.length) return false;
  for (let i = 0; i < n.children.length; i++) if (n.children[i].visible && !vectorOnly(n.children[i])) return false;
  return true;
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
  };
  if (n.visible === false) out.hidden = true;
  if (typeof n.opacity === "number" && n.opacity < 1) out.opacity = round(n.opacity);
  if (n.rotation && Math.abs(n.rotation) > 0.01) out.rotation = round(-n.rotation);
  if (n.clipsContent) out.clip = true;
  if (n.constraints) out.constraints = { h: n.constraints.horizontal, v: n.constraints.vertical };
  if (n.layoutPositioning === "ABSOLUTE") out.absolute = true;
  if (n.layoutGrow === 1) out.grow = true;
  if (n.layoutAlign === "STRETCH") out.stretch = true;
  if ("layoutSizingHorizontal" in n) out.sizing = { h: n.layoutSizingHorizontal, v: n.layoutSizingVertical };
  const rb = n.absoluteRenderBounds;
  if (rb && (Math.abs(rb.x - box.x) > 0.5 || Math.abs(rb.y - box.y) > 0.5 || Math.abs(rb.width - box.width) > 0.5 || Math.abs(rb.height - box.height) > 0.5)) {
    out.render = { x: round(rb.x - box.x), y: round(rb.y - box.y), w: round(rb.width), h: round(rb.height) };
  }
  if ("fills" in n) out.fills = paints(n.fills);
  if ("strokes" in n && n.strokes.length) {
    out.strokes = paints(n.strokes);
    out.strokeWeight = n.strokeWeight === figma.mixed ? round(n.strokeTopWeight || 1) : round(n.strokeWeight);
    out.strokeAlign = n.strokeAlign;
    if (n.dashPattern && n.dashPattern.length) out.dashed = true;
  }
  if ("topLeftRadius" in n) {
    const r = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].map(round);
    if (r[0] || r[1] || r[2] || r[3]) out.radius = r;
  } else if (typeof n.cornerRadius === "number" && n.cornerRadius) out.radius = [round(n.cornerRadius), round(n.cornerRadius), round(n.cornerRadius), round(n.cornerRadius)];
  if ("effects" in n && n.effects.length) {
    out.effects = n.effects
      .filter(function (e: Effect) {
        return e.visible !== false;
      })
      .map(function (e: any) {
        return e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"
          ? { type: e.type, x: round(e.offset.x), y: round(e.offset.y), blur: round(e.radius), spread: round(e.spread || 0), color: toHex({ r: e.color.r, g: e.color.g, b: e.color.b }), alpha: round(e.color.a) }
          : { type: e.type, blur: round(e.radius) };
      });
  }
  if (n.reactions && n.reactions.length) {
    out.clickable = n.reactions.some(function (r: any) {
      return r.trigger && (r.trigger.type === "ON_CLICK" || r.trigger.type === "ON_PRESS");
    });
  }
  if (n.type !== "TEXT" && vectorOnly(n)) out.vector = true;

  // Image fills: the original bytes, once per image.
  const fills: any[] = out.fills || [];
  for (let i = 0; i < fills.length; i++) {
    const h = fills[i].imageHash;
    if (!h || ctx.images[h] !== undefined) continue;
    const image = figma.getImageByHash(h);
    if (!image) continue;
    const bytes = await image.getBytesAsync();
    if (ctx.imageBytes + bytes.length > 40 << 20) continue;
    ctx.imageBytes += bytes.length;
    ctx.images[h] = figma.base64Encode(bytes);
  }

  if (n.type === "TEXT") {
    out.text = textOf(n);
    return out;
  }
  if (n.layoutMode && n.layoutMode !== "NONE") {
    const l: any = {
      mode: n.layoutMode,
      padding: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(round),
      gap: round(n.itemSpacing || 0),
      primary: n.primaryAxisAlignItems,
      counter: n.counterAxisAlignItems,
    };
    if (n.layoutWrap === "WRAP") {
      l.wrap = true;
      l.counterGap = round(n.counterAxisSpacing || 0);
    }
    if (n.layoutMode === "GRID") {
      l.columns = n.gridColumnCount;
      l.rows = n.gridRowCount;
      l.columnGap = round(n.gridColumnGap || 0);
      l.rowGap = round(n.gridRowGap || 0);
    }
    out.layout = l;
  }
  if ("children" in n && n.children.length && !out.vector) {
    out.children = [];
    for (let i = 0; i < n.children.length; i++) {
      if (ctx.count >= MAX_NODES) {
        ctx.truncated = true;
        break;
      }
      out.children.push(await walk(n.children[i], n, ctx));
    }
  }
  return out;
}

function textOf(t: TextNode) {
  const segs = t.getStyledTextSegments(["fontName", "fontSize", "fontWeight", "fills", "textDecoration", "textCase", "letterSpacing", "lineHeight"]);
  return {
    characters: t.characters,
    align: t.textAlignHorizontal,
    valign: t.textAlignVertical,
    autoResize: t.textAutoResize,
    maxLines: t.textTruncation === "ENDING" ? t.maxLines || 1 : 0,
    segments: segs.map(function (s: any) {
      const fill = (s.fills as Paint[]).filter(function (f) {
        return f.visible !== false;
      })[0] as any;
      const seg: any = { text: s.characters, family: s.fontName.family, style: s.fontName.style, weight: s.fontWeight, size: round(s.fontSize) };
      if (fill && fill.type === "SOLID") {
        seg.color = toHex(fill.color);
        if (fill.opacity !== undefined && fill.opacity < 1) seg.alpha = round(fill.opacity);
      }
      if (s.textDecoration !== "NONE") seg.decoration = s.textDecoration;
      if (s.textCase && s.textCase !== "ORIGINAL") seg.textCase = s.textCase;
      if (s.letterSpacing && s.letterSpacing.value) seg.letterSpacing = round(s.letterSpacing.unit === "PERCENT" ? (s.letterSpacing.value / 100) * s.fontSize : s.letterSpacing.value);
      if (s.lineHeight && s.lineHeight.unit !== "AUTO") seg.lineHeight = round(s.lineHeight.unit === "PERCENT" ? (s.lineHeight.value / 100) * s.fontSize : s.lineHeight.value);
      return seg;
    }),
  };
}

/**
 * PNG pictures for export_roblox. mode "full": the layer as it looks; "panel": its own fill and stroke only
 * (no children, no effects), for a 9-slice background; "shadow": its drop shadows only.
 */
export async function robloxImages(p: any) {
  const items: any[] = Array.isArray(p.items) ? p.items : [];
  const out: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const scale = Math.max(1, Math.min(4, Number(it.scale) || 2));
    let temp: any = null;
    try {
      let node: any = await getNode(it.id);
      if (it.mode === "panel" || it.mode === "shadow") {
        // A copy without children (and without effects, or with nothing but shadows), removed right after.
        temp = node.clone();
        if ("children" in temp) for (let k = temp.children.length - 1; k >= 0; k--) temp.children[k].remove();
        if (it.mode === "panel") temp.effects = [];
        else {
          temp.effects = node.effects.filter(function (e: Effect) {
            return e.type === "DROP_SHADOW" && e.visible !== false;
          });
          temp.strokes = [];
        }
        node = temp;
      }
      const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
      const rb = node.absoluteRenderBounds || node.absoluteBoundingBox;
      const bb = node.absoluteBoundingBox;
      out.push({
        id: it.id,
        mode: it.mode || "full",
        scale: scale,
        b64: figma.base64Encode(bytes),
        offset: rb && bb ? { x: round(rb.x - bb.x), y: round(rb.y - bb.y) } : { x: 0, y: 0 },
        size: rb ? { w: round(rb.width), h: round(rb.height) } : { w: round(node.width), h: round(node.height) },
      });
    } catch (e) {
      out.push({ id: it.id, mode: it.mode || "full", error: String((e as Error).message || e) });
    } finally {
      if (temp) temp.remove();
    }
  }
  return { images: out };
}

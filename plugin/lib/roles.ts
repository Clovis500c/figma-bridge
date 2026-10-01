// Role names for Figma layers (Card, Header, Title, PrimaryButton…), from plugin/lib/naming.ts.
// Syntax stays ES2017 (no ?. ?? object spread or optional catch binding): the sandbox parser is conservative.
import { inferRoles, type RoleNode } from "./naming";

const VECTORS = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"];

interface FigmaRole extends RoleNode {
  node: SceneNode;
}

function visiblePaints(list: any): Paint[] {
  if (!list || list === figma.mixed) return [];
  return list.filter(function (p: Paint) {
    return p.visible !== false && (p.opacity === undefined || p.opacity > 0);
  });
}

function vectorOnly(n: any): boolean {
  if (VECTORS.indexOf(n.type) !== -1) return true;
  if (n.type === "TEXT" || !("children" in n) || !n.children.length) return false;
  for (let i = 0; i < n.children.length; i++) if (n.children[i].visible !== false && !vectorOnly(n.children[i])) return false;
  return true;
}

function fontSizeOf(t: TextNode): number {
  if (typeof t.fontSize === "number") return t.fontSize;
  let max = 0;
  try {
    const segs = t.getStyledTextSegments(["fontSize"]);
    for (let i = 0; i < segs.length; i++) max = Math.max(max, segs[i].fontSize);
  } catch (e) {}
  return max || 14;
}

function describe(n: any, depth: number): FigmaRole {
  const fills = "fills" in n ? visiblePaints(n.fills) : [];
  const strokes = "strokes" in n ? visiblePaints(n.strokes) : [];
  const kids: any[] = "children" in n && n.type !== "TEXT" && depth < 12 ? n.children : [];
  const image = fills.length === 1 && fills[0].type === "IMAGE";
  let kind: RoleNode["kind"] = "shape";
  if (n.type === "TEXT") kind = "text";
  else if (vectorOnly(n)) kind = "vector";
  else if (image && !kids.length) kind = "image";
  else if (kids.length || (n.layoutMode && n.layoutMode !== "NONE")) kind = "frame";
  let radius = 0;
  if (typeof n.cornerRadius === "number") radius = n.cornerRadius;
  else if ("topLeftRadius" in n) radius = Math.max(n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius);
  const r: FigmaRole = {
    node: n,
    kind: kind,
    name: n.name,
    x: n.x || 0,
    y: n.y || 0,
    w: n.width || 0,
    h: n.height || 0,
    hidden: n.visible === false,
    background: fills.length > 0 || strokes.length > 0,
    radius: radius,
    ellipse: n.type === "ELLIPSE",
    clickable: !!(
      n.reactions &&
      n.reactions.some(function (x: any) {
        return x.trigger && (x.trigger.type === "ON_CLICK" || x.trigger.type === "ON_PRESS");
      })
    ),
    absolute: n.layoutPositioning === "ABSOLUTE",
    children: [],
  };
  if (n.type === "TEXT") {
    r.text = n.characters;
    r.fontSize = fontSizeOf(n);
  }
  if (n.layoutMode && n.layoutMode !== "NONE") r.layout = n.layoutMode;
  if (n.layoutWrap === "WRAP") r.wrap = true;
  if (kind !== "vector") {
    for (let i = 0; i < kids.length; i++) r.children.push(describe(kids[i], depth + 1));
  }
  return r;
}

/** Role names for the layers under `root` whose names say nothing, by node id. */
export function roleNames(root: SceneNode): { [id: string]: string } {
  const tree = describe(root, 0);
  inferRoles(tree);
  const out: { [id: string]: string } = {};
  const walk = function (r: FigmaRole) {
    if (r.role) out[r.node.id] = r.role;
    for (let i = 0; i < r.children.length; i++) walk(r.children[i] as FigmaRole);
  };
  walk(tree);
  return out;
}

/** Renames the layers under `root` that `rename` accepts (and Figma named) after their role. */
export function applyRoleNames(root: SceneNode, rename: (n: SceneNode) => boolean): number {
  const names = roleNames(root);
  let count = 0;
  const walk = function (n: any) {
    const role = names[n.id];
    if (role && rename(n) && n.name !== role) {
      n.name = role;
      count++;
    }
    // Layers inside instances belong to their component.
    if ("children" in n && n.type !== "INSTANCE") for (let i = 0; i < n.children.length; i++) walk(n.children[i]);
  };
  walk(root);
  return count;
}

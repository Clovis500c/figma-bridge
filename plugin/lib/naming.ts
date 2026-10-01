// Professional layer names from what a layer is and does: Header, Card, CardList, Title, PrimaryButton, Icon…
// Shared by build (unnamed layers), audit fix (default names) and export_roblox (Roblox instance names).
// Pure functions on a neutral description of the tree, so the plugin and the server can both use them.
// Syntax stays ES2017 (no ?. ?? object spread or optional catch binding): the sandbox parser is conservative.

export interface RoleNode {
  kind: "text" | "frame" | "image" | "vector" | "shape";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hidden?: boolean;
  text?: string;
  fontSize?: number;
  layout?: string;
  wrap?: boolean;
  /** A visible fill or stroke: the layer draws a background. */
  background?: boolean;
  radius?: number;
  ellipse?: boolean;
  clickable?: boolean;
  absolute?: boolean;
  children: RoleNode[];
  /** Set by inferRoles: a role name for layers whose name says nothing. */
  role?: string;
}

/** Figma's automatic names ("Frame 12", "Rectangle 3 copy", "Auto layout"): they say nothing about the layer. */
export const GENERIC_NAME =
  /^(frame|rectangle|ellipse|group|vector|text|line|polygon|star|component|instance|section|image|auto ?layout|union|subtract|intersect|exclude|boolean|layer|shape|slice|mask|container|wrapper|div|span|box)(\s*\d+)?(\s+copy(\s*\d+)?)?$/i;

/** True when the name was given by Figma, not by a person: a default name, or a text layer named after its text. */
export function isGenericName(n: RoleNode): boolean {
  const name = n.name.trim();
  if (!name || GENERIC_NAME.test(name)) return true;
  if (n.kind === "text" && n.text !== undefined) {
    const t = n.text.trim();
    const a = name.toLowerCase();
    const b = t.toLowerCase();
    return a === b || (a.length >= 12 && b.indexOf(a) === 0);
  }
  return false;
}

const NUMERIC = /^[\s$€£¥+\-−]*[\d][\d\s.,:%/×x+\-−]*[\s$€£¥%kKmMbB]*$/;
const SCREEN_W = [360, 375, 390, 393, 402, 412, 414, 428, 430, 440];

function visibleKids(n: RoleNode): RoleNode[] {
  return n.children.filter(function (c) {
    return !c.hidden;
  });
}

function maxFont(n: RoleNode): number {
  let m = n.kind === "text" && n.fontSize ? n.fontSize : 0;
  for (let i = 0; i < n.children.length; i++) {
    const c = n.children[i];
    if (c && !c.hidden) m = Math.max(m, maxFont(c));
  }
  return m;
}

function onlyKinds(list: RoleNode[], kinds: string[]): boolean {
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c && kinds.indexOf(c.kind) === -1) return false;
  }
  return list.length > 0;
}

/** Button look: a small filled or outlined layer holding a label (and maybe an icon). */
function buttonLike(n: RoleNode): boolean {
  const kids = visibleKids(n);
  if (!n.background || n.h > 72 || kids.length === 0 || kids.length > 3) return false;
  let texts = 0;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (!c) continue;
    if (c.kind === "text") {
      texts++;
      if ((c.text || "").length > 32) return false;
    } else if (c.kind !== "vector" && c.kind !== "image") return false;
  }
  return texts === 1;
}

/** Phone, tablet or desktop sized: its edges hold headers, footers and sidebars. */
function isScreen(n: RoleNode): boolean {
  return (SCREEN_W.indexOf(Math.round(n.w)) !== -1 && n.h >= 640) || (n.w >= 1024 && n.h >= 600);
}

function largestText(n: RoleNode, parent: RoleNode | null): boolean {
  const others = parent
    ? visibleKids(parent).filter(function (c) {
        return c !== n && c.kind === "text";
      })
    : [];
  const size = n.fontSize || 14;
  return (
    others.length > 0 &&
    others.every(function (c) {
      return (c.fontSize || 14) < size;
    })
  );
}

function covers(n: RoleNode, p: RoleNode): boolean {
  return Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1 && n.w >= p.w - 1 && n.h >= p.h - 1;
}

/** The role of a layer from its content, its look and its place in the parent; children are named first. */
function roleOf(n: RoleNode, parent: RoleNode | null, root: RoleNode, top: number, inButton: boolean): string {
  const kids = visibleKids(n);
  if (n.kind === "text") {
    const t = (n.text || "").trim();
    const size = n.fontSize || 14;
    if (inButton) return "Label";
    if (NUMERIC.test(t)) return "Value";
    if (size >= top - 0.5 && size >= 18) return "Title";
    // The largest text of a group (a card's name over its details) is that group's title.
    if (size >= 16 && largestText(n, parent)) return "Title";
    if (size >= 20) return "Heading";
    if (t.length > 60) return "Description";
    if (size <= 12) return "Caption";
    if (t.length > 30) return "Description";
    return "Label";
  }
  if (n.kind === "vector") return "Icon";
  if (n.kind === "image" && kids.length === 0) {
    const round = n.ellipse || (n.radius !== undefined && Math.abs(n.w - n.h) <= 1 && n.radius >= n.w / 2 - 1);
    return round ? "Avatar" : "Image";
  }
  if (kids.length === 0) {
    if (Math.min(n.w, n.h) <= 2 && Math.max(n.w, n.h) > 8) return "Divider";
    if (parent && covers(n, parent)) return "Background";
    if (n.clickable) return "Button";
    if (n.ellipse) return n.w <= 16 ? "Dot" : "Circle";
    return "Shape";
  }
  if (n.clickable) return "Button";
  if (buttonLike(n)) {
    // Small pills with a short caption are badges or tags, not buttons.
    const label = kids.filter(function (c) {
      return c.kind === "text";
    })[0];
    return n.h <= 24 || (label && (label.fontSize || 14) <= 12) ? "Badge" : "Button";
  }
  if (!parent) {
    if (isScreen(n)) return "Screen";
  } else if (parent === root && isScreen(root)) {
    // Bars along the edges of a screen.
    if (n.w >= root.w * 0.9 && n.y <= root.h * 0.1 && n.h <= root.h * 0.25) return "Header";
    if (n.w >= root.w * 0.9 && n.y + n.h >= root.h * 0.9 && n.h <= root.h * 0.25) return "Footer";
    if (n.h >= root.h * 0.9 && n.w <= root.w * 0.35 && n.x <= 1) return "Sidebar";
  }
  // Repeated children of one kind: a list or a grid of them.
  const flow = kids.filter(function (c) {
    return !c.absolute;
  });
  if (flow.length >= 2) {
    const r = baseName(flow[0] as RoleNode);
    const same = flow.every(function (c) {
      return baseName(c) === r;
    });
    if (same && r && r !== "Label" && r !== "Value" && r !== "Divider") {
      if (r === "Button") return "Actions";
      return r + (n.layout === "GRID" || n.wrap ? "Grid" : "List");
    }
  }
  if (n.background) return n.radius ? "Card" : "Panel";
  if (onlyKinds(kids, ["text"])) return "TextGroup";
  if (n.layout === "HORIZONTAL") return "Row";
  if (n.layout === "GRID") return "Grid";
  return "Container";
}

/** "Product card 2" → "ProductCard": the name siblings of one kind share. */
function baseName(n: RoleNode): string {
  return pascalName(n.role || n.name).replace(/\d+$/, "");
}

/** Fills `role` on every layer with a generic name, bottom-up (a parent's role depends on its children's). */
export function inferRoles(root: RoleNode): void {
  const top = maxFont(root);
  const walk = function (n: RoleNode, parent: RoleNode | null, inButton: boolean) {
    const button = n.kind !== "text" && (n.clickable || buttonLike(n) || /button|btn/i.test(n.name));
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (c) walk(c, n, inButton || button);
    }
    if (isGenericName(n)) n.role = roleOf(n, parent, root, top, inButton);
  };
  walk(root, null, false);
}

// ─── Name formatting ────────────────────────────────────────────────────────

/** "shop card" → "ShopCard", "Button/Primary/Large" → "PrimaryLargeButton", "icon/lucide:house" → "HouseIcon". */
export function pascalName(name: string): string {
  let segs = name
    .split("/")
    .map(function (s) {
      return s.replace(/^[\w-]+:/, "").trim();
    })
    .filter(function (s) {
      return s && !/^default$/i.test(s);
    });
  if (segs.length > 1) segs = segs.slice(1).concat([segs[0] as string]);
  const words = segs
    .join(" ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const out = words
    .map(function (w) {
      return w === w.toUpperCase() && w.length <= 4 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join("");
  return out.slice(0, 48);
}

/** Words that already say what a container is: no suffix needed after them. */
export const ROLE_WORDS = (
  "Actions Avatar Background Badge Banner Bar Body Button Card Column Container Content Controls Details Dialog Divider Footer Frame Grid Group Gui " +
  "Header Hero Hud HUD Info Item List Menu Modal Nav Navbar Navigation Overlay Panel Popup Row Screen Section Sidebar Slot Stack Stats Tab Tabs Tile " +
  "Toolbar Tooltip Window Wrapper"
).split(" ");

export function endsWithWord(name: string, words: string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (name.length >= w.length && name.slice(-w.length) === w) return true;
  }
  return false;
}

/** Numbers siblings that share a name: Card, Card → Card1, Card2. */
export function uniqueSiblingNames(names: string[]): string[] {
  const counts: { [name: string]: number } = {};
  for (let i = 0; i < names.length; i++) {
    const k = names[i] as string;
    counts[k] = (counts[k] || 0) + 1;
  }
  const seen: { [name: string]: number } = {};
  return names.map(function (k) {
    if ((counts[k] || 0) < 2) return k;
    seen[k] = (seen[k] || 0) + 1;
    return k + seen[k];
  });
}

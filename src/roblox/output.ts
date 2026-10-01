// export_roblox: writes the instance tree as a Roblox XML model (.rbxmx) and as a Luau builder script.
import type { RbxInstance, RbxValue } from "./map";

/** Enum item values used in .rbxmx files (token properties). */
const ENUMS: Record<string, Record<string, number>> = {
  ZIndexBehavior: { Global: 0, Sibling: 1 },
  FillDirection: { Horizontal: 0, Vertical: 1 },
  HorizontalAlignment: { Center: 0, Left: 1, Right: 2 },
  VerticalAlignment: { Center: 0, Top: 1, Bottom: 2 },
  SortOrder: { Name: 0, Custom: 1, LayoutOrder: 2 },
  UIFlexAlignment: { None: 0, Fill: 1, SpaceAround: 2, SpaceBetween: 3, SpaceEvenly: 4 },
  UIFlexMode: { None: 0, Grow: 1, Shrink: 2, Fill: 3, Custom: 4 },
  AutomaticSize: { None: 0, X: 1, Y: 2, XY: 3 },
  TextXAlignment: { Left: 0, Right: 1, Center: 2 },
  TextYAlignment: { Top: 0, Center: 1, Bottom: 2 },
  ScaleType: { Stretch: 0, Slice: 1, Tile: 2, Fit: 3, Crop: 4 },
  ApplyStrokeMode: { Contextual: 0, Border: 1 },
  LineJoinMode: { Round: 0, Bevel: 1, Miter: 2 },
  TextTruncate: { None: 0, AtEnd: 1, SplitWord: 2 },
};

const n = (v: number) => String(Math.round(v * 1000) / 1000);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function xmlProp(name: string, v: RbxValue): string {
  switch (v.t) {
    case "string":
      return `<string name="${name}">${xml(v.v)}</string>`;
    case "bool":
      return `<bool name="${name}">${v.v}</bool>`;
    case "int":
      return `<int name="${name}">${v.v}</int>`;
    case "float":
      return `<float name="${name}">${n(v.v)}</float>`;
    case "Color3":
      return `<Color3 name="${name}"><R>${n(v.r)}</R><G>${n(v.g)}</G><B>${n(v.b)}</B></Color3>`;
    case "UDim":
      return `<UDim name="${name}"><S>${n(v.s)}</S><O>${v.o}</O></UDim>`;
    case "UDim2":
      return `<UDim2 name="${name}"><XS>${n(v.xs)}</XS><XO>${v.xo}</XO><YS>${n(v.ys)}</YS><YO>${v.yo}</YO></UDim2>`;
    case "Vector2":
      return `<Vector2 name="${name}"><X>${n(v.x)}</X><Y>${n(v.y)}</Y></Vector2>`;
    case "Rect":
      return `<Rect2D name="${name}"><min><X>${n(v.x0)}</X><Y>${n(v.y0)}</Y></min><max><X>${n(v.x1)}</X><Y>${n(v.y1)}</Y></max></Rect2D>`;
    case "enum": {
      const value = ENUMS[v.e]?.[v.v];
      if (value === undefined) throw new Error(`No enum value for ${v.e}.${v.v}`);
      return `<token name="${name}">${value}</token>`;
    }
    case "Content":
      return v.url ? `<Content name="${name}"><url>${xml(v.url)}</url></Content>` : `<Content name="${name}"><null></null></Content>`;
    case "ColorSequence":
      return `<ColorSequence name="${name}">${v.keys.map((k) => `${n(k.time)} ${n(k.r)} ${n(k.g)} ${n(k.b)} 0 `).join("")}</ColorSequence>`;
    case "NumberSequence":
      return `<NumberSequence name="${name}">${v.keys.map((k) => `${n(k.time)} ${n(k.value)} 0 `).join("")}</NumberSequence>`;
    case "Font":
      return `<Font name="${name}"><Family><url>${xml(v.family)}</url></Family><Weight>${v.weight}</Weight><Style>${v.style}</Style></Font>`;
  }
}

/** A Roblox XML model: drag it into Studio (or Insert from File) to get the hierarchy. */
export function toRbxmx(root: RbxInstance): string {
  let ref = 0;
  const item = (i: RbxInstance, depth: number): string => {
    const pad = "\t".repeat(depth);
    const props = i.props.map(([k, v]) => `${pad}\t\t${xmlProp(k, v)}`).join("\n");
    const kids = i.children.map((c) => item(c, depth + 1)).join("\n");
    return `${pad}<Item class="${i.className}" referent="RBX${(ref++).toString(16).toUpperCase().padStart(8, "0")}">\n${pad}\t<Properties>\n${props}\n${pad}\t</Properties>${kids ? `\n${kids}` : ""}\n${pad}</Item>`;
  };
  return (
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">\n' +
    "\t<External>null</External>\n\t<External>nil</External>\n" +
    item(root, 1) +
    "\n</roblox>\n"
  );
}

// ─── Luau ─────────────────────────────────────────────────────────────────────

const KEYWORDS = new Set(["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while", "continue", "export", "type", "game", "workspace", "script", "PARENT", "existing"]);

/** A Luau string literal; non-ASCII stays as-is (Luau strings are bytes, the file is UTF-8). */
export function luauString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => `\\${c.charCodeAt(0)}`)}"`;
}

const rgb = (v: number) => Math.round(v * 255);

function luauValue(v: RbxValue): string {
  switch (v.t) {
    case "string":
      return luauString(v.v);
    case "bool":
      return String(v.v);
    case "int":
      return String(v.v);
    case "float":
      return n(v.v);
    case "Color3":
      return `Color3.fromRGB(${rgb(v.r)}, ${rgb(v.g)}, ${rgb(v.b)})`;
    case "UDim":
      return `UDim.new(${n(v.s)}, ${v.o})`;
    case "UDim2":
      if (!v.xo && !v.yo) return `UDim2.fromScale(${n(v.xs)}, ${n(v.ys)})`;
      if (!v.xs && !v.ys) return `UDim2.fromOffset(${v.xo}, ${v.yo})`;
      return `UDim2.new(${n(v.xs)}, ${v.xo}, ${n(v.ys)}, ${v.yo})`;
    case "Vector2":
      return `Vector2.new(${n(v.x)}, ${n(v.y)})`;
    case "Rect":
      return `Rect.new(${n(v.x0)}, ${n(v.y0)}, ${n(v.x1)}, ${n(v.y1)})`;
    case "enum":
      return `Enum.${v.e}.${v.v}`;
    case "Content":
      return luauString(v.url);
    case "ColorSequence":
      return `ColorSequence.new({\n${v.keys.map((k) => `\t\tColorSequenceKeypoint.new(${n(k.time)}, Color3.fromRGB(${rgb(k.r)}, ${rgb(k.g)}, ${rgb(k.b)})),`).join("\n")}\n\t})`;
    case "NumberSequence":
      return `NumberSequence.new({\n${v.keys.map((k) => `\t\tNumberSequenceKeypoint.new(${n(k.time)}, ${n(k.value)}),`).join("\n")}\n\t})`;
    case "Font":
      return `Font.new(${luauString(v.family)}, Enum.FontWeight.${v.weightName}, Enum.FontStyle.${v.style})`;
  }
}

function identifier(name: string, className: string, used: Set<string>): string {
  const words = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 5);
  let id = words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("");
  if (!id || /^\d/.test(id)) id = className[0]!.toLowerCase() + className.slice(1) + (id ? id[0]!.toUpperCase() + id.slice(1) : "");
  if (KEYWORDS.has(id)) id += "Gui";
  let unique = id;
  for (let k = 2; used.has(unique); k++) unique = `${id}${k}`;
  used.add(unique);
  return unique;
}

export interface LuauOptions {
  /** Expression for the parent, default: the StarterGui service. */
  parent?: string;
  /** Header comment: where the design came from. */
  source?: string;
}

/**
 * A builder script for Studio's command bar or an execute_luau tool: creates the hierarchy under PARENT and
 * returns its root. Running it again replaces the previous copy (same name under the same parent).
 */
export function toLuau(root: RbxInstance, opts: LuauOptions = {}): string {
  const used = new Set<string>();
  const lines: string[] = [];
  const emit = (i: RbxInstance, parentVar: string | null, depth: number) => {
    const v = identifier(i.name, i.className, used);
    // Visual layers get a heading; modifiers (UICorner, UIStroke…) stay with their owner.
    if (!/^UI/.test(i.className) && depth <= 2 && parentVar) lines.push("", `-- ${i.name.replace(/\n/g, " ")}`);
    lines.push(`local ${v} = Instance.new(${luauString(i.className)})`);
    for (const [k, val] of i.props) lines.push(`${v}.${k} = ${luauValue(val)}`);
    for (const c of i.children) emit(c, v, depth + 1);
    if (parentVar) lines.push(`${v}.Parent = ${parentVar}`);
    return v;
  };
  const header = [
    `-- ${root.name}: generated by Figma Bridge${opts.source ? ` from "${opts.source.replace(/\n/g, " ")}"` : ""} (export_roblox).`,
    "-- Creates the UI under PARENT and returns it. Running it again replaces the previous copy.",
    `local PARENT = ${opts.parent ?? 'game:GetService("StarterGui")'}`,
    "",
    `local existing = PARENT:FindFirstChild(${luauString(root.name)})`,
    "if existing then",
    "\texisting:Destroy()",
    "end",
    "",
  ];
  const rootVar = emit(root, null, 0);
  return `${header.join("\n")}\n${lines.join("\n")}\n\n${rootVar}.Parent = PARENT\nreturn ${rootVar}\n`.replace(/\n{3,}/g, "\n\n");
}

/** Replaces asset placeholders (rbxassetid://PENDING_3) with uploaded ids. */
export function substituteAssets(text: string, ids: Record<string, string>): string {
  return text.replace(/rbxassetid:\/\/PENDING_\d+/g, (m) => (ids[m] ? `rbxassetid://${ids[m]}` : m));
}

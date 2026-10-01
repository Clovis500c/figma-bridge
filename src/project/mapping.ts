// export_code projectPath: maps Figma instances to the project's components, by name and props,
// or as figma-bridge.map.json says.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentUse } from "../codegen";
import type { CodeComponent, PropInfo } from "./components";
import { importPath, type Stack } from "./detect";

export interface FigmaInstance {
  /** Main component name; for a variant, the name of its component set. */
  name: string;
  props: Record<string, string | boolean>;
  /** First text inside the instance (a label when the component takes children). */
  text?: string;
}

export interface MapEntry {
  /** Import path of the code component (default: from the index). */
  import?: string;
  /** Code component name (default: the Figma name). */
  name?: string;
  default?: boolean;
  /** Figma property → code prop name, or {prop, values: {FigmaValue: codeValue}}; "children" puts a text property inside. */
  props?: Record<string, string | { prop: string; values?: Record<string, string | boolean> }>;
  /** Skip this component: always generate its layers. */
  ignore?: boolean;
}

export interface MapFile {
  components?: Record<string, MapEntry>;
}

export const MAP_FILE = "figma-bridge.map.json";

export function loadMapFile(root: string): { map: MapFile; path?: string; error?: string } {
  const path = join(root, MAP_FILE);
  if (!existsSync(path)) return { map: {} };
  try {
    return { map: JSON.parse(readFileSync(path, "utf8")) as MapFile, path };
  } catch (e) {
    return { map: {}, error: `${MAP_FILE} is not valid JSON: ${(e as Error).message}` };
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "Buttons/Primary Button" → "primarybutton"; "Button/Primary" (a path) keeps "button". */
function figmaKeys(name: string): string[] {
  const parts = name.split("/").map((p) => p.trim()).filter(Boolean);
  return [...new Set([norm(name), norm(parts[parts.length - 1] ?? name), norm(parts[0] ?? name)])].filter(Boolean);
}

const SYNONYMS: string[][] = [
  ["primary", "default", "solid", "contained", "filled", "main"],
  ["secondary", "subtle", "soft", "tonal"],
  ["outline", "outlined", "bordered", "stroke"],
  ["ghost", "text", "plain", "transparent", "tertiary"],
  ["destructive", "danger", "error", "critical", "negative"],
  ["link", "inline"],
  ["sm", "small", "s", "compact"],
  ["md", "medium", "m", "default", "regular", "base"],
  ["lg", "large", "l", "big"],
  ["xs", "extrasmall", "tiny"],
  ["xl", "extralarge", "huge"],
  ["icon", "iconly", "icononly"],
];

/** The option of a code prop that means the same as a Figma value. */
export function matchValue(figma: string, options: string[]): string | null {
  const v = norm(figma);
  const exact = options.find((o) => norm(o) === v);
  if (exact) return exact;
  for (const group of SYNONYMS) {
    if (!group.includes(v)) continue;
    const hit = options.find((o) => group.includes(norm(o)));
    if (hit) return hit;
  }
  return null;
}

/** Figma property names that usually mean "variant". */
const VARIANT_ALIASES = ["variant", "type", "style", "kind", "appearance", "intent", "hierarchy", "emphasis", "color"];
const STATE_PROPS = /^(state|status|interaction|hover|pressed|focus(ed)?)$/i;
const LABEL_PROPS = /^(label|text|title|content|value|children|caption|name)$/i;

function findProp(props: PropInfo[], figmaName: string): PropInfo | undefined {
  const k = norm(figmaName);
  const direct = props.find((p) => norm(p.name) === k || norm(p.name) === k.replace(/^(show|has|is|with)/, ""));
  if (direct) return direct;
  if (VARIANT_ALIASES.includes(k)) return props.find((p) => p.name === "variant") ?? props.find((p) => VARIANT_ALIASES.includes(norm(p.name)));
  return undefined;
}

export interface MatchResult {
  use: ComponentUse;
  component?: CodeComponent;
  dropped: string[];
}

export class ComponentMatcher {
  readonly unmatched = new Map<string, number>();
  readonly matched = new Map<string, string>();
  readonly notes: string[] = [];

  constructor(
    private stack: Stack,
    private index: CodeComponent[],
    private map: MapFile,
    /** Project file that will import the components (for relative paths). */
    private fromFile: string,
  ) {}

  private find(inst: FigmaInstance): { entry?: MapEntry; component?: CodeComponent } | null {
    const entries = this.map.components ?? {};
    const keys = figmaKeys(inst.name);
    const entryKey = Object.keys(entries).find((k) => k === inst.name || keys.includes(norm(k)));
    const entry = entryKey !== undefined ? entries[entryKey] : undefined;
    if (entry?.ignore) return null;
    const wanted = entry?.name ? [norm(entry.name)] : keys;
    let candidates = this.index.filter((c) => wanted.includes(norm(c.name)));
    // No exact name: a prefixed one ("AppButton", "UserAvatar" for "Button", "Avatar").
    if (!candidates.length && !entry?.name) candidates = this.index.filter((c) => keys.some((k) => k.length >= 4 && (norm(c.name).endsWith(k) || norm(c.name).startsWith(k))));
    // Several candidates: prefer the one whose props cover the Figma properties.
    const score = (c: CodeComponent) =>
      Object.keys(inst.props).filter((p) => findProp(c.props, p)).length + (c.source === "project" || c.source === "shadcn" ? 0.5 : 0) + (wanted.includes(norm(c.name)) ? 10 : 0);
    const component = candidates.sort((a, b) => score(b) - score(a))[0];
    if (!component && !entry?.import) return null;
    return { entry, component };
  }

  match(inst: FigmaInstance): MatchResult | null {
    const found = this.find(inst);
    if (!found) {
      this.unmatched.set(inst.name, (this.unmatched.get(inst.name) ?? 0) + 1);
      return null;
    }
    const { entry, component } = found;
    const name = entry?.name ?? component!.name;
    const importFrom = entry?.import ?? (component!.source === "mui" || component!.source === "chakra" ? component!.file : importPath(this.stack, component!.file, this.fromFile));
    const isDefault = entry?.default ?? component?.exportKind === "default";
    const codeProps = component?.props ?? [];
    const props: [string, string | boolean][] = [];
    const dropped: string[] = [];
    let children: string | undefined;
    for (const [figmaProp, value] of Object.entries(inst.props)) {
      const rule = entry?.props?.[figmaProp];
      if (rule !== undefined) {
        const target = typeof rule === "string" ? rule : rule.prop;
        const mapped = typeof rule === "object" && rule.values && typeof value === "string" && rule.values[value] !== undefined ? rule.values[value]! : value;
        if (target === "children") children = String(mapped);
        else props.push([target, mapped]);
        continue;
      }
      if (STATE_PROPS.test(figmaProp) && typeof value === "string" && /^(default|rest|enabled|normal|hover|pressed|active|focus(ed)?)$/i.test(value)) continue;
      const p = findProp(codeProps, figmaProp);
      if (typeof value === "boolean") {
        if (p && /bool/.test(p.type || "boolean")) {
          if (value !== false || !p.optional) props.push([p.name, value]);
        } else if (STATE_PROPS.test(figmaProp) || /^disabled$/i.test(figmaProp)) {
          const d = codeProps.find((x) => x.name === "disabled");
          if (d && value) props.push(["disabled", true]);
        } else dropped.push(figmaProp);
        continue;
      }
      if (p?.values?.length) {
        const v = matchValue(value, p.values);
        if (v === null) dropped.push(`${figmaProp}=${value}`);
        // The default option needs no prop.
        else if (!(p.optional && /^default$/i.test(v))) props.push([p.name, v]);
        continue;
      }
      if (/^disabled$/i.test(value) && codeProps.some((x) => x.name === "disabled")) {
        props.push(["disabled", true]);
        continue;
      }
      if (p && p.name !== "children") {
        props.push([p.name, value]);
        continue;
      }
      if ((LABEL_PROPS.test(figmaProp) || p?.name === "children") && component?.children !== false) {
        children = value;
        continue;
      }
      dropped.push(`${figmaProp}=${value}`);
    }
    if (children === undefined && inst.text && (component?.children ?? true) && !props.some(([k]) => LABEL_PROPS.test(k))) children = inst.text;
    this.matched.set(inst.name, `${name} (${importFrom})`);
    if (dropped.length) this.notes.push(`${inst.name}: no code prop for ${dropped.join(", ")}`);
    return { use: { name, importFrom, isDefault: !!isDefault, props, children }, component, dropped };
  }
}

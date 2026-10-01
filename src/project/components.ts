// export_code projectPath: an index of the project's components with their props, read from the
// source (TypeScript prop types, shadcn's cva variants, Vue defineProps, Svelte props). Nothing is executed.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { listFiles, type Stack } from "./detect";

export interface PropInfo {
  name: string;
  type: string;
  optional: boolean;
  /** String literal options: variant?: "primary" | "ghost". */
  values?: string[];
}

export interface CodeComponent {
  name: string;
  /** Project-relative file, or a package name for library components. */
  file: string;
  exportKind: "default" | "named";
  props: PropInfo[];
  source: "project" | "shadcn" | "mui" | "chakra";
  /** Accepts children (React children, Vue/Svelte default slot). */
  children: boolean;
}

const COMPONENT_DIRS = /(^|\/)(components?|ui|lib\/components|app\/components|src\/components|widgets|elements|design-system)(\/|$)/i;

/** Text of the balanced block starting at the opening bracket at `start`. */
function block(text: string, start: number, open = "{", close = "}"): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (!depth) return text.slice(start + 1, i);
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const end = text.indexOf(ch, i + 1);
      if (end > 0) i = end;
    }
  }
  return text.slice(start + 1);
}

/** Splits on separators that are not nested in brackets or strings. */
function splitTop(body: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = "";
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("{[(<".includes(ch)) depth++;
    else if ("}])>".includes(ch)) depth--;
    if (depth === 0 && seps.includes(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const literals = (type: string): string[] | undefined => {
  const parts = splitTop(type, "|").map((p) => p.trim());
  if (!parts.length || !parts.every((p) => /^(["'`]).*\1$/.test(p) || p === "undefined" || p === "null")) return undefined;
  const vals = parts.filter((p) => /^["'`]/.test(p)).map((p) => p.slice(1, -1));
  return vals.length ? vals : undefined;
};

/** Members of a TS object type body: `a?: string; b: "x" | "y"`. */
export function parseMembers(body: string): PropInfo[] {
  const out: PropInfo[] = [];
  for (const m of splitTop(body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""), ";,\n")) {
    const mm = /^(?:readonly\s+)?["']?([\w$-]+)["']?(\?)?\s*:\s*([\s\S]+)$/.exec(m.trim());
    if (!mm) continue;
    const type = mm[3]!.trim();
    out.push({ name: mm[1]!, type, optional: !!mm[2], values: literals(type) });
  }
  return out;
}

/** cva("…", { variants: { variant: { default: "…", ghost: "…" }, size: {…} } }) → props with options. */
export function cvaVariants(src: string): PropInfo[] {
  const out: PropInfo[] = [];
  const at = src.search(/variants\s*:\s*\{/);
  if (at < 0) return out;
  const body = block(src, src.indexOf("{", at));
  const re = /["']?([\w-]+)["']?\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const inner = block(body, m.index + m[0].length - 1);
    // Only the first-level keys of each variant object.
    const keys: string[] = [];
    for (const part of splitTop(inner, ",")) {
      const k = /^["']?([\w-]+)["']?\s*:/.exec(part.trim());
      if (k) keys.push(k[1]!);
    }
    out.push({ name: m[1]!, type: keys.map((x) => JSON.stringify(x)).join(" | "), optional: true, values: keys });
    re.lastIndex = m.index + m[0].length + inner.length;
  }
  return out;
}

function propsTypeOf(src: string, name: string): PropInfo[] {
  const candidates = [`${name}Props`, "Props"];
  for (const t of candidates) {
    const iface = new RegExp(`(?:interface|type)\\s+${t}\\b[^={]*?(=\\s*)?\\{`).exec(src);
    if (iface) return parseMembers(block(src, iface.index + iface[0].length - 1));
  }
  // Inline: function Button({ a, b }: { a: string; b?: number })
  const inline = new RegExp(`function\\s+${name}\\s*\\(\\s*\\{[^}]*\\}\\s*:\\s*\\{`).exec(src);
  if (inline) return parseMembers(block(src, inline.index + inline[0].length - 1));
  return [];
}

function reactComponents(file: string, src: string): CodeComponent[] {
  const names = new Map<string, "default" | "named">();
  const re = /export\s+(default\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Z][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) names.set(m[2]!, m[1] ? "default" : "named");
  const list = /export\s*\{([^}]+)\}/g;
  while ((m = list.exec(src))) {
    for (const part of m[1]!.split(",")) {
      const [local, as] = part.trim().split(/\s+as\s+/);
      const exported = (as ?? local ?? "").trim();
      if (/^[A-Z]/.test(exported)) names.set(exported, "named");
      if (exported === "default" && local && /^[A-Z]/.test(local.trim())) names.set(local.trim(), "default");
    }
  }
  const def = /export\s+default\s+([A-Z][\w$]*)\s*;?/.exec(src);
  if (def) names.set(def[1]!, "default");
  // A component returns JSX: skip exported helpers, contexts and types.
  if (!/<[A-Za-z]/.test(src)) return [];
  const variants = /\bcva\s*\(/.test(src) ? cvaVariants(src) : [];
  const out: CodeComponent[] = [];
  for (const [name, exportKind] of names) {
    if (/(Context|Provider|Props|Variants|Type)$/.test(name) && name !== "Provider") continue;
    const props = propsTypeOf(src, name);
    for (const v of variants) if (!props.some((p) => p.name === v.name)) props.push(v);
    const children = props.some((p) => p.name === "children") || /\bchildren\b/.test(src) || /ButtonHTMLAttributes|HTMLAttributes|ComponentProps(WithoutRef)?<|PropsWithChildren/.test(src);
    out.push({ name, file, exportKind, props, source: "project", children });
  }
  return out;
}

function vueComponent(file: string, src: string): CodeComponent[] {
  const name = basename(file, ".vue").replace(/(^|[-_])(\w)/g, (_, __, c: string) => c.toUpperCase());
  let props: PropInfo[] = [];
  const typed = /defineProps\s*<\s*\{/.exec(src);
  if (typed) props = parseMembers(block(src, typed.index + typed[0].length - 1));
  else {
    const named = /defineProps\s*<\s*(\w+)\s*>/.exec(src);
    if (named) props = propsTypeOf(src.replace(new RegExp(`\\b${named[1]}\\b`), "Props"), "__");
    const obj = /defineProps\s*\(\s*\{/.exec(src) ?? /props\s*:\s*\{/.exec(src);
    if (!props.length && obj) {
      for (const part of splitTop(block(src, obj.index + obj[0].length - 1), ",")) {
        const m = /^["']?([\w-]+)["']?\s*:\s*([\s\S]+)$/.exec(part.trim());
        if (!m) continue;
        const required = /required\s*:\s*true/.test(m[2]!);
        const t = /type\s*:\s*(\w+)/.exec(m[2]!)?.[1] ?? m[2]!.trim();
        props.push({ name: m[1]!, type: t.toLowerCase(), optional: !required });
      }
    }
  }
  return [{ name, file, exportKind: "default", props, source: "project", children: /<slot[\s/>]/.test(src) }];
}

function svelteComponent(file: string, src: string): CodeComponent[] {
  const name = basename(file, ".svelte").replace(/(^|[-_])(\w)/g, (_, __, c: string) => c.toUpperCase());
  const props: PropInfo[] = [];
  // Svelte 5: let { a, b = 1 }: Props = $props();  Svelte 4: export let a: T = …;
  const runes = /let\s*\{([^}]*)\}\s*(?::\s*(\w+))?\s*=\s*\$props\(\)/.exec(src);
  if (runes) {
    const typed = runes[2] ? propsTypeOf(src.replace(new RegExp(`\\b${runes[2]}\\b`), "Props"), "__") : [];
    for (const part of splitTop(runes[1]!, ",")) {
      const m = /^([\w$]+)(\s*=)?/.exec(part.trim());
      if (!m || m[1] === "children") continue;
      const t = typed.find((p) => p.name === m[1]);
      props.push(t ?? { name: m[1]!, type: "unknown", optional: !!m[2] });
    }
  }
  const re = /export\s+let\s+([\w$]+)\s*(?::\s*([^=;]+))?(=)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) props.push({ name: m[1]!, type: (m[2] ?? "unknown").trim(), optional: !!m[3], values: m[2] ? literals(m[2]) : undefined });
  return [{ name, file, exportKind: "default", props, source: "project", children: /<slot[\s/>]|\{@render\s+children/.test(src) }];
}

/** Library components agents commonly map to (props limited to the ones a design maps to). */
const LIBRARIES: Record<string, Omit<CodeComponent, "file" | "exportKind" | "source">[]> = {
  mui: [
    { name: "Button", props: [{ name: "variant", type: "", optional: true, values: ["text", "outlined", "contained"] }, { name: "size", type: "", optional: true, values: ["small", "medium", "large"] }, { name: "color", type: "", optional: true, values: ["primary", "secondary", "error", "warning", "info", "success", "inherit"] }, { name: "disabled", type: "boolean", optional: true }], children: true },
    { name: "TextField", props: [{ name: "label", type: "string", optional: true }, { name: "placeholder", type: "string", optional: true }, { name: "variant", type: "", optional: true, values: ["outlined", "filled", "standard"] }, { name: "size", type: "", optional: true, values: ["small", "medium"] }], children: false },
    { name: "Chip", props: [{ name: "label", type: "string", optional: true }, { name: "variant", type: "", optional: true, values: ["filled", "outlined"] }, { name: "color", type: "", optional: true, values: ["default", "primary", "secondary", "error", "success"] }], children: false },
    { name: "Avatar", props: [{ name: "src", type: "string", optional: true }, { name: "alt", type: "string", optional: true }], children: true },
    { name: "Switch", props: [{ name: "checked", type: "boolean", optional: true }, { name: "disabled", type: "boolean", optional: true }], children: false },
    { name: "Checkbox", props: [{ name: "checked", type: "boolean", optional: true }, { name: "disabled", type: "boolean", optional: true }], children: false },
    { name: "Card", props: [{ name: "variant", type: "", optional: true, values: ["elevation", "outlined"] }], children: true },
  ],
  chakra: [
    { name: "Button", props: [{ name: "variant", type: "", optional: true, values: ["solid", "outline", "ghost", "link", "subtle", "surface", "plain"] }, { name: "size", type: "", optional: true, values: ["xs", "sm", "md", "lg", "xl"] }, { name: "colorPalette", type: "string", optional: true }, { name: "disabled", type: "boolean", optional: true }], children: true },
    { name: "Input", props: [{ name: "placeholder", type: "string", optional: true }, { name: "size", type: "", optional: true, values: ["xs", "sm", "md", "lg"] }, { name: "variant", type: "", optional: true, values: ["outline", "subtle", "flushed"] }], children: false },
    { name: "Badge", props: [{ name: "variant", type: "", optional: true, values: ["solid", "subtle", "outline", "surface", "plain"] }, { name: "colorPalette", type: "string", optional: true }], children: true },
    { name: "Avatar", props: [{ name: "name", type: "string", optional: true }, { name: "src", type: "string", optional: true }], children: false },
    { name: "Switch", props: [{ name: "checked", type: "boolean", optional: true }, { name: "disabled", type: "boolean", optional: true }], children: true },
    { name: "Checkbox", props: [{ name: "checked", type: "boolean", optional: true }, { name: "disabled", type: "boolean", optional: true }], children: true },
  ],
};
const LIBRARY_PACKAGES: Record<string, string> = { mui: "@mui/material", chakra: "@chakra-ui/react" };

export function indexComponents(stack: Stack, max = 400): CodeComponent[] {
  const exts = stack.framework === "vue" ? /\.vue$/ : stack.framework === "svelte" ? /\.svelte$/ : /\.(tsx|jsx)$/;
  const files = listFiles(stack.root, (f) => exts.test(f) && COMPONENT_DIRS.test(f) && !/\.(test|spec|stories)\./.test(f), max);
  const out: CodeComponent[] = [];
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(join(stack.root, file), "utf8");
    } catch {
      continue;
    }
    if (src.length > 200_000) continue;
    const found = stack.framework === "vue" ? vueComponent(file, src) : stack.framework === "svelte" ? svelteComponent(file, src) : reactComponents(file, src);
    for (const c of found) out.push(stack.ui.includes("shadcn") && /components\/ui\//.test(file) ? { ...c, source: "shadcn" } : c);
  }
  for (const lib of stack.ui) {
    for (const c of LIBRARIES[lib] ?? []) {
      if (!out.some((o) => o.name === c.name)) out.push({ ...c, file: LIBRARY_PACKAGES[lib]!, exportKind: "named", source: lib as CodeComponent["source"] });
    }
  }
  return out;
}

// export_code projectPath: reads package.json and config files to find the framework, the styling
// approach, the UI libraries, path aliases and where components and assets belong.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Framework = "html" | "react" | "vue" | "svelte" | "react-native";
export type Styling = "css" | "tailwind" | "css-modules" | "styled-components";

export interface Stack {
  root: string;
  /** What the project is built with, e.g. "next", "vite", "nuxt", "sveltekit", "expo". */
  kind: string;
  framework: Framework;
  styling: Styling;
  tailwind?: 3 | 4;
  ui: string[];
  typescript: boolean;
  /** Import aliases: "@/" → "src/". */
  aliases: { prefix: string; target: string }[];
  componentsDir: string;
  /** Where images go, and how code refers to them (public URL or import). */
  assets: { dir: string; url?: string };
  /** CSS files that may define design tokens. */
  cssFiles: string[];
  tailwindConfig?: string;
  evidence: string[];
}

const IGNORE = new Set(["node_modules", ".git", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out", ".output", "coverage", ".turbo", ".vercel", "android", "ios"]);

/** Files under root (relative paths, forward slashes), skipping build folders; capped. */
export function listFiles(root: string, filter: (rel: string) => boolean, max = 4000): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= max || depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (IGNORE.has(name) || (name.startsWith(".") && name !== ".storybook")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else {
        const rel = relative(root, full).split(sep).join("/");
        if (filter(rel)) out.push(rel);
      }
      if (out.length >= max) return;
    }
  };
  walk(root, 0);
  return out;
}

/** JSON with comments and trailing commas (tsconfig, components.json). */
export function readJsonc(path: string): any {
  try {
    const text = readFileSync(path, "utf8")
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const major = (range: string | undefined) => {
  const m = /(\d+)/.exec(range ?? "");
  return m ? Number(m[1]) : undefined;
};

export function detectStack(root: string): Stack {
  const pkg = readJsonc(join(root, "package.json"));
  if (!pkg) throw new Error(`No package.json in ${root}: give the root folder of a JavaScript project as projectPath.`);
  const deps: Record<string, string> = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies };
  const has = (d: string) => deps[d] !== undefined;
  const at = (...p: string[]) => existsSync(join(root, ...p));
  const evidence: string[] = [];

  let kind = "html";
  let framework: Framework = "html";
  if (has("react-native") || has("expo")) [kind, framework] = [has("expo") ? "expo" : "react-native", "react-native"];
  else if (has("next")) [kind, framework] = ["next", "react"];
  else if (has("nuxt")) [kind, framework] = ["nuxt", "vue"];
  else if (has("vue")) [kind, framework] = ["vue", "vue"];
  else if (has("@sveltejs/kit")) [kind, framework] = ["sveltekit", "svelte"];
  else if (has("svelte")) [kind, framework] = ["svelte", "svelte"];
  else if (has("react")) [kind, framework] = [has("vite") ? "vite" : "react", "react"];
  evidence.push(`framework: ${kind}`);

  const tailwindConfig = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs"].find((f) => at(f));
  let tailwind: 3 | 4 | undefined;
  if (has("tailwindcss") || has("nativewind")) {
    const v = major(deps.tailwindcss);
    tailwind = has("@tailwindcss/postcss") || has("@tailwindcss/vite") || (v !== undefined && v >= 4) ? 4 : 3;
    evidence.push(`tailwindcss ${tailwind}${tailwindConfig ? ` (${tailwindConfig})` : ""}`);
  }
  const sourceFiles = listFiles(root, (f) => /\.(module\.(css|scss)|css|tsx|jsx|ts|js|vue|svelte)$/.test(f), 3000);
  let styling: Styling = "css";
  if (tailwind && (framework !== "react-native" || has("nativewind"))) styling = "tailwind";
  else if (has("styled-components") || has("@emotion/styled")) styling = "styled-components";
  else if (sourceFiles.some((f) => /\.module\.(css|scss)$/.test(f))) styling = "css-modules";
  evidence.push(`styling: ${styling}`);

  const ui: string[] = [];
  const shadcn = readJsonc(join(root, "components.json"));
  if (shadcn?.aliases || (has("class-variance-authority") && sourceFiles.some((f) => /components\/ui\/button\.(t|j)sx$/.test(f)))) ui.push("shadcn");
  if (has("@mui/material")) ui.push("mui");
  if (has("@chakra-ui/react")) ui.push("chakra");
  if (ui.length) evidence.push(`ui: ${ui.join(", ")}`);

  const tsconfig = readJsonc(join(root, "tsconfig.json")) ?? readJsonc(join(root, "jsconfig.json"));
  const typescript = at("tsconfig.json") || has("typescript");
  const aliases: Stack["aliases"] = [];
  const paths = tsconfig?.compilerOptions?.paths ?? {};
  const baseUrl = String(tsconfig?.compilerOptions?.baseUrl ?? ".");
  for (const [key, targets] of Object.entries(paths)) {
    const target = Array.isArray(targets) ? String(targets[0]) : "";
    if (!key.endsWith("/*") || !target.endsWith("/*")) continue;
    const t = join(baseUrl, target.slice(0, -2)).split(sep).join("/").replace(/^\.\//, "");
    aliases.push({ prefix: key.slice(0, -1), target: t === "." ? "" : `${t}/` });
  }
  if (kind === "nuxt" && !aliases.length) aliases.push({ prefix: "~/", target: "" });
  if (kind === "sveltekit") aliases.push({ prefix: "$lib/", target: "src/lib/" });

  const resolveAlias = (spec: string) => {
    for (const a of aliases) if (spec.startsWith(a.prefix)) return a.target + spec.slice(a.prefix.length);
    return spec;
  };
  const componentsDir = shadcn?.aliases?.components
    ? resolveAlias(String(shadcn.aliases.components)).replace(/\/$/, "")
    : kind === "sveltekit"
      ? "src/lib/components"
      : at("src")
        ? "src/components"
        : "components";
  const assets =
    kind === "next" || kind === "nuxt"
      ? { dir: "public/figma", url: "/figma" }
      : kind === "sveltekit"
        ? { dir: "static/figma", url: "/figma" }
        : { dir: at("src") && framework !== "react-native" ? "src/assets/figma" : "assets/figma" };

  const cssFiles = sourceFiles.filter((f) => /\.css$/.test(f) && !/\.module\.css$/.test(f) && /(global|index|app|main|theme|token|variables|style)/i.test(f)).slice(0, 12);
  return { root, kind, framework, styling, tailwind, ui, typescript, aliases, componentsDir, assets, cssFiles, tailwindConfig, evidence };
}

/** Import specifier for a project file, using an alias when one covers it. */
export function importPath(stack: Stack, file: string, from: string): string {
  const noExt = file.replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, "");
  for (const a of stack.aliases) if (a.target && noExt.startsWith(a.target)) return a.prefix + noExt.slice(a.target.length);
  let rel = relative(from.split("/").slice(0, -1).join("/") || ".", noExt).split(sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

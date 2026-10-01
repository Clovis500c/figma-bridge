// export_code projectPath: generates code that fits an existing project (its framework, styling,
// components and tokens) and returns a file plan. Files are written only when asked to.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { generateCode, type IrNode } from "../codegen";
import { indexComponents } from "./components";
import { detectStack, type Framework, type Stack, type Styling } from "./detect";
import { ComponentMatcher, loadMapFile } from "./mapping";
import { loadTokens } from "./tokens";

export interface PlannedFile {
  /** Project-relative path. */
  path: string;
  content: string | Uint8Array;
  kind: "code" | "asset";
}

export interface ProjectPlan {
  stack: Stack;
  files: PlannedFile[];
  components: { used: { figma: string; code: string }[]; unmatched: { figma: string; instances: number }[]; indexed: number };
  tokens: { sources: string[]; count: number; used: number };
  mapFile?: string;
  warnings: string[];
}

export interface PlanOptions {
  framework?: Framework;
  styling?: Styling;
  /** Component name (default: the layer name in PascalCase). */
  name?: string;
  /** Folder for the component, relative to the project (default: the project's components folder). */
  outDir?: string;
}

const pascal = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/^(\d)/, "C$1") || "Design";

export function planProjectExport(root: string, tree: IrNode, assets: Record<string, Uint8Array>, opts: PlanOptions = {}): ProjectPlan {
  const stack = detectStack(root);
  if (opts.framework) stack.framework = opts.framework;
  if (opts.styling) stack.styling = opts.styling;
  const warnings: string[] = [];
  if (stack.framework === "html") warnings.push("No React, Vue, Svelte or React Native dependency found: generated a plain HTML page.");
  const index = indexComponents(stack);
  const tokens = loadTokens(stack);
  const { map, path: mapFile, error } = loadMapFile(root);
  if (error) warnings.push(error);

  const name = opts.name ? pascal(opts.name) : pascal(tree.name);
  const ext = stack.framework === "vue" ? "vue" : stack.framework === "svelte" ? "svelte" : stack.framework === "html" ? "html" : stack.typescript ? "tsx" : "jsx";
  const dir = (opts.outDir ?? stack.componentsDir).replace(/\\/g, "/").replace(/\/$/, "");
  const componentFile = stack.framework === "html" ? `${dir}/${name}/index.html` : `${dir}/${name}.${ext}`;
  const matcher = new ComponentMatcher(stack, index, map, componentFile);

  let tokenHits = 0;
  const counting = {
    color: (hex: string) => {
      const t = tokens.color(hex);
      if (t) tokenHits++;
      return t;
    },
    byName: (n: string) => {
      const t = tokens.byName(n);
      if (t) tokenHits++;
      return t;
    },
  };

  // Images go to the project's public folder (served by URL) or next to the sources (imported).
  const assetTarget = (file: string) => `${stack.assets.dir}/${file}`;
  const assetPath = (file: string) => {
    if (stack.assets.url) return `${stack.assets.url}/${file}`;
    const rel = posix.relative(posix.dirname(componentFile), assetTarget(file));
    return rel.startsWith(".") ? rel : `./${rel}`;
  };

  const code = generateCode(tree, {
    framework: stack.framework,
    styling: stack.styling,
    assetPath,
    assetImports: !stack.assets.url,
    componentName: name,
    typescript: stack.typescript,
    responsive: true,
    // CSS variables mean nothing to React Native styles.
    tokens: stack.framework === "react-native" ? undefined : counting,
    resolveComponent: (n) => (n === tree || !n.component ? null : matcher.match({ name: n.component.name, props: n.component.props, text: n.component.text })?.use ?? null),
  });

  const files: PlannedFile[] = code.files.map((f) => ({ path: stack.framework === "html" ? componentFile : `${dir}/${f.path}`, content: f.content, kind: "code" as const }));
  for (const [file, bytes] of Object.entries(assets)) files.push({ path: assetTarget(file), content: bytes, kind: "asset" });
  warnings.push(...code.warnings, ...matcher.notes);
  return {
    stack,
    files,
    components: {
      used: [...matcher.matched].map(([figma, c]) => ({ figma, code: c })),
      unmatched: [...matcher.unmatched].map(([figma, instances]) => ({ figma, instances })),
      indexed: index.length,
    },
    tokens: { sources: tokens.sources, count: tokens.size, used: tokenHits },
    mapFile,
    warnings,
  };
}

export type WriteStatus = "created" | "updated" | "unchanged" | "skipped (exists)";

/** Writes a plan into the project. Existing files that differ are kept unless overwrite is set. */
export function writePlan(root: string, files: PlannedFile[], overwrite: boolean): { path: string; status: WriteStatus }[] {
  return files.map((f) => {
    const target = join(root, f.path);
    const next = typeof f.content === "string" ? Buffer.from(f.content) : Buffer.from(f.content);
    if (existsSync(target)) {
      const before = readFileSync(target);
      if (before.equals(next)) return { path: f.path, status: "unchanged" as const };
      if (!overwrite) return { path: f.path, status: "skipped (exists)" as const };
      writeFileSync(target, next);
      return { path: f.path, status: "updated" as const };
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, next);
    return { path: f.path, status: "created" as const };
  });
}

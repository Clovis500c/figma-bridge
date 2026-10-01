import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeError } from "./bridge";

// Reusable script functions, kept outside the repo so they survive updates.
// Each file is the body of an async function: (figma, utils, lib, console, args) => any.
export const SNIPPETS_DIR = process.env.FIGMA_BRIDGE_SNIPPETS || join(homedir(), ".figma-bridge", "snippets");
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface SnippetInfo {
  name: string;
  description: string;
  usage: string;
}

function ensureDir() {
  mkdirSync(SNIPPETS_DIR, { recursive: true });
}

function checkName(name: string) {
  if (!NAME.test(name)) throw new BridgeError(`Invalid snippet name "${name}": use letters, digits and _ (a valid JS identifier).`, "BAD_ARGS");
}

function header(source: string, tag: string): string {
  return new RegExp(`^//\\s*@${tag}\\s+(.*)$`, "m").exec(source)?.[1]?.trim() ?? "";
}

function files(): string[] {
  ensureDir();
  return readdirSync(SNIPPETS_DIR).filter((f) => f.endsWith(".js") && NAME.test(f.slice(0, -3)));
}

export function listSnippets(): SnippetInfo[] {
  return files().map((f) => {
    const source = readFileSync(join(SNIPPETS_DIR, f), "utf8");
    return { name: f.slice(0, -3), description: header(source, "description"), usage: header(source, "usage") };
  });
}

export function getSnippet(name: string): string {
  checkName(name);
  try {
    return readFileSync(join(SNIPPETS_DIR, `${name}.js`), "utf8");
  } catch {
    throw new BridgeError(`No snippet named "${name}".`, "NOT_FOUND");
  }
}

export function saveSnippet(name: string, code: string, description = "", usage = ""): string {
  checkName(name);
  ensureDir();
  const body = code.replace(/^\/\/\s*@(description|usage).*\n?/gm, "").trimEnd();
  const text = `// @description ${description.replace(/\n/g, " ")}\n// @usage ${usage.replace(/\n/g, " ") || `await lib.${name}(args)`}\n${body}\n`;
  const path = join(SNIPPETS_DIR, `${name}.js`);
  writeFileSync(path, text);
  return path;
}

export function deleteSnippet(name: string) {
  checkName(name);
  rmSync(join(SNIPPETS_DIR, `${name}.js`), { force: true });
}

let cached: { stamp: string; hash: string; lib: Record<string, string> } | null = null;

/** All snippets as { name: source }, plus a hash so the plugin only recompiles on change. */
export function loadLibrary(): { hash: string; lib: Record<string, string> } {
  const list = files();
  const stamp = list.map((f) => `${f}:${statSync(join(SNIPPETS_DIR, f)).mtimeMs}`).join("|");
  if (cached && cached.stamp === stamp) return cached;
  const lib: Record<string, string> = {};
  for (const f of list) lib[f.slice(0, -3)] = readFileSync(join(SNIPPETS_DIR, f), "utf8");
  cached = { stamp, hash: stamp ? Bun.hash(stamp + JSON.stringify(lib)).toString(36) : "empty", lib };
  return cached;
}

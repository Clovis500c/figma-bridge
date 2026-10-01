// Fails if plugin/code.js uses syntax newer than ES2017, which Figma's sandbox parser rejects:
// optional chaining, nullish coalescing, object spread/rest, catch without a binding, Array.flat/flatMap.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const file = join(import.meta.dir, "..", "plugin", "code.js");
const src = readFileSync(file, "utf8");
const problems: string[] = [];
const stack: string[] = [];
let line = 1;
let prev = ""; // last significant character, to tell a regex from a division

const report = (what: string) => problems.push(`plugin/code.js:${line}: ${what}`);

for (let i = 0; i < src.length; i++) {
  const c = src[i]!;
  const next = src[i + 1];
  if (c === "\n") line++;
  if (/\s/.test(c)) continue;

  if (c === "/" && next === "/") {
    while (i < src.length && src[i] !== "\n") i++;
    line++;
    continue;
  }
  if (c === "/" && next === "*") {
    const end = src.indexOf("*/", i + 2);
    line += (src.slice(i, end).match(/\n/g) ?? []).length;
    i = end + 1;
    continue;
  }
  if (c === "'" || c === '"') {
    for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    prev = "a";
    continue;
  }
  if (c === "`" || (c === "}" && stack[stack.length - 1] === "${")) {
    if (c === "}") stack.pop();
    for (i++; i < src.length && src[i] !== "`"; i++) {
      if (src[i] === "\\") i++;
      else if (src[i] === "\n") line++;
      else if (src[i] === "$" && src[i + 1] === "{") {
        stack.push("${");
        i++;
        break;
      }
    }
    prev = "a";
    continue;
  }
  if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\b(return|typeof|case|in|of)$/.test(src.slice(Math.max(0, i - 7), i).trimEnd()))) {
    let inClass = false;
    for (i++; i < src.length; i++) {
      if (src[i] === "\\") i++;
      else if (src[i] === "[") inClass = true;
      else if (src[i] === "]") inClass = false;
      else if (src[i] === "/" && !inClass) break;
    }
    prev = "a";
    continue;
  }

  if (c === "?" && next === "." && !/\d/.test(src[i + 2] ?? "")) report("optional chaining `?.`");
  if (c === "?" && next === "?") report("nullish coalescing `??`");
  if (c === "." && next === "." && src[i + 2] === "." && stack[stack.length - 1] === "{") report("object spread or rest `{ ...x }`");
  if (c === "c" && /^catch\s*\{/.test(src.slice(i, i + 12)) && !/\w/.test(src[i - 1] ?? "")) report("`catch {` without a binding");
  if (c === "." && /^\.(flat|flatMap)\(/.test(src.slice(i, i + 9))) report("Array.flat / flatMap");

  if (c === "{" || c === "(" || c === "[") stack.push(c);
  else if (c === "}" || c === ")" || c === "]") stack.pop();
  if (c === "." && next === "." && src[i + 2] === ".") i += 2;
  prev = c;
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} ES2018+ construct(s) in plugin/code.js: Figma's plugin sandbox rejects them.`);
  process.exit(1);
}
console.log("plugin/code.js: ES2017 syntax only");

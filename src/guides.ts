// MCP prompts (ready-made workflows) and resources (the build spec reference and the workflow), for
// clients that show prompts as commands or ignore the server's instructions.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface ToolDoc {
  name: string;
  title?: string;
  description: string;
}

const RESOURCES = {
  build: "figma-bridge://docs/build-spec",
  workflow: "figma-bridge://docs/workflow",
};

const text = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t.trim() } }] });
const opt = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);

/** The prompts: each is a short, complete plan the agent follows with Figma Bridge's tools. */
export const PROMPTS: { name: string; title: string; description: string; args: Record<string, string>; render: (a: Record<string, string | undefined>) => string }[] = [
  {
    name: "new-screen",
    title: "Design a new screen",
    description: "Design a screen from a description, reusing the file's design system.",
    args: { description: "What the screen is for and what it contains", platform: "desktop (1440), tablet (834) or mobile (390); default desktop" },
    render: (a) => `
Design a new ${opt(a.platform, "desktop")} screen in the connected Figma file: ${opt(a.description, "(ask me what the screen is for)")}.
1. get_context, then get_design_system. Reuse its color and text styles, variables and components (style:, var:, {component}) instead of raw values.
2. Build it with build: one call per section (header, hero, content, footer…), auto-layout everywhere, frames named after what they are, width ${a.platform === "mobile" ? 390 : a.platform === "tablet" ? 834 : 1440}.
3. screenshot {returnImage:true} the result and look at it critically: spacing rhythm, alignment, hierarchy, contrast.
4. audit the frame and fix every error and warning.
5. Tell me what you built and what you would improve next.`,
  },
  {
    name: "apply-design-system",
    title: "Apply the design system",
    description: "Make a screen use the file's variables, styles and components.",
    args: { target: "Layer name or id (default: the selection)" },
    render: (a) => `
Apply the file's design system to ${opt(a.target, "the selected layers (use wait_for_selection if nothing is selected)")}.
1. get_design_system to see the variables, styles and components available, and describe the target.
2. checkpoint {action:"save"} on the target first.
3. audit {fix:true} on it: raw colors and numbers get bound to matching variables, matching text styles are applied, default layer names are fixed.
4. For what remains (near-miss colors, text without a matching style, frames that should be component instances), fix it with build or run_script: prefer replacing ad-hoc elements by instances of the existing components.
5. audit {scope:"design-system", nodeId} before and after, and report the score change and anything you could not map.`,
  },
  {
    name: "reproduce-screenshot",
    title: "Reproduce a screenshot",
    description: "Rebuild a mockup or screenshot as an editable, auto-layout frame and check it pixel by pixel.",
    args: { image: "Local path or URL of the image", width: "Width of the frame in px (default: the image's width)" },
    render: (a) => `
Reproduce ${opt(a.image, "the image I give you")} as an editable Figma frame${a.width ? ` ${a.width} px wide` : ""}.
1. Look at the image carefully. get_design_system and reuse what matches.
2. build it at the image's size, with auto-layout and real text (not images of text). Icons: search_icons, then {icon:"set:name"}.
3. compare {nodeId, reference:"${opt(a.image, "<image>")}", returnImage:true}. Fix the largest regions first (layout and size before color and detail), then compare again.
4. Stop when mismatchPercent no longer drops; report the final number and what still differs.`,
  },
  {
    name: "import-website",
    title: "Import a website",
    description: "Turn a web page into editable Figma frames at several widths, then clean them up.",
    args: { url: "The page URL, or a local .html path", viewports: "Comma-separated widths, default 1440,390" },
    render: (a) => {
      const viewports = opt(a.viewports, "1440,390")
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((n) => n > 0);
      return `
Import ${opt(a.url, "(ask me for the URL)")} into the connected Figma file.
1. import_web {${/^https?:/.test(a.url ?? "") ? "url" : "path"}:"${opt(a.url, "<url>")}", viewports:${JSON.stringify(viewports)}}.
2. For each frame, compare {nodeId: rootId, reference} and look at the regions with the largest mismatch: fix layout or spacing problems with run_script or build.
3. Report fontSubstitutions: suggest installing the missing fonts or switching to the file's fonts.
4. Rename layers that are still generic (Row, Column, Frame) after what they contain, and turn repeated cards or buttons into components if it helps.`;
    },
  },
  {
    name: "figma-to-code",
    title: "Figma to code",
    description: "Export a frame as code that uses the project's own components and tokens.",
    args: { projectPath: "Root folder of the app (where package.json is)", target: "Layer name or id (default: the selection)" },
    render: (a) => `
Turn ${opt(a.target, "the selected frame")} into code for the project at ${opt(a.projectPath, "(ask me for the project folder)")}.
1. export_code {projectPath, nodeId} without writing. Read the plan: the detected stack, the components used and the unmatched instances, the token sources.
2. If important instances are unmatched, add figma-bridge.map.json entries for them (Figma component → code component and props) and export again.
3. Review the code like a teammate would: semantics, accessibility (labels, alt text, buttons vs links), responsive behaviour. Fix names in Figma if class or component names are poor.
4. When it looks right, export_code with write:true, then run the project's type-check or linter and fix what they report.`,
  },
  {
    name: "figma-to-roblox",
    title: "Figma to Roblox",
    description: "Turn a frame into Roblox UI and place it in Studio with a Roblox Studio MCP.",
    args: { target: "Layer name or id (default: the selection)", mode: "scale, offset or hybrid (default hybrid)" },
    render: (a) => `
Turn ${opt(a.target, "the selected frame")} into Roblox UI that looks the same, and put it in the open Roblox Studio place.
1. export_roblox {${a.target ? `nodeId:"<id of ${a.target}>", ` : ""}mode:"${opt(a.mode, "hybrid")}"}. Read the warnings (approximations, font substitutions).
2. If assets are not uploaded (placeholders rbxassetid://PENDING_n): upload each file in assets[] with the Roblox Studio MCP (e.g. upload_image), and replace each placeholder in the Luau with the returned id.
3. Run the Luau with execute_luau: it creates the ScreenGui under StarterGui (replacing an earlier copy) and returns it.
4. Take a Studio screenshot and compare it with screenshot {returnImage:true} of the Figma frame. Fix differences in the Luau (or in Figma, then export again).
5. Report the result and anything Roblox could not reproduce.`,
  },
  {
    name: "audit-and-fix",
    title: "Audit and fix",
    description: "Score the design system's health, apply safe fixes, and report what changed.",
    args: { target: "Layer name or id to limit the fixes (default: the current page)" },
    render: (a) => `
Audit and improve this file${a.target ? ` (fixes limited to ${a.target})` : ""}.
1. audit {scope:"design-system"} and summarize the score per category with the most important issues.
2. checkpoint {action:"save"} on what you are going to change.
3. audit {fix:true${a.target ? `, nodeId:"<id of ${a.target}>"` : ""}} and read the changes.
4. Fix the remaining contrast errors and text without styles by hand where the right choice is clear; list the ones that need a design decision.
5. audit {scope:"design-system"} again and report the score before and after.`,
  },
];

export function registerGuides(server: McpServer, docs: { instructions: string[]; buildSpec: string; tools: () => ToolDoc[] }) {
  for (const p of PROMPTS) {
    const argsSchema: Record<string, z.ZodOptional<z.ZodString>> = {};
    for (const [k, d] of Object.entries(p.args)) argsSchema[k] = z.string().optional().describe(d);
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema }, (args: Record<string, string | undefined>) => text(p.render(args ?? {})));
  }

  server.registerResource(
    "build-spec",
    RESOURCES.build,
    { title: "build spec reference", description: "Every node type and property the build tool accepts, with examples.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: buildSpecMarkdown(docs.buildSpec) }] }),
  );
  server.registerResource(
    "workflow",
    RESOURCES.workflow,
    { title: "Figma Bridge workflow", description: "How to work with Figma Bridge: the workflow, rules and every tool.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: workflowMarkdown(docs.instructions, docs.tools()) }] }),
  );
}

export function buildSpecMarkdown(spec: string): string {
  const lines = spec.split("\n");
  const out = ["# build spec reference", "", lines[0]!, ""];
  for (const line of lines.slice(1)) {
    // "TEXT: …", "PAINT (fill, stroke, color): …", "FIGJAM files: …" start a section.
    const m = /^([A-Z]{2,}(?: [A-Z]{2,})*)((?: \([^)]*\))?(?: files)?):\s*(.*)$/.exec(line);
    if (m && !/^Example/.test(line)) {
      const title = m[1]! + m[2]!;
      out.push(`## ${title[0]}${title.slice(1).toLowerCase()}`, "", m[3]!, "");
    }
    else if (/^Example:/.test(line)) out.push("## Example", "", "```json", line.replace(/^Example:\s*/, ""), "```", "");
    else out.push(line, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function workflowMarkdown(instructions: string[], tools: ToolDoc[]): string {
  const first = (d: string) => (/^(.*?[.!?])(\s|$)/s.exec(d.replace(/\s+/g, " "))?.[1] ?? d).slice(0, 220);
  return [
    "# Working with Figma Bridge",
    "",
    ...instructions.map((l) => (/^\d\./.test(l) ? l : `- ${l}`)),
    "",
    "## Tools",
    "",
    ...tools.map((t) => `- **${t.name}**${t.title ? ` (${t.title})` : ""}: ${first(t.description)}`),
    "",
    "## Prompts",
    "",
    ...PROMPTS.map((p) => `- **${p.name}**: ${p.description}`),
    "",
    `Full build spec: ${RESOURCES.build}`,
    "",
  ].join("\n");
}

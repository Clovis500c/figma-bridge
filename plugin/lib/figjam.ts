// FigJam and Slides nodes for build: stickies, shapes with text, connectors, tables, code blocks, slides.
// Syntax stays ES2017 (no ?. ?? object spread or optional catch binding): the sandbox parser is conservative.
import { codeError, loadFont, parseHex } from "./util";

/** Types only FigJam can create, and the editor each needs. */
const EDITORS: { [type: string]: string } = { sticky: "figjam", shape: "figjam", connector: "figjam", table: "figjam", codeblock: "figjam", slide: "slides" };
const EDITOR_NAMES: { [editor: string]: string } = { figma: "Figma Design", figjam: "FigJam", slides: "Figma Slides", dev: "Dev Mode" };

export function requireEditor(type: string, path: string) {
  const wanted = EDITORS[type];
  if (wanted && figma.editorType !== wanted) {
    throw codeError(path + ': "' + type + '" needs a ' + EDITOR_NAMES[wanted] + " file; this file is open in " + (EDITOR_NAMES[figma.editorType] || figma.editorType) + ".", "WRONG_EDITOR");
  }
}

const STICKY_COLORS: { [name: string]: string } = {
  white: "#FFFFFF",
  gray: "#E6E6E6",
  grey: "#E6E6E6",
  green: "#B3EFBD",
  teal: "#B3F4EF",
  blue: "#A8DAFF",
  violet: "#D3BDFF",
  purple: "#D3BDFF",
  pink: "#FFA8DB",
  red: "#FFB8A8",
  orange: "#FFD3A8",
  yellow: "#FFE299",
};

function solid(color: string): SolidPaint {
  const hex = STICKY_COLORS[String(color).toLowerCase()] || color;
  const c = parseHex(hex);
  return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

/** Text inside a sticky, shape, connector or table cell: load its font, then set it. */
export async function setSublayerText(sub: TextSublayerNode, text: any, opts?: any) {
  const font = sub.fontName;
  if (font !== figma.mixed) await loadFont(font as FontName);
  else if (sub.characters.length) {
    const fonts = sub.getRangeAllFontNames(0, sub.characters.length);
    for (let i = 0; i < fonts.length; i++) await loadFont(fonts[i]);
  }
  if (opts && opts.font) {
    await loadFont(opts.font);
    sub.fontName = opts.font;
  }
  sub.characters = String(text === undefined || text === null ? "" : text);
  if (opts && typeof opts.size === "number") sub.fontSize = opts.size;
  if (opts && opts.color) sub.fills = [solid(opts.color)];
}

export async function createSticky(s: any): Promise<StickyNode> {
  const n = figma.createSticky();
  if (s.wide) n.isWideWidth = true;
  if (s.author === false) n.authorVisible = false;
  if (s.color || s.fill) n.fills = [solid(s.color || s.fill)];
  await setSublayerText(n.text, s.text);
  return n;
}

const SHAPES: { [name: string]: ShapeWithTextNode["shapeType"] } = {
  square: "SQUARE",
  rect: "SQUARE",
  rectangle: "SQUARE",
  rounded: "ROUNDED_RECTANGLE",
  roundedrectangle: "ROUNDED_RECTANGLE",
  ellipse: "ELLIPSE",
  circle: "ELLIPSE",
  diamond: "DIAMOND",
  decision: "DIAMOND",
  triangle: "TRIANGLE_UP",
  triangleup: "TRIANGLE_UP",
  triangledown: "TRIANGLE_DOWN",
  parallelogram: "PARALLELOGRAM_RIGHT",
  parallelogramleft: "PARALLELOGRAM_LEFT",
  database: "ENG_DATABASE",
  cylinder: "ENG_DATABASE",
  queue: "ENG_QUEUE",
  file: "ENG_FILE",
  folder: "ENG_FOLDER",
  trapezoid: "TRAPEZOID",
  process: "PREDEFINED_PROCESS",
  subroutine: "PREDEFINED_PROCESS",
  shield: "SHIELD",
  document: "DOCUMENT_SINGLE",
  documents: "DOCUMENT_MULTIPLE",
  input: "MANUAL_INPUT",
  hexagon: "HEXAGON",
  chevron: "CHEVRON",
  pentagon: "PENTAGON",
  octagon: "OCTAGON",
  star: "STAR",
  plus: "PLUS",
  arrowleft: "ARROW_LEFT",
  arrowright: "ARROW_RIGHT",
  junction: "SUMMING_JUNCTION",
  or: "OR",
  speech: "SPEECH_BUBBLE",
  speechbubble: "SPEECH_BUBBLE",
  storage: "INTERNAL_STORAGE",
};

export async function createShape(s: any, path: string, warnings: string[]): Promise<ShapeWithTextNode> {
  const n = figma.createShapeWithText();
  const key = String(s.shape || "rounded").toLowerCase().replace(/[^a-z]/g, "");
  const shape = SHAPES[key] || (String(s.shape || "").toUpperCase() as any);
  try {
    n.shapeType = shape;
  } catch (e) {
    warnings.push(path + ': unknown shape "' + s.shape + '", used a rounded rectangle');
    n.shapeType = "ROUNDED_RECTANGLE";
  }
  const w = typeof s.w === "number" ? s.w : typeof s.width === "number" ? s.width : 0;
  const h = typeof s.h === "number" ? s.h : typeof s.height === "number" ? s.height : 0;
  if (w || h) n.resize(w || n.width, h || n.height);
  if (s.fill !== undefined) n.fills = s.fill === null ? [] : [solid(s.fill)];
  if (s.stroke !== undefined) n.strokes = s.stroke === null ? [] : [solid(s.stroke)];
  if (typeof s.strokeWidth === "number") n.strokeWeight = s.strokeWidth;
  if (s.text !== undefined) await setSublayerText(n.text, s.text, { size: s.size, color: s.color });
  return n;
}

export async function createTable(s: any, path: string): Promise<TableNode> {
  const rows: any[][] = Array.isArray(s.rows) ? s.rows : [];
  if (!rows.length) throw codeError(path + ': a table needs rows:[["Header 1","Header 2"],["a","b"]]', "BAD_ARGS");
  let cols = 0;
  for (let i = 0; i < rows.length; i++) cols = Math.max(cols, Array.isArray(rows[i]) ? rows[i].length : 1);
  const t = figma.createTable(rows.length, cols);
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      const value = Array.isArray(rows[r]) ? rows[r][c] : c === 0 ? rows[r] : "";
      const cell = t.cellAt(r, c);
      await setSublayerText(cell.text, value === undefined ? "" : value);
      if (r === 0 && s.header !== false) cell.fills = [solid(s.headerFill || "#F2F2F2")];
    }
  }
  return t;
}

const LANGUAGES = ["TYPESCRIPT", "CPP", "RUBY", "CSS", "JAVASCRIPT", "HTML", "JSON", "GRAPHQL", "PYTHON", "GO", "SQL", "SWIFT", "KOTLIN", "RUST", "BASH", "PLAINTEXT", "DART"];
const LANGUAGE_ALIASES: { [k: string]: string } = { ts: "TYPESCRIPT", tsx: "TYPESCRIPT", js: "JAVASCRIPT", jsx: "JAVASCRIPT", "c++": "CPP", py: "PYTHON", sh: "BASH", shell: "BASH", text: "PLAINTEXT", txt: "PLAINTEXT", golang: "GO", rb: "RUBY" };

export function createCodeBlock(s: any): CodeBlockNode {
  const n = figma.createCodeBlock();
  const lang = String(s.language || "plaintext").toLowerCase();
  const code = (LANGUAGE_ALIASES[lang] || lang.toUpperCase()) as CodeBlockNode["codeLanguage"];
  n.codeLanguage = LANGUAGES.indexOf(code) !== -1 ? code : "PLAINTEXT";
  n.code = String(s.code === undefined ? "" : s.code);
  return n;
}

export function createSlide(): SlideNode {
  return figma.createSlide();
}

const CAPS: { [k: string]: ConnectorStrokeCap } = { arrow: "ARROW_LINES", triangle: "ARROW_EQUILATERAL", filled: "TRIANGLE_FILLED", diamond: "DIAMOND_FILLED", circle: "CIRCLE_FILLED", none: "NONE" };
const LINES: { [k: string]: ConnectorNode["connectorLineType"] } = { elbowed: "ELBOWED", elbow: "ELBOWED", straight: "STRAIGHT", curved: "CURVED", curve: "CURVED" };
const MAGNETS = ["AUTO", "TOP", "LEFT", "BOTTOM", "RIGHT", "CENTER", "NONE"];

/** Connector between two nodes (ids already resolved). */
export async function createConnector(s: any, fromId: string, toId: string): Promise<ConnectorNode> {
  const n = figma.createConnector();
  const magnet = function (v: any): ConnectorEndpointEndpointNodeIdAndMagnet["magnet"] {
    const m = String(v || "AUTO").toUpperCase();
    return (MAGNETS.indexOf(m) !== -1 ? m : "AUTO") as any;
  };
  n.connectorStart = { endpointNodeId: fromId, magnet: magnet(s.fromMagnet) };
  n.connectorEnd = { endpointNodeId: toId, magnet: magnet(s.toMagnet) };
  n.connectorLineType = LINES[String(s.line || "elbowed").toLowerCase()] || "ELBOWED";
  n.connectorEndStrokeCap = CAPS[String(s.endArrow === undefined ? "arrow" : s.endArrow).toLowerCase()] || "ARROW_LINES";
  n.connectorStartStrokeCap = CAPS[String(s.startArrow === undefined ? "none" : s.startArrow).toLowerCase()] || "NONE";
  if (s.color || s.stroke) n.strokes = [solid(s.color || s.stroke)];
  if (typeof s.strokeWidth === "number") n.strokeWeight = s.strokeWidth;
  if (s.dashed) n.dashPattern = [8, 6];
  if (s.label !== undefined && s.label !== "") await setSublayerText(n.text, s.label);
  return n;
}

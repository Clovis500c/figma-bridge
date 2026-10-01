// Design lint: finds common mistakes so the agent can fix its own work.
import { autoFix, designSystemHealth } from "./health";
import { contrastRatio, getNode, invalidateCaches, isAutoLayout, round } from "./util";

type Severity = "error" | "warning" | "info";
interface Issue {
  rule: string;
  severity: Severity;
  nodeId: string;
  name: string;
  message: string;
}

const MAX_NODES = 5000;
const MAX_ISSUES = 120;
export const DEFAULT_NAME = /^(Frame|Rectangle|Ellipse|Group|Vector|Text|Line|Polygon|Star|Component|Instance|Section|Image)( \d+)?$/;

export async function audit(p: any, _timeoutMs?: number, requestId?: string) {
  if (p.fix === true || (Array.isArray(p.fixes) && p.fixes.length)) {
    // Fix first, then report on the result.
    const fixed = await autoFix(p, requestId);
    invalidateCaches();
    const after: any = p.scope === "design-system" ? await designSystemHealth(p, requestId) : await lint(p);
    return Object.assign({ fixed: fixed.fixed, changes: fixed.changes, fixScope: fixed.scope }, after);
  }
  if (p.scope === "design-system") return designSystemHealth(p, requestId);
  return lint(p);
}

async function lint(p: any) {
  let roots: BaseNode[];
  if (p.nodeId) roots = [await getNode(p.nodeId)];
  else if (figma.currentPage.selection.length) roots = figma.currentPage.selection.slice();
  else roots = figma.currentPage.children.slice();
  const only: string[] | null = Array.isArray(p.rules) && p.rules.length ? p.rules : null;
  const issues: Issue[] = [];
  const counts: { [rule: string]: number } = {};
  const families: { [f: string]: number } = {};
  const sizes: { [s: string]: number } = {};
  let visited = 0;
  const pageBg = pageBackground();

  const report = function (rule: string, severity: Severity, n: BaseNode, message: string) {
    if (only && only.indexOf(rule) === -1) return;
    counts[rule] = (counts[rule] || 0) + 1;
    if (issues.length < MAX_ISSUES) issues.push({ rule: rule, severity: severity, nodeId: n.id, name: n.name, message: message });
  };

  const visit = function (n: any, clipBox: Rect | null) {
    if (visited >= MAX_NODES) return;
    visited++;
    if (n.visible === false) return;
    const box: Rect | null = n.absoluteBoundingBox || null;

    if (DEFAULT_NAME.test(n.name) && n.type !== "TEXT") report("default-name", "info", n, "Layer has a default name");

    if (clipBox && box && !inside(box, clipBox)) {
      const fully = box.x >= clipBox.x + clipBox.width || box.y >= clipBox.y + clipBox.height || box.x + box.width <= clipBox.x || box.y + box.height <= clipBox.y;
      report("clipped", fully ? "warning" : "info", n, fully ? "Completely hidden by a clipping parent" : "Partly cut off by a clipping parent");
    }

    if (n.type === "TEXT") checkText(n, report, families, sizes, pageBg);

    if (isAutoLayout(n)) {
      const vals = [n.itemSpacing, n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
      if (
        vals.some(function (v: number) {
          return typeof v === "number" && v % 4 !== 0;
        })
      ) {
        report("off-grid", "info", n, "Spacing/padding not on a 4 px grid (" + vals.map(round).join(",") + ")");
      }
    } else if ((n.type === "FRAME" || n.type === "COMPONENT") && n.parent && n.parent.type !== "PAGE" && n.parent.type !== "SECTION") {
      const visibleKids = (n.children || []).filter(function (c: SceneNode) {
        return c.visible;
      });
      if (visibleKids.length >= 2) report("no-auto-layout", "info", n, "Frame with " + visibleKids.length + " children but no auto-layout");
    }
    if ((n.type === "FRAME" || n.type === "GROUP") && n.children && !n.children.length) {
      const hasFill = n.fills && n.fills !== figma.mixed && n.fills.length;
      if (!hasFill) report("empty", "info", n, "Empty layer with no fill");
    }
    if (typeof n.width === "number" && n.type !== "TEXT" && n.type !== "VECTOR" && n.type !== "LINE" && n.type !== "BOOLEAN_OPERATION" && n.type !== "STAR" && n.type !== "POLYGON") {
      if (Math.abs(n.width - Math.round(n.width)) > 0.01 || Math.abs(n.height - Math.round(n.height)) > 0.01) {
        report("fractional", "info", n, "Fractional size " + round(n.width) + "×" + round(n.height));
      }
    }

    const kids = n.children || [];
    const nextClip = n.clipsContent && box ? box : clipBox;
    for (let i = 0; i < kids.length; i++) visit(kids[i], nextClip);
  };
  for (let i = 0; i < roots.length; i++) visit(roots[i], null);

  const familyList = Object.keys(families);
  const sizeList = Object.keys(sizes)
    .map(Number)
    .sort(function (a, b) {
      return a - b;
    });
  if (familyList.length > 3) report("font-sprawl", "warning", roots[0], familyList.length + " font families: " + familyList.join(", "));
  if (sizeList.length > 8) report("type-scale", "warning", roots[0], sizeList.length + " different font sizes: " + sizeList.join(", "));

  const summary = { error: 0, warning: 0, info: 0 };
  const order: any = { error: 0, warning: 1, info: 2 };
  issues.sort(function (a, b) {
    return order[a.severity] - order[b.severity];
  });
  const bySeverity: any = {};
  for (let i = 0; i < issues.length; i++) bySeverity[issues[i].severity] = (bySeverity[issues[i].severity] || 0) + 1;
  summary.error = bySeverity.error || 0;
  summary.warning = bySeverity.warning || 0;
  summary.info = bySeverity.info || 0;
  return {
    summary: summary,
    countsByRule: counts,
    nodesChecked: visited,
    fonts: familyList,
    fontSizes: sizeList,
    issues: issues,
    truncated: visited >= MAX_NODES || issues.length >= MAX_ISSUES,
  };
}

function checkText(n: TextNode, report: any, families: any, sizes: any, pageBg: RGB) {
  if (n.hasMissingFont) report("missing-font", "error", n, "Uses a font that is not installed");
  if (n.fontName !== figma.mixed) families[n.fontName.family] = true;
  if (n.fontSize !== figma.mixed) {
    sizes[round(n.fontSize)] = true;
    if (n.fontSize < 10) report("tiny-text", "warning", n, "Font size " + n.fontSize + " px is hard to read");
  }
  if (n.textTruncation === "DISABLED" && n.textAutoResize === "NONE" && n.characters.length > 0 && n.fontSize !== figma.mixed) {
    const lh = n.lineHeight !== figma.mixed && n.lineHeight.unit === "PIXELS" ? n.lineHeight.value : n.fontSize * 1.2;
    if (n.height + 0.5 < lh) report("text-overflow", "warning", n, "Fixed text box is shorter than one line");
  }
  const parent: any = n.parent;
  if (parent && parent.absoluteBoundingBox && n.absoluteBoundingBox && parent.type !== "PAGE" && parent.type !== "SECTION") {
    const pb = parent.absoluteBoundingBox;
    const tb = n.absoluteBoundingBox;
    if (tb.x + tb.width > pb.x + pb.width + 1 || tb.x < pb.x - 1) report("text-overflow", "warning", n, "Text extends outside its container");
  }
  const c = textContrast(n, pageBg);
  if (c && c.ratio < c.min) {
    report("contrast", c.ratio < c.min - 1.5 ? "error" : "warning", n, "Contrast " + round(c.ratio) + ":1 is below " + c.min + ":1 (WCAG AA" + (c.large ? ", large text" : "") + ")");
  }
}

/** WCAG contrast of a text layer against the solid background behind it, or null when it can't be judged. */
export function textContrast(n: TextNode, pageBg: RGB): { ratio: number; min: number; large: boolean } | null {
  const fg = solidOf(n.fills);
  if (!fg || n.fontSize === figma.mixed) return null;
  const bg = backgroundOf(n, pageBg);
  if (!bg) return null;
  const bold = n.fontName !== figma.mixed && /bold|black|heavy|semi/i.test(n.fontName.style);
  const large = n.fontSize >= 24 || (bold && n.fontSize >= 18.66);
  return { ratio: contrastRatio(fg, bg), min: large ? 3 : 4.5, large: large };
}

function solidOf(paints: any): RGB | null {
  if (!paints || paints === figma.mixed) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i];
    if (p.visible !== false && p.type === "SOLID" && (p.opacity === undefined || p.opacity > 0.9)) return p.color;
  }
  return null;
}

function backgroundOf(n: BaseNode, pageBg: RGB): RGB | null {
  let p: any = n.parent;
  while (p && p.type !== "PAGE") {
    if (p.fills && p.fills !== figma.mixed) {
      const images = p.fills.some(function (f: Paint) {
        return f.visible !== false && (f.type === "IMAGE" || f.type.indexOf("GRADIENT") === 0);
      });
      if (images) return null; // cannot judge contrast on images or gradients
      const c = solidOf(p.fills);
      if (c) return c;
    }
    p = p.parent;
  }
  return pageBg;
}

export function pageBackground(): RGB {
  const bg = solidOf(figma.currentPage.backgrounds);
  return bg || { r: 1, g: 1, b: 1 };
}

function inside(a: Rect, b: Rect): boolean {
  return a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
}

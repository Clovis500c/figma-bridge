// audit scope:"design-system": a 0–100 health score per category with concrete issues.
import { DEFAULT_NAME, pageBackground, textContrast } from "./audit";
import { checkCancelled, getNode, localComponents, localStyles, localVariables, round, toHex } from "./util";

const MAX_NODES = 20000;
const MAX_ISSUES = 100;
const WEIGHTS: { [category: string]: number } = { tokens: 25, contrast: 20, typography: 15, components: 15, styles: 15, naming: 10 };
const NUMBER_FIELDS = ["itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
const RADIUS_FIELDS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];

interface Issue {
  category: string;
  message: string;
  nodeId?: string;
  name?: string;
}

/** Scene nodes in scope, skipping the insides of instances (they belong to their component). */
async function scopeNodes(p: any, wholeFile: boolean, requestId?: string): Promise<{ nodes: SceneNode[]; truncated: boolean; label: string }> {
  let roots: BaseNode[];
  let label: string;
  if (p.nodeId) {
    const n = await getNode(p.nodeId);
    roots = [n];
    label = n.name;
  } else if (wholeFile) {
    await figma.loadAllPagesAsync();
    roots = figma.root.children.slice();
    label = "the whole file";
  } else if (figma.currentPage.selection.length) {
    roots = figma.currentPage.selection.slice();
    label = "the selection";
  } else {
    roots = figma.currentPage.children.slice();
    label = "page " + figma.currentPage.name;
  }
  const nodes: SceneNode[] = [];
  let truncated = false;
  const walk = function (n: any) {
    if (nodes.length >= MAX_NODES) {
      truncated = true;
      return;
    }
    if (n.type !== "PAGE" && n.type !== "DOCUMENT") nodes.push(n);
    if (n.type === "INSTANCE" || !("children" in n)) return;
    if (n.type === "PAGE" && n.name === "⟲ Bridge checkpoints") return;
    for (let i = 0; i < n.children.length; i++) walk(n.children[i]);
  };
  for (let i = 0; i < roots.length; i++) {
    checkCancelled(requestId);
    walk(roots[i]);
  }
  return { nodes: nodes, truncated: truncated, label: label };
}

function visibleSolids(paints: any): SolidPaint[] {
  if (!paints || paints === figma.mixed) return [];
  return paints.filter(function (pt: Paint) {
    return pt.visible !== false && pt.type === "SOLID";
  });
}

function score(good: number, total: number): number {
  return total ? Math.round((good / total) * 100) : 100;
}

/** "Brand/Primary" → slash-grouped; each segment classified as kebab, snake, camel, Title or lower. */
function convention(name: string): string {
  const seg = name.split("/").pop() || name;
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(seg)) return "kebab-case";
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(seg)) return "snake_case";
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(seg)) return "camelCase";
  if (/^[A-Z][a-z0-9]*( [A-Z0-9][a-z0-9]*)*$/.test(seg)) return "Title Case";
  if (/^[a-z0-9]+$/.test(seg)) return "lowercase";
  return "mixed";
}

function namingConsistency(names: string[], what: string, issues: Issue[]): { score: number; convention: string } {
  const counts: { [c: string]: number } = {};
  const multiWord: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const c = convention(names[i]);
    if (c === "lowercase") continue; // one word fits every convention
    counts[c] = (counts[c] || 0) + 1;
    multiWord.push(names[i]);
  }
  const keys = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a];
  });
  const main = keys[0] || "lowercase";
  const off = multiWord.filter(function (n) {
    return convention(n) !== main;
  });
  for (let i = 0; i < Math.min(off.length, 5); i++) issues.push({ category: "naming", message: what + ' "' + off[i] + '" is not ' + main + " like most others" });
  return { score: score(multiWord.length - off.length, multiWord.length), convention: main };
}

function paintKey(paints: readonly Paint[]): string {
  return JSON.stringify(
    paints.map(function (pt: any) {
      if (pt.type === "SOLID") return toHex(pt.color, pt.opacity) + (pt.boundVariables && pt.boundVariables.color ? "@" + pt.boundVariables.color.id : "");
      if (pt.gradientStops) return pt.type + pt.gradientStops.map(function (s: ColorStop) {
        return toHex(s.color) + round(s.position);
      });
      return pt.type + (pt.imageHash || "");
    }),
  );
}

// ─── Health ─────────────────────────────────────────────────────────────────

export async function designSystemHealth(p: any, requestId?: string) {
  const scope = await scopeNodes(p, !p.nodeId, requestId);
  const nodes = scope.nodes;
  const issues: Issue[] = [];
  const add = function (category: string, message: string, n?: BaseNode) {
    if (issues.length < MAX_ISSUES * 3) issues.push(n ? { category: category, message: message, nodeId: n.id, name: n.name } : { category: category, message: message });
  };
  const styles = await localStyles();
  const vars = await localVariables();
  const components = await localComponents();
  const componentNames: { [name: string]: boolean } = {};
  for (let i = 0; i < components.length; i++) componentNames[components[i].name] = true;

  const used: { [id: string]: number } = {};
  const use = function (id: any) {
    if (typeof id === "string" && id) used[id] = (used[id] || 0) + 1;
  };
  let colorTotal = 0;
  let colorBound = 0;
  let numberTotal = 0;
  let numberBound = 0;
  let textTotal = 0;
  let textStyled = 0;
  let contrastTotal = 0;
  let contrastOk = 0;
  let layerTotal = 0;
  let layerDefault = 0;
  let instanceCount = 0;
  let overridden = 0;
  let detached = 0;
  const pageBg = pageBackground();

  for (let i = 0; i < nodes.length; i++) {
    if (i % 500 === 0) checkCancelled(requestId);
    const n: any = nodes[i];
    const bound = n.boundVariables || {};
    const keys = Object.keys(bound);
    for (let k = 0; k < keys.length; k++) {
      const b = bound[keys[k]];
      if (Array.isArray(b)) for (let j = 0; j < b.length; j++) use(b[j] && b[j].id);
      else if (b && b.id) use(b.id);
    }
    ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"].forEach(function (f) {
      if (f in n) use(n[f]);
    });

    if (n.type === "INSTANCE") {
      instanceCount++;
      const fields = (n.overrides || []).reduce(function (sum: number, o: any) {
        return sum + o.overriddenFields.length;
      }, 0);
      if (fields > 12) {
        overridden++;
        add("components", "Instance with " + fields + " overridden properties: consider a variant", n);
      }
      continue;
    }
    if ((n.type === "FRAME" || n.type === "GROUP") && (componentNames[n.name] || /^[^=,]+=[^=,]+(, [^=,]+=[^=,]+)*$/.test(n.name))) {
      detached++;
      add("components", 'Frame named like a component ("' + n.name + '"): probably a detached instance', n);
    }

    // Token coverage: raw colors and spacing/radius values vs variables and styles.
    const fillStyled = typeof n.fillStyleId === "string" && n.fillStyleId !== "";
    const solids = fillStyled ? [] : visibleSolids(n.fills);
    for (let k = 0; k < solids.length; k++) {
      colorTotal++;
      if ((solids[k] as any).boundVariables && (solids[k] as any).boundVariables.color) colorBound++;
      else add("tokens", "Hard-coded color " + toHex(solids[k].color, solids[k].opacity), n);
    }
    const strokeStyled = typeof n.strokeStyleId === "string" && n.strokeStyleId !== "";
    const strokes = strokeStyled ? [] : visibleSolids(n.strokes);
    for (let k = 0; k < strokes.length; k++) {
      colorTotal++;
      if ((strokes[k] as any).boundVariables && (strokes[k] as any).boundVariables.color) colorBound++;
    }
    if (fillStyled) {
      colorTotal++;
      colorBound++;
    }
    if (n.layoutMode && n.layoutMode !== "NONE") {
      for (let k = 0; k < NUMBER_FIELDS.length; k++) {
        const f = NUMBER_FIELDS[k];
        if (f === "counterAxisSpacing" && n.layoutWrap !== "WRAP") continue;
        if (!n[f]) continue;
        numberTotal++;
        if (bound[f]) numberBound++;
      }
    }
    if ("topLeftRadius" in n && n.type !== "TEXT") {
      for (let k = 0; k < RADIUS_FIELDS.length; k++) {
        if (!n[RADIUS_FIELDS[k]]) continue;
        numberTotal++;
        if (bound[RADIUS_FIELDS[k]]) numberBound++;
      }
    }

    if (n.type === "TEXT") {
      textTotal++;
      if (typeof n.textStyleId === "string" && n.textStyleId) textStyled++;
      else if (n.textStyleId === figma.mixed) textStyled += 0.5;
      else add("typography", "Text without a text style (" + (n.fontName !== figma.mixed ? n.fontName.family + " " + n.fontName.style : "mixed fonts") + ", " + (n.fontSize !== figma.mixed ? round(n.fontSize) : "mixed") + " px)", n);
      const c = n.visible ? textContrast(n, pageBg) : null;
      if (c) {
        contrastTotal++;
        if (c.ratio >= c.min) contrastOk++;
        else add("contrast", "Contrast " + round(c.ratio) + ":1 is below " + c.min + ":1", n);
      }
    } else if (n.type !== "COMPONENT" && n.type !== "COMPONENT_SET" && n.type !== "SECTION") {
      layerTotal++;
      if (DEFAULT_NAME.test(n.name)) {
        layerDefault++;
        add("naming", "Default layer name", n);
      }
    }
  }

  // Styles: duplicates and unused.
  const styleTotal = styles.paint.length + styles.text.length + styles.effect.length;
  let styleProblems = 0;
  const seen: { [key: string]: string } = {};
  const dup = function (key: string, name: string, kind: string) {
    if (seen[key]) {
      styleProblems++;
      add("styles", kind + ' style "' + name + '" duplicates "' + seen[key] + '"');
    } else seen[key] = name;
  };
  for (let i = 0; i < styles.paint.length; i++) dup("p" + paintKey(styles.paint[i].paints), styles.paint[i].name, "Color");
  for (let i = 0; i < styles.text.length; i++) {
    const s = styles.text[i];
    dup("t" + JSON.stringify([s.fontName, s.fontSize, s.lineHeight, s.letterSpacing, s.textCase, s.textDecoration]), s.name, "Text");
  }
  for (let i = 0; i < styles.effect.length; i++) dup("e" + JSON.stringify(styles.effect[i].effects), styles.effect[i].name, "Effect");
  const wholeFile = !p.nodeId;
  if (wholeFile) {
    const all: BaseStyle[] = (styles.paint as BaseStyle[]).concat(styles.text, styles.effect);
    for (let i = 0; i < all.length; i++) {
      if (used[all[i].id]) continue;
      styleProblems++;
      add("styles", 'Style "' + all[i].name + '" is not used in this file');
    }
  }
  // Variables referenced by layers, styles or other variables.
  for (let i = 0; i < vars.vars.length; i++) {
    const v = vars.vars[i];
    const modes = Object.keys(v.valuesByMode);
    for (let k = 0; k < modes.length; k++) {
      const val: any = v.valuesByMode[modes[k]];
      if (val && val.type === "VARIABLE_ALIAS") use(val.id);
    }
  }
  for (let i = 0; i < styles.paint.length; i++) {
    const ps: any = styles.paint[i].paints;
    for (let k = 0; k < ps.length; k++) if (ps[k].boundVariables && ps[k].boundVariables.color) use(ps[k].boundVariables.color.id);
  }
  let unusedVars = 0;
  if (wholeFile) {
    for (let i = 0; i < vars.vars.length; i++) {
      if (used[vars.vars[i].id]) continue;
      unusedVars++;
      if (unusedVars <= 10) add("styles", 'Variable "' + vars.vars[i].name + '" is not used in this file');
    }
  }
  // Components without instances.
  let unusedComponents = 0;
  if (wholeFile) {
    for (let i = 0; i < Math.min(components.length, 300); i++) {
      const c: any = components[i];
      const parts: ComponentNode[] = c.type === "COMPONENT_SET" ? c.children : [c];
      let count = 0;
      for (let k = 0; k < parts.length && !count; k++) count += (await parts[k].getInstancesAsync()).length;
      if (!count) {
        unusedComponents++;
        add("styles", 'Component "' + c.name + '" has no instances');
      }
    }
  }

  const varNames = vars.vars.map(function (v) {
    return v.name;
  });
  const styleNames = (styles.paint as BaseStyle[]).concat(styles.text, styles.effect).map(function (s) {
    return s.name;
  });
  const naming = namingConsistency(varNames.concat(styleNames), "Token", issues);

  const categories: any = {
    tokens: { score: score(colorBound + numberBound, colorTotal + numberTotal), colors: { bound: colorBound, total: colorTotal }, numbers: { bound: numberBound, total: numberTotal } },
    contrast: { score: score(contrastOk, contrastTotal), passing: contrastOk, total: contrastTotal },
    typography: { score: score(textStyled, textTotal), styled: Math.floor(textStyled), total: textTotal },
    components: {
      score: Math.max(0, 100 - Math.round(((detached + overridden * 0.5) / Math.max(1, instanceCount + detached)) * 100)),
      instances: instanceCount,
      detachedSuspects: detached,
      heavilyOverridden: overridden,
      unused: wholeFile ? unusedComponents : undefined,
    },
    styles: {
      score: score(styleTotal + vars.vars.length + components.length - styleProblems - unusedVars - unusedComponents, styleTotal + vars.vars.length + components.length),
      styles: styleTotal,
      variables: vars.vars.length,
      problems: styleProblems + unusedVars + unusedComponents,
    },
    naming: {
      score: Math.round((score(layerTotal - layerDefault, layerTotal) + naming.score) / 2),
      defaultLayerNames: layerDefault,
      layers: layerTotal,
      tokenConvention: naming.convention,
    },
  };
  let total = 0;
  let weight = 0;
  const names = Object.keys(WEIGHTS);
  for (let i = 0; i < names.length; i++) {
    total += categories[names[i]].score * WEIGHTS[names[i]];
    weight += WEIGHTS[names[i]];
  }
  // A few issues of each category rather than hundreds of the most common one.
  const picked: Issue[] = [];
  for (let pass = 0; picked.length < MAX_ISSUES && pass < MAX_ISSUES; pass++) {
    let added = false;
    for (let c = 0; c < names.length && picked.length < MAX_ISSUES; c++) {
      const list = issues.filter(function (x) {
        return x.category === names[c];
      });
      if (list[pass]) {
        picked.push(list[pass]);
        added = true;
      }
    }
    if (!added) break;
  }
  return {
    scope: scope.label,
    score: Math.round(total / weight),
    categories: categories,
    issues: picked,
    totalIssues: issues.length,
    nodesChecked: nodes.length,
    truncated: scope.truncated,
  };
}

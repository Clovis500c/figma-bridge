(() => {
  // plugin/lib/util.ts
  function round(n) {
    return Math.round(n * 100) / 100;
  }
  function codeError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }
  var cancelled = {};
  function markCancelled(id) {
    cancelled[id] = true;
  }
  function clearCancelled(id) {
    delete cancelled[id];
  }
  function checkCancelled(id) {
    if (id && cancelled[id])
      throw codeError("Cancelled from the Figma plugin", "CANCELLED");
  }
  function parseHex(hex) {
    let h = String(hex).trim().replace(/^#/, "");
    if (h.length === 3 || h.length === 4) {
      h = h.split("").map(function(c) {
        return c + c;
      }).join("");
    }
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h))
      throw codeError("Invalid hex color: " + hex, "BAD_ARGS");
    const n = function(i) {
      return parseInt(h.slice(i, i + 2), 16) / 255;
    };
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  function toHex(c, opacity) {
    const part = function(v) {
      const s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
      return s.length === 1 ? "0" + s : s;
    };
    const a = c.a === undefined ? 1 : c.a;
    const alpha = a * (opacity === undefined ? 1 : opacity);
    return ("#" + part(c.r) + part(c.g) + part(c.b) + (alpha < 0.999 ? part(alpha) : "")).toUpperCase();
  }
  function luminance(c) {
    const ch = function(v) {
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  async function getNode(id) {
    const node = await figma.getNodeByIdAsync(String(id));
    if (!node)
      throw codeError("Node not found: " + id, "NOT_FOUND");
    return node;
  }
  async function parentFor(parentId) {
    if (!parentId)
      return figma.currentPage;
    const parent = await getNode(parentId);
    if (!("appendChild" in parent))
      throw codeError("Node " + parentId + " (" + parent.type + ") cannot have children", "BAD_ARGS");
    return parent;
  }
  function place(node, x, y) {
    const c = figma.viewport.center;
    node.x = typeof x === "number" ? x : Math.round(c.x - node.width / 2);
    node.y = typeof y === "number" ? y : Math.round(c.y - node.height / 2);
  }
  function isAutoLayout(node) {
    return !!node && "layoutMode" in node && node.layoutMode !== "NONE";
  }
  function isNode(v) {
    return v && typeof v === "object" && typeof v.id === "string" && typeof v.type === "string" && "removed" in v;
  }
  function toSafe(v, depth, seen) {
    if (v === null || v === undefined)
      return null;
    const t = typeof v;
    if (t === "number")
      return isFinite(v) ? v : String(v);
    if (t === "string" || t === "boolean")
      return v;
    if (t === "bigint" || t === "symbol")
      return String(v);
    if (t === "function")
      return "[Function]";
    if (v instanceof Uint8Array)
      return { type: "Uint8Array", length: v.length };
    if (isNode(v))
      return v.removed ? { id: v.id, removed: true } : { id: v.id, name: v.name, type: v.type };
    if (v instanceof Error)
      return { error: v.message };
    if (depth > 12)
      return "[MaxDepth]";
    if (seen.indexOf(v) !== -1)
      return "[Circular]";
    seen.push(v);
    let out;
    if (Array.isArray(v)) {
      out = v.slice(0, 5000).map(function(x) {
        return toSafe(x, depth + 1, seen);
      });
      if (v.length > 5000)
        out.push("… " + (v.length - 5000) + " more");
    } else if (v instanceof Map) {
      out = {};
      v.forEach(function(val, key) {
        out[String(key)] = toSafe(val, depth + 1, seen);
      });
    } else if (v instanceof Set) {
      out = toSafe(Array.from(v), depth + 1, seen);
    } else {
      out = {};
      const keys = Object.keys(v);
      for (let i = 0;i < keys.length; i++)
        out[keys[i]] = toSafe(v[keys[i]], depth + 1, seen);
    }
    seen.pop();
    return out;
  }
  function safeStringify(v) {
    try {
      return JSON.stringify(toSafe(v, 0, []));
    } catch (e) {
      return String(v);
    }
  }
  var WEIGHTS = {
    "100": "Thin",
    "200": "Extra Light",
    "300": "Light",
    "400": "Regular",
    "500": "Medium",
    "600": "Semi Bold",
    "700": "Bold",
    "800": "Extra Bold",
    "900": "Black"
  };
  function parseFont(font, weight, fallbackFamily) {
    let family = fallbackFamily || "Inter";
    let style = "Regular";
    if (typeof font === "string" && font) {
      const i = font.indexOf(":");
      family = i === -1 ? font : font.slice(0, i);
      if (i !== -1)
        style = font.slice(i + 1);
    } else if (font && typeof font.family === "string") {
      family = font.family;
      style = font.style || "Regular";
    }
    if (weight !== undefined && weight !== null)
      style = WEIGHTS[String(weight)] || String(weight);
    return { family, style };
  }
  var fontLoads = {};
  function loadFont(n) {
    const key = n.family + "\x00" + n.style;
    if (!fontLoads[key]) {
      fontLoads[key] = figma.loadFontAsync(n).catch(function(e) {
        delete fontLoads[key];
        throw codeError('Font "' + n.family + " " + n.style + '" is not available: ' + (e && e.message ? e.message : e), "FONT");
      });
    }
    return fontLoads[key];
  }
  function fontNamesOf(f) {
    if (typeof f === "string" || f && typeof f.family === "string")
      return [parseFont(f)];
    if (isNode(f) && f.type === "TEXT") {
      const text = f;
      if (text.characters.length)
        return text.getRangeAllFontNames(0, text.characters.length);
      return text.fontName === figma.mixed ? [] : [text.fontName];
    }
    if (Array.isArray(f)) {
      let all = [];
      for (let i = 0;i < f.length; i++)
        all = all.concat(fontNamesOf(f[i]));
      return all;
    }
    throw codeError("loadFonts: expected 'Family:Style', FontName or TextNode, got " + safeStringify(f), "BAD_ARGS");
  }
  var styleCache = null;
  var variableCache = null;
  var CACHE_MS = 5000;
  async function localStyles() {
    if (!styleCache || Date.now() - styleCache.at > CACHE_MS) {
      const res = await Promise.all([figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync()]);
      styleCache = { at: Date.now(), paint: res[0], text: res[1], effect: res[2] };
    }
    return styleCache;
  }
  async function localVariables() {
    if (!variableCache || Date.now() - variableCache.at > CACHE_MS) {
      const res = await Promise.all([figma.variables.getLocalVariablesAsync(), figma.variables.getLocalVariableCollectionsAsync()]);
      variableCache = { at: Date.now(), vars: res[0], collections: res[1] };
    }
    return variableCache;
  }
  function invalidateCaches() {
    styleCache = null;
    variableCache = null;
  }
  async function findVariable(ref) {
    const cache = await localVariables();
    const byId = {};
    for (let i = 0;i < cache.collections.length; i++)
      byId[cache.collections[i].id] = cache.collections[i].name;
    for (let i = 0;i < cache.vars.length; i++) {
      const v = cache.vars[i];
      if (v.name === ref || byId[v.variableCollectionId] + "/" + v.name === ref)
        return v;
    }
    throw codeError('Variable not found: "' + ref + '". Use get_design_system to list them.', "NOT_FOUND");
  }
  async function findStyle(kind, name) {
    const cache = await localStyles();
    const list = kind === "paint" ? cache.paint : kind === "text" ? cache.text : cache.effect;
    for (let i = 0;i < list.length; i++)
      if (list[i].name === name || list[i].id === name)
        return list[i];
    throw codeError("No local " + kind + ' style named "' + name + '". Use get_design_system to list them.', "NOT_FOUND");
  }
  var styleNames = {};
  async function styleName(id) {
    if (!id || typeof id !== "string")
      return null;
    if (styleNames[id] === undefined) {
      const s = await figma.getStyleByIdAsync(id);
      styleNames[id] = s ? s.name : "";
    }
    return styleNames[id] || null;
  }
  var componentCache = null;
  async function localComponents() {
    if (!componentCache || Date.now() - componentCache.at > 15000) {
      await figma.loadAllPagesAsync();
      const all = figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] });
      const list = all.filter(function(n) {
        return !(n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET");
      });
      componentCache = { at: Date.now(), list };
    }
    return componentCache.list;
  }
  function pageOf(node) {
    let p = node;
    while (p && p.type !== "PAGE")
      p = p.parent;
    return p;
  }
  function toLab(c) {
    const lin = function(v) {
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const r = lin(c.r);
    const g = lin(c.g);
    const b = lin(c.b);
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const f = function(t) {
      return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
    };
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  }
  function deltaE(a, b) {
    const l1 = toLab(a);
    const l2 = toLab(b);
    const rad = Math.PI / 180;
    const c1 = Math.sqrt(l1[1] * l1[1] + l1[2] * l1[2]);
    const c2 = Math.sqrt(l2[1] * l2[1] + l2[2] * l2[2]);
    const cm = (c1 + c2) / 2;
    const g = 0.5 * (1 - Math.sqrt(Math.pow(cm, 7) / (Math.pow(cm, 7) + Math.pow(25, 7))));
    const a1 = l1[1] * (1 + g);
    const a2 = l2[1] * (1 + g);
    const cp1 = Math.sqrt(a1 * a1 + l1[2] * l1[2]);
    const cp2 = Math.sqrt(a2 * a2 + l2[2] * l2[2]);
    const hue = function(x, y) {
      if (x === 0 && y === 0)
        return 0;
      const h = Math.atan2(y, x) / rad;
      return h < 0 ? h + 360 : h;
    };
    const h1 = hue(a1, l1[2]);
    const h2 = hue(a2, l2[2]);
    const dl = l2[0] - l1[0];
    const dc = cp2 - cp1;
    let dh = 0;
    if (cp1 * cp2 !== 0) {
      dh = h2 - h1;
      if (dh > 180)
        dh -= 360;
      else if (dh < -180)
        dh += 360;
    }
    const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh / 2 * rad);
    const lm = (l1[0] + l2[0]) / 2;
    const cpm = (cp1 + cp2) / 2;
    let hm = h1 + h2;
    if (cp1 * cp2 !== 0) {
      if (Math.abs(h1 - h2) > 180)
        hm += h1 + h2 < 360 ? 360 : -360;
      hm /= 2;
    }
    const t = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
    const sl = 1 + 0.015 * Math.pow(lm - 50, 2) / Math.sqrt(20 + Math.pow(lm - 50, 2));
    const sc = 1 + 0.045 * cpm;
    const sh = 1 + 0.015 * cpm * t;
    const rt = -2 * Math.sqrt(Math.pow(cpm, 7) / (Math.pow(cpm, 7) + Math.pow(25, 7))) * Math.sin(60 * Math.exp(-Math.pow((hm - 275) / 25, 2)) * rad);
    return Math.sqrt(Math.pow(dl / sl, 2) + Math.pow(dc / sc, 2) + Math.pow(dH / sh, 2) + rt * (dc / sc) * (dH / sh));
  }

  // plugin/lib/annotate.ts
  var COLORS = ["yellow", "orange", "red", "pink", "violet", "blue", "teal", "green"];
  async function categoryId(label, color, created) {
    const api = figma.annotations;
    if (!api || typeof api.getAnnotationCategoriesAsync !== "function")
      return;
    const list = await api.getAnnotationCategoriesAsync();
    for (let i = 0;i < list.length; i++)
      if (list[i].label.toLowerCase() === label.toLowerCase())
        return list[i].id;
    const c = COLORS.indexOf(String(color)) !== -1 ? color : "blue";
    const cat = await api.addAnnotationCategoryAsync({ label, color: c });
    created.push(label);
    return cat.id;
  }
  function supports(node) {
    return "annotations" in node;
  }
  async function annotate(p) {
    const action = String(p.action || (p.label || p.properties ? "add" : "list"));
    if (action === "list")
      return list(p);
    if (!p.nodeId)
      throw codeError("`nodeId` is required to " + action + " annotations", "BAD_ARGS");
    const node = await getNode(p.nodeId);
    if (!supports(node))
      throw codeError("A " + node.type + " node cannot have annotations", "BAD_ARGS");
    if (action === "clear") {
      const n = node.annotations.length;
      node.annotations = [];
      return { nodeId: node.id, removed: n };
    }
    if (action !== "add")
      throw codeError('Unknown action "' + action + '" (add, list, clear)', "BAD_ARGS");
    if (!p.label && !(p.properties && p.properties.length))
      throw codeError("Give a label and/or properties", "BAD_ARGS");
    const annotation = {};
    if (p.label)
      annotation.labelMarkdown = String(p.label);
    if (Array.isArray(p.properties) && p.properties.length) {
      annotation.properties = p.properties.map(function(t) {
        return { type: String(t) };
      });
    }
    const createdCategories = [];
    if (p.category) {
      const id = await categoryId(String(p.category), p.color, createdCategories);
      if (id)
        annotation.categoryId = id;
    }
    const current = p.replace ? [] : node.annotations.slice();
    try {
      node.annotations = current.concat([annotation]);
    } catch (e) {
      throw codeError("Figma rejected the annotation: " + (e.message || e) + " (check the property names)", "BAD_ARGS");
    }
    const out = { nodeId: node.id, annotations: node.annotations.length };
    if (createdCategories.length)
      out.createdCategory = createdCategories[0];
    return out;
  }
  async function list(p) {
    const root = p.nodeId ? await getNode(p.nodeId) : p.pageId ? await getNode(p.pageId) : figma.currentPage;
    if (root.type === "PAGE")
      await root.loadAsync();
    const nodes = (root.type === "PAGE" ? [] : [root]).concat("findAll" in root ? root.findAll(function(n) {
      return supports(n) && n.annotations.length > 0;
    }) : []);
    const categories = {};
    const api = figma.annotations;
    if (api && typeof api.getAnnotationCategoriesAsync === "function") {
      const cats = await api.getAnnotationCategoriesAsync();
      for (let i = 0;i < cats.length; i++)
        categories[cats[i].id] = cats[i].label;
    }
    const out = [];
    for (let i = 0;i < nodes.length && out.length < 300; i++) {
      const n = nodes[i];
      if (!supports(n) || !n.annotations.length)
        continue;
      out.push({
        nodeId: n.id,
        name: n.name,
        annotations: n.annotations.map(function(a) {
          const item = {};
          if (a.labelMarkdown || a.label)
            item.label = a.labelMarkdown || a.label;
          if (a.properties && a.properties.length) {
            item.properties = a.properties.map(function(x) {
              return x.type;
            });
          }
          if (a.categoryId)
            item.category = categories[a.categoryId] || a.categoryId;
          return item;
        })
      });
    }
    return { count: out.length, nodes: out };
  }

  // plugin/lib/health.ts
  var MAX_NODES = 20000;
  var MAX_ISSUES = 100;
  var WEIGHTS2 = { tokens: 25, contrast: 20, typography: 15, components: 15, styles: 15, naming: 10 };
  var NUMBER_FIELDS = ["itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
  var RADIUS_FIELDS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
  async function scopeNodes(p, wholeFile, requestId) {
    let roots;
    let label;
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
    const nodes = [];
    let truncated = false;
    const walk = function(n) {
      if (nodes.length >= MAX_NODES) {
        truncated = true;
        return;
      }
      if (n.type !== "PAGE" && n.type !== "DOCUMENT")
        nodes.push(n);
      if (n.type === "INSTANCE" || !("children" in n))
        return;
      if (n.type === "PAGE" && n.name === "⟲ Bridge checkpoints")
        return;
      for (let i = 0;i < n.children.length; i++)
        walk(n.children[i]);
    };
    for (let i = 0;i < roots.length; i++) {
      checkCancelled(requestId);
      walk(roots[i]);
    }
    return { nodes, truncated, label };
  }
  function visibleSolids(paints) {
    if (!paints || paints === figma.mixed)
      return [];
    return paints.filter(function(pt) {
      return pt.visible !== false && pt.type === "SOLID";
    });
  }
  function score(good, total) {
    return total ? Math.round(good / total * 100) : 100;
  }
  function convention(name) {
    const seg = name.split("/").pop() || name;
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(seg))
      return "kebab-case";
    if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(seg))
      return "snake_case";
    if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(seg))
      return "camelCase";
    if (/^[A-Z][a-z0-9]*( [A-Z0-9][a-z0-9]*)*$/.test(seg))
      return "Title Case";
    if (/^[a-z0-9]+$/.test(seg))
      return "lowercase";
    return "mixed";
  }
  function namingConsistency(names, what, issues) {
    const counts = {};
    const multiWord = [];
    for (let i = 0;i < names.length; i++) {
      const c = convention(names[i]);
      if (c === "lowercase")
        continue;
      counts[c] = (counts[c] || 0) + 1;
      multiWord.push(names[i]);
    }
    const keys = Object.keys(counts).sort(function(a, b) {
      return counts[b] - counts[a];
    });
    const main = keys[0] || "lowercase";
    const off = multiWord.filter(function(n) {
      return convention(n) !== main;
    });
    for (let i = 0;i < Math.min(off.length, 5); i++)
      issues.push({ category: "naming", message: what + ' "' + off[i] + '" is not ' + main + " like most others" });
    return { score: score(multiWord.length - off.length, multiWord.length), convention: main };
  }
  function paintKey(paints) {
    return JSON.stringify(paints.map(function(pt) {
      if (pt.type === "SOLID")
        return toHex(pt.color, pt.opacity) + (pt.boundVariables && pt.boundVariables.color ? "@" + pt.boundVariables.color.id : "");
      if (pt.gradientStops)
        return pt.type + pt.gradientStops.map(function(s) {
          return toHex(s.color) + round(s.position);
        });
      return pt.type + (pt.imageHash || "");
    }));
  }
  async function designSystemHealth(p, requestId) {
    const scope = await scopeNodes(p, !p.nodeId, requestId);
    const nodes = scope.nodes;
    const issues = [];
    const add = function(category, message, n) {
      if (issues.length < MAX_ISSUES * 3)
        issues.push(n ? { category, message, nodeId: n.id, name: n.name } : { category, message });
    };
    const styles = await localStyles();
    const vars = await localVariables();
    const components = await localComponents();
    const componentNames = {};
    for (let i = 0;i < components.length; i++)
      componentNames[components[i].name] = true;
    const used = {};
    const use = function(id) {
      if (typeof id === "string" && id)
        used[id] = (used[id] || 0) + 1;
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
    for (let i = 0;i < nodes.length; i++) {
      if (i % 500 === 0)
        checkCancelled(requestId);
      const n = nodes[i];
      const bound = n.boundVariables || {};
      const keys = Object.keys(bound);
      for (let k = 0;k < keys.length; k++) {
        const b = bound[keys[k]];
        if (Array.isArray(b))
          for (let j = 0;j < b.length; j++)
            use(b[j] && b[j].id);
        else if (b && b.id)
          use(b.id);
      }
      ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId"].forEach(function(f) {
        if (f in n)
          use(n[f]);
      });
      if (n.type === "INSTANCE") {
        instanceCount++;
        const fields = (n.overrides || []).reduce(function(sum, o) {
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
      const fillStyled = typeof n.fillStyleId === "string" && n.fillStyleId !== "";
      const solids = fillStyled ? [] : visibleSolids(n.fills);
      for (let k = 0;k < solids.length; k++) {
        colorTotal++;
        if (solids[k].boundVariables && solids[k].boundVariables.color)
          colorBound++;
        else
          add("tokens", "Hard-coded color " + toHex(solids[k].color, solids[k].opacity), n);
      }
      const strokeStyled = typeof n.strokeStyleId === "string" && n.strokeStyleId !== "";
      const strokes = strokeStyled ? [] : visibleSolids(n.strokes);
      for (let k = 0;k < strokes.length; k++) {
        colorTotal++;
        if (strokes[k].boundVariables && strokes[k].boundVariables.color)
          colorBound++;
      }
      if (fillStyled) {
        colorTotal++;
        colorBound++;
      }
      if (n.layoutMode && n.layoutMode !== "NONE") {
        for (let k = 0;k < NUMBER_FIELDS.length; k++) {
          const f = NUMBER_FIELDS[k];
          if (f === "counterAxisSpacing" && n.layoutWrap !== "WRAP")
            continue;
          if (!n[f])
            continue;
          numberTotal++;
          if (bound[f])
            numberBound++;
        }
      }
      if ("topLeftRadius" in n && n.type !== "TEXT") {
        for (let k = 0;k < RADIUS_FIELDS.length; k++) {
          if (!n[RADIUS_FIELDS[k]])
            continue;
          numberTotal++;
          if (bound[RADIUS_FIELDS[k]])
            numberBound++;
        }
      }
      if (n.type === "TEXT") {
        textTotal++;
        if (typeof n.textStyleId === "string" && n.textStyleId)
          textStyled++;
        else if (n.textStyleId === figma.mixed)
          textStyled += 0.5;
        else
          add("typography", "Text without a text style (" + (n.fontName !== figma.mixed ? n.fontName.family + " " + n.fontName.style : "mixed fonts") + ", " + (n.fontSize !== figma.mixed ? round(n.fontSize) : "mixed") + " px)", n);
        const c = n.visible ? textContrast(n, pageBg) : null;
        if (c) {
          contrastTotal++;
          if (c.ratio >= c.min)
            contrastOk++;
          else
            add("contrast", "Contrast " + round(c.ratio) + ":1 is below " + c.min + ":1", n);
        }
      } else if (n.type !== "COMPONENT" && n.type !== "COMPONENT_SET" && n.type !== "SECTION") {
        layerTotal++;
        if (DEFAULT_NAME.test(n.name)) {
          layerDefault++;
          add("naming", "Default layer name", n);
        }
      }
    }
    const styleTotal = styles.paint.length + styles.text.length + styles.effect.length;
    let styleProblems = 0;
    const seen = {};
    const dup = function(key, name, kind) {
      if (seen[key]) {
        styleProblems++;
        add("styles", kind + ' style "' + name + '" duplicates "' + seen[key] + '"');
      } else
        seen[key] = name;
    };
    for (let i = 0;i < styles.paint.length; i++)
      dup("p" + paintKey(styles.paint[i].paints), styles.paint[i].name, "Color");
    for (let i = 0;i < styles.text.length; i++) {
      const s = styles.text[i];
      dup("t" + JSON.stringify([s.fontName, s.fontSize, s.lineHeight, s.letterSpacing, s.textCase, s.textDecoration]), s.name, "Text");
    }
    for (let i = 0;i < styles.effect.length; i++)
      dup("e" + JSON.stringify(styles.effect[i].effects), styles.effect[i].name, "Effect");
    const wholeFile = !p.nodeId;
    if (wholeFile) {
      const all = styles.paint.concat(styles.text, styles.effect);
      for (let i = 0;i < all.length; i++) {
        if (used[all[i].id])
          continue;
        styleProblems++;
        add("styles", 'Style "' + all[i].name + '" is not used in this file');
      }
    }
    for (let i = 0;i < vars.vars.length; i++) {
      const v = vars.vars[i];
      const modes = Object.keys(v.valuesByMode);
      for (let k = 0;k < modes.length; k++) {
        const val = v.valuesByMode[modes[k]];
        if (val && val.type === "VARIABLE_ALIAS")
          use(val.id);
      }
    }
    for (let i = 0;i < styles.paint.length; i++) {
      const ps = styles.paint[i].paints;
      for (let k = 0;k < ps.length; k++)
        if (ps[k].boundVariables && ps[k].boundVariables.color)
          use(ps[k].boundVariables.color.id);
    }
    let unusedVars = 0;
    if (wholeFile) {
      for (let i = 0;i < vars.vars.length; i++) {
        if (used[vars.vars[i].id])
          continue;
        unusedVars++;
        if (unusedVars <= 10)
          add("styles", 'Variable "' + vars.vars[i].name + '" is not used in this file');
      }
    }
    let unusedComponents = 0;
    if (wholeFile) {
      for (let i = 0;i < Math.min(components.length, 300); i++) {
        const c = components[i];
        const parts = c.type === "COMPONENT_SET" ? c.children : [c];
        let count = 0;
        for (let k = 0;k < parts.length && !count; k++)
          count += (await parts[k].getInstancesAsync()).length;
        if (!count) {
          unusedComponents++;
          add("styles", 'Component "' + c.name + '" has no instances');
        }
      }
    }
    const varNames = vars.vars.map(function(v) {
      return v.name;
    });
    const styleNames2 = styles.paint.concat(styles.text, styles.effect).map(function(s) {
      return s.name;
    });
    const naming = namingConsistency(varNames.concat(styleNames2), "Token", issues);
    const categories = {
      tokens: { score: score(colorBound + numberBound, colorTotal + numberTotal), colors: { bound: colorBound, total: colorTotal }, numbers: { bound: numberBound, total: numberTotal } },
      contrast: { score: score(contrastOk, contrastTotal), passing: contrastOk, total: contrastTotal },
      typography: { score: score(textStyled, textTotal), styled: Math.floor(textStyled), total: textTotal },
      components: {
        score: Math.max(0, 100 - Math.round((detached + overridden * 0.5) / Math.max(1, instanceCount + detached) * 100)),
        instances: instanceCount,
        detachedSuspects: detached,
        heavilyOverridden: overridden,
        unused: wholeFile ? unusedComponents : undefined
      },
      styles: {
        score: score(styleTotal + vars.vars.length + components.length - styleProblems - unusedVars - unusedComponents, styleTotal + vars.vars.length + components.length),
        styles: styleTotal,
        variables: vars.vars.length,
        problems: styleProblems + unusedVars + unusedComponents
      },
      naming: {
        score: Math.round((score(layerTotal - layerDefault, layerTotal) + naming.score) / 2),
        defaultLayerNames: layerDefault,
        layers: layerTotal,
        tokenConvention: naming.convention
      }
    };
    let total = 0;
    let weight = 0;
    const names = Object.keys(WEIGHTS2);
    for (let i = 0;i < names.length; i++) {
      total += categories[names[i]].score * WEIGHTS2[names[i]];
      weight += WEIGHTS2[names[i]];
    }
    const picked = [];
    for (let pass = 0;picked.length < MAX_ISSUES && pass < MAX_ISSUES; pass++) {
      let added = false;
      for (let c = 0;c < names.length && picked.length < MAX_ISSUES; c++) {
        const list2 = issues.filter(function(x) {
          return x.category === names[c];
        });
        if (list2[pass]) {
          picked.push(list2[pass]);
          added = true;
        }
      }
      if (!added)
        break;
    }
    return {
      scope: scope.label,
      score: Math.round(total / weight),
      categories,
      issues: picked,
      totalIssues: issues.length,
      nodesChecked: nodes.length,
      truncated: scope.truncated,
      hint: "audit {fix:true} binds raw colors and numbers to matching variables, applies matching text styles and renames default layer names."
    };
  }
  function resolved(v, byId, collections, depth) {
    const col = collections[v.variableCollectionId];
    if (!col)
      return null;
    const raw = v.valuesByMode[col.defaultModeId];
    if (raw && raw.type === "VARIABLE_ALIAS") {
      const t = byId[raw.id];
      return t && (depth || 0) < 10 ? resolved(t, byId, collections, (depth || 0) + 1) : null;
    }
    return raw;
  }
  function scoped(v, wanted) {
    const s = v.scopes || [];
    if (!s.length || s.indexOf("ALL_SCOPES") !== -1)
      return true;
    for (let i = 0;i < wanted.length; i++)
      if (s.indexOf(wanted[i]) !== -1)
        return true;
    return false;
  }
  var FILL_SCOPES = { TEXT: ["ALL_FILLS", "TEXT_FILL"], FRAME: ["ALL_FILLS", "FRAME_FILL"], COMPONENT: ["ALL_FILLS", "FRAME_FILL"], SECTION: ["ALL_FILLS", "FRAME_FILL"] };
  async function autoFix(p, requestId) {
    const all = ["colors", "numbers", "textStyles", "names"];
    const fixes = Array.isArray(p.fixes) && p.fixes.length ? p.fixes : all;
    for (let i = 0;i < fixes.length; i++)
      if (all.indexOf(fixes[i]) === -1)
        throw codeError('Unknown fix "' + fixes[i] + '" (use ' + all.join(", ") + ")", "BAD_ARGS");
    const scope = await scopeNodes(p, false, requestId);
    const vars = await localVariables();
    const byId = {};
    const collections = {};
    for (let i = 0;i < vars.vars.length; i++)
      byId[vars.vars[i].id] = vars.vars[i];
    for (let i = 0;i < vars.collections.length; i++)
      collections[vars.collections[i].id] = vars.collections[i];
    const colorVars = [];
    const numberVars = [];
    for (let i = 0;i < vars.vars.length; i++) {
      const v = vars.vars[i];
      const value = resolved(v, byId, collections);
      if (v.resolvedType === "COLOR" && value && typeof value === "object")
        colorVars.push({ v, rgba: value });
      if (v.resolvedType === "FLOAT" && typeof value === "number")
        numberVars.push({ v, num: value });
    }
    const changes = [];
    const counts = { colors: 0, numbers: 0, textStyles: 0, names: 0 };
    const record = function(n, fix, from, to) {
      counts[fix]++;
      if (changes.length < 200)
        changes.push({ nodeId: n.id, name: n.name, fix, from, to });
    };
    const matchColor = function(n, paint, scopes) {
      const alpha = paint.opacity === undefined ? 1 : paint.opacity;
      const ranked = colorVars.filter(function(c) {
        return scoped(c.v, scopes) && Math.abs((c.rgba.a === undefined ? 1 : c.rgba.a) - alpha) < 0.02;
      }).map(function(c) {
        return { c, d: deltaE(c.rgba, paint.color) };
      }).filter(function(x) {
        return x.d < 2;
      }).sort(function(a, b) {
        return a.d - b.d;
      });
      for (let i = 0;i < ranked.length; i++) {
        try {
          const r = ranked[i].c.v.resolveForConsumer(n).value;
          if (r && typeof r === "object" && deltaE(r, paint.color) < 2)
            return ranked[i].c.v;
        } catch (e) {}
      }
      return null;
    };
    const matchNumber = function(value, scopes, hint) {
      const hits = numberVars.filter(function(c) {
        return Math.abs(c.num - value) < 0.01 && scoped(c.v, scopes);
      });
      hits.sort(function(a, b) {
        return (hint.test(b.v.name) ? 1 : 0) - (hint.test(a.v.name) ? 1 : 0);
      });
      return hits.length ? hits[0].v : null;
    };
    const textStyles = fixes.indexOf("textStyles") !== -1 ? (await localStyles()).text : [];
    for (let i = 0;i < scope.nodes.length; i++) {
      if (i % 200 === 0)
        checkCancelled(requestId);
      const n = scope.nodes[i];
      if (n.type === "INSTANCE" || n.locked)
        continue;
      const bound = n.boundVariables || {};
      if (fixes.indexOf("colors") !== -1) {
        const fields = ["fills", "strokes"];
        for (let f = 0;f < fields.length; f++) {
          const field = fields[f];
          if (!(field in n) || n[field] === figma.mixed)
            continue;
          if (field === "fills" && n.fillStyleId || field === "strokes" && n.strokeStyleId)
            continue;
          const paints = n[field].slice();
          let changed = false;
          for (let k = 0;k < paints.length; k++) {
            const pt = paints[k];
            if (pt.type !== "SOLID" || pt.visible === false || pt.boundVariables && pt.boundVariables.color)
              continue;
            const v = matchColor(n, pt, field === "strokes" ? ["STROKE_COLOR"] : FILL_SCOPES[n.type] || ["ALL_FILLS", "SHAPE_FILL"]);
            if (!v)
              continue;
            paints[k] = figma.variables.setBoundVariableForPaint(pt, "color", v);
            changed = true;
            record(n, "colors", field + " " + toHex(pt.color, pt.opacity), "var:" + v.name);
          }
          if (changed)
            n[field] = paints;
        }
      }
      if (fixes.indexOf("numbers") !== -1) {
        const fields = [];
        if (n.layoutMode && n.layoutMode !== "NONE") {
          for (let k = 0;k < NUMBER_FIELDS.length; k++)
            if (NUMBER_FIELDS[k] !== "counterAxisSpacing" || n.layoutWrap === "WRAP")
              fields.push(NUMBER_FIELDS[k]);
        }
        if ("topLeftRadius" in n && n.type !== "TEXT")
          for (let k = 0;k < RADIUS_FIELDS.length; k++)
            fields.push(RADIUS_FIELDS[k]);
        for (let k = 0;k < fields.length; k++) {
          const f = fields[k];
          const value = n[f];
          if (typeof value !== "number" || !value || bound[f])
            continue;
          const radius = f.indexOf("Radius") !== -1;
          const v = matchNumber(value, radius ? ["CORNER_RADIUS"] : ["GAP"], radius ? /radius|corner|round/i : /spac|gap|pad/i);
          if (!v)
            continue;
          try {
            n.setBoundVariable(f, v);
            record(n, "numbers", f + " " + round(value), "var:" + v.name);
          } catch (e) {}
        }
      }
      if (n.type === "TEXT" && textStyles.length && !n.textStyleId && n.fontName !== figma.mixed && n.fontSize !== figma.mixed && n.lineHeight !== figma.mixed && n.letterSpacing !== figma.mixed) {
        for (let k = 0;k < textStyles.length; k++) {
          const s = textStyles[k];
          if (s.fontName.family === n.fontName.family && s.fontName.style === n.fontName.style && Math.abs(s.fontSize - n.fontSize) < 0.01 && JSON.stringify(s.lineHeight) === JSON.stringify(n.lineHeight) && s.letterSpacing.unit === n.letterSpacing.unit && Math.abs(s.letterSpacing.value - n.letterSpacing.value) < 0.01) {
            try {
              await loadFont(s.fontName);
              await n.setTextStyleIdAsync(s.id);
              record(n, "textStyles", n.fontName.family + " " + n.fontName.style + " " + round(n.fontSize), "style:" + s.name);
            } catch (e) {}
            break;
          }
        }
      }
      if (fixes.indexOf("names") !== -1 && n.type !== "TEXT" && DEFAULT_NAME.test(n.name)) {
        const name = nameFromContent(n);
        if (name && name !== n.name) {
          const from = n.name;
          n.name = name;
          record(n, "names", from, name);
        }
      }
    }
    return { scope: scope.label, fixed: counts, changes, truncated: scope.truncated || changes.length >= 200 };
  }
  function firstText(n, depth) {
    if (n.type === "TEXT")
      return n.characters;
    if (depth > 3 || !("children" in n))
      return "";
    for (let i = 0;i < n.children.length; i++) {
      if (n.children[i].visible === false)
        continue;
      const t = firstText(n.children[i], depth + 1);
      if (t.trim())
        return t;
    }
    return "";
  }
  function hasImage(n) {
    return "fills" in n && n.fills !== figma.mixed && n.fills.some(function(f) {
      return f.type === "IMAGE" && f.visible !== false;
    });
  }
  function vectorOnly(n) {
    if (n.type === "VECTOR" || n.type === "BOOLEAN_OPERATION" || n.type === "STAR" || n.type === "POLYGON")
      return true;
    if (!("children" in n) || !n.children.length || n.type === "TEXT")
      return false;
    for (let i = 0;i < n.children.length; i++)
      if (!vectorOnly(n.children[i]))
        return false;
    return true;
  }
  function nameFromContent(n) {
    if (hasImage(n))
      return "Image";
    if (n.type === "VECTOR" || (n.type === "GROUP" || n.type === "FRAME") && vectorOnly(n))
      return "Icon";
    const text = firstText(n, 0).split(`
`)[0].trim();
    if (text)
      return text.length > 32 ? text.slice(0, 31) + "…" : text;
    if (n.layoutMode === "HORIZONTAL")
      return "Row";
    if (n.layoutMode === "VERTICAL")
      return "Column";
    if (n.layoutMode === "GRID")
      return "Grid";
    return null;
  }

  // plugin/lib/audit.ts
  var MAX_NODES2 = 5000;
  var MAX_ISSUES2 = 120;
  var DEFAULT_NAME = /^(Frame|Rectangle|Ellipse|Group|Vector|Text|Line|Polygon|Star|Component|Instance|Section|Image)( \d+)?$/;
  async function audit(p, _timeoutMs, requestId) {
    if (p.fix === true || Array.isArray(p.fixes) && p.fixes.length) {
      const fixed = await autoFix(p, requestId);
      invalidateCaches();
      const after = p.scope === "design-system" ? await designSystemHealth(p, requestId) : await lint(p);
      return Object.assign({ fixed: fixed.fixed, changes: fixed.changes, fixScope: fixed.scope }, after);
    }
    if (p.scope === "design-system")
      return designSystemHealth(p, requestId);
    return lint(p);
  }
  async function lint(p) {
    let roots;
    if (p.nodeId)
      roots = [await getNode(p.nodeId)];
    else if (figma.currentPage.selection.length)
      roots = figma.currentPage.selection.slice();
    else
      roots = figma.currentPage.children.slice();
    const only = Array.isArray(p.rules) && p.rules.length ? p.rules : null;
    const issues = [];
    const counts = {};
    const families = {};
    const sizes = {};
    let visited = 0;
    const pageBg = pageBackground();
    const report = function(rule, severity, n, message) {
      if (only && only.indexOf(rule) === -1)
        return;
      counts[rule] = (counts[rule] || 0) + 1;
      if (issues.length < MAX_ISSUES2)
        issues.push({ rule, severity, nodeId: n.id, name: n.name, message });
    };
    const visit = function(n, clipBox) {
      if (visited >= MAX_NODES2)
        return;
      visited++;
      if (n.visible === false)
        return;
      const box = n.absoluteBoundingBox || null;
      if (DEFAULT_NAME.test(n.name) && n.type !== "TEXT")
        report("default-name", "info", n, "Layer has a default name");
      if (clipBox && box && !inside(box, clipBox)) {
        const fully = box.x >= clipBox.x + clipBox.width || box.y >= clipBox.y + clipBox.height || box.x + box.width <= clipBox.x || box.y + box.height <= clipBox.y;
        report("clipped", fully ? "warning" : "info", n, fully ? "Completely hidden by a clipping parent" : "Partly cut off by a clipping parent");
      }
      if (n.type === "TEXT")
        checkText(n, report, families, sizes, pageBg);
      if (isAutoLayout(n)) {
        const vals = [n.itemSpacing, n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
        if (vals.some(function(v) {
          return typeof v === "number" && v % 4 !== 0;
        })) {
          report("off-grid", "info", n, "Spacing/padding not on a 4 px grid (" + vals.map(round).join(",") + ")");
        }
      } else if ((n.type === "FRAME" || n.type === "COMPONENT") && n.parent && n.parent.type !== "PAGE" && n.parent.type !== "SECTION") {
        const visibleKids = (n.children || []).filter(function(c) {
          return c.visible;
        });
        if (visibleKids.length >= 2)
          report("no-auto-layout", "info", n, "Frame with " + visibleKids.length + " children but no auto-layout");
      }
      if ((n.type === "FRAME" || n.type === "GROUP") && n.children && !n.children.length) {
        const hasFill = n.fills && n.fills !== figma.mixed && n.fills.length;
        if (!hasFill)
          report("empty", "info", n, "Empty layer with no fill");
      }
      if (typeof n.width === "number" && n.type !== "TEXT" && n.type !== "VECTOR" && n.type !== "LINE" && n.type !== "BOOLEAN_OPERATION" && n.type !== "STAR" && n.type !== "POLYGON") {
        if (Math.abs(n.width - Math.round(n.width)) > 0.01 || Math.abs(n.height - Math.round(n.height)) > 0.01) {
          report("fractional", "info", n, "Fractional size " + round(n.width) + "×" + round(n.height));
        }
      }
      const kids = n.children || [];
      const nextClip = n.clipsContent && box ? box : clipBox;
      for (let i = 0;i < kids.length; i++)
        visit(kids[i], nextClip);
    };
    for (let i = 0;i < roots.length; i++)
      visit(roots[i], null);
    const familyList = Object.keys(families);
    const sizeList = Object.keys(sizes).map(Number).sort(function(a, b) {
      return a - b;
    });
    if (familyList.length > 3)
      report("font-sprawl", "warning", roots[0], familyList.length + " font families: " + familyList.join(", "));
    if (sizeList.length > 8)
      report("type-scale", "warning", roots[0], sizeList.length + " different font sizes: " + sizeList.join(", "));
    const summary = { error: 0, warning: 0, info: 0 };
    const order = { error: 0, warning: 1, info: 2 };
    issues.sort(function(a, b) {
      return order[a.severity] - order[b.severity];
    });
    const bySeverity = {};
    for (let i = 0;i < issues.length; i++)
      bySeverity[issues[i].severity] = (bySeverity[issues[i].severity] || 0) + 1;
    summary.error = bySeverity.error || 0;
    summary.warning = bySeverity.warning || 0;
    summary.info = bySeverity.info || 0;
    return {
      summary,
      countsByRule: counts,
      nodesChecked: visited,
      fonts: familyList,
      fontSizes: sizeList,
      issues,
      truncated: visited >= MAX_NODES2 || issues.length >= MAX_ISSUES2
    };
  }
  function checkText(n, report, families, sizes, pageBg) {
    if (n.hasMissingFont)
      report("missing-font", "error", n, "Uses a font that is not installed");
    if (n.fontName !== figma.mixed)
      families[n.fontName.family] = true;
    if (n.fontSize !== figma.mixed) {
      sizes[round(n.fontSize)] = true;
      if (n.fontSize < 10)
        report("tiny-text", "warning", n, "Font size " + n.fontSize + " px is hard to read");
    }
    if (n.textTruncation === "DISABLED" && n.textAutoResize === "NONE" && n.characters.length > 0 && n.fontSize !== figma.mixed) {
      const lh = n.lineHeight !== figma.mixed && n.lineHeight.unit === "PIXELS" ? n.lineHeight.value : n.fontSize * 1.2;
      if (n.height + 0.5 < lh)
        report("text-overflow", "warning", n, "Fixed text box is shorter than one line");
    }
    const parent = n.parent;
    if (parent && parent.absoluteBoundingBox && n.absoluteBoundingBox && parent.type !== "PAGE" && parent.type !== "SECTION") {
      const pb = parent.absoluteBoundingBox;
      const tb = n.absoluteBoundingBox;
      if (tb.x + tb.width > pb.x + pb.width + 1 || tb.x < pb.x - 1)
        report("text-overflow", "warning", n, "Text extends outside its container");
    }
    const c = textContrast(n, pageBg);
    if (c && c.ratio < c.min) {
      report("contrast", c.ratio < c.min - 1.5 ? "error" : "warning", n, "Contrast " + round(c.ratio) + ":1 is below " + c.min + ":1 (WCAG AA" + (c.large ? ", large text" : "") + ")");
    }
  }
  function textContrast(n, pageBg) {
    const fg = solidOf(n.fills);
    if (!fg || n.fontSize === figma.mixed)
      return null;
    const bg = backgroundOf(n, pageBg);
    if (!bg)
      return null;
    const bold = n.fontName !== figma.mixed && /bold|black|heavy|semi/i.test(n.fontName.style);
    const large = n.fontSize >= 24 || bold && n.fontSize >= 18.66;
    return { ratio: contrastRatio(fg, bg), min: large ? 3 : 4.5, large };
  }
  function solidOf(paints) {
    if (!paints || paints === figma.mixed)
      return null;
    for (let i = paints.length - 1;i >= 0; i--) {
      const p = paints[i];
      if (p.visible !== false && p.type === "SOLID" && (p.opacity === undefined || p.opacity > 0.9))
        return p.color;
    }
    return null;
  }
  function backgroundOf(n, pageBg) {
    let p = n.parent;
    while (p && p.type !== "PAGE") {
      if (p.fills && p.fills !== figma.mixed) {
        const images = p.fills.some(function(f) {
          return f.visible !== false && (f.type === "IMAGE" || f.type.indexOf("GRADIENT") === 0);
        });
        if (images)
          return null;
        const c = solidOf(p.fills);
        if (c)
          return c;
      }
      p = p.parent;
    }
    return pageBg;
  }
  function pageBackground() {
    const bg = solidOf(figma.currentPage.backgrounds);
    return bg || { r: 1, g: 1, b: 1 };
  }
  function inside(a, b) {
    return a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
  }

  // plugin/lib/figjam.ts
  var EDITORS = { sticky: "figjam", shape: "figjam", connector: "figjam", table: "figjam", codeblock: "figjam", slide: "slides" };
  var EDITOR_NAMES = { figma: "Figma Design", figjam: "FigJam", slides: "Figma Slides", dev: "Dev Mode" };
  function requireEditor(type, path) {
    const wanted = EDITORS[type];
    if (wanted && figma.editorType !== wanted) {
      throw codeError(path + ': "' + type + '" needs a ' + EDITOR_NAMES[wanted] + " file; this file is open in " + (EDITOR_NAMES[figma.editorType] || figma.editorType) + ".", "WRONG_EDITOR");
    }
  }
  var STICKY_COLORS = {
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
    yellow: "#FFE299"
  };
  function solid(color) {
    const hex = STICKY_COLORS[String(color).toLowerCase()] || color;
    const c = parseHex(hex);
    return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  }
  async function setSublayerText(sub, text, opts) {
    const font = sub.fontName;
    if (font !== figma.mixed)
      await loadFont(font);
    else if (sub.characters.length) {
      const fonts = sub.getRangeAllFontNames(0, sub.characters.length);
      for (let i = 0;i < fonts.length; i++)
        await loadFont(fonts[i]);
    }
    if (opts && opts.font) {
      await loadFont(opts.font);
      sub.fontName = opts.font;
    }
    sub.characters = String(text === undefined || text === null ? "" : text);
    if (opts && typeof opts.size === "number")
      sub.fontSize = opts.size;
    if (opts && opts.color)
      sub.fills = [solid(opts.color)];
  }
  async function createSticky(s) {
    const n = figma.createSticky();
    if (s.wide)
      n.isWideWidth = true;
    if (s.author === false)
      n.authorVisible = false;
    if (s.color || s.fill)
      n.fills = [solid(s.color || s.fill)];
    await setSublayerText(n.text, s.text);
    return n;
  }
  var SHAPES = {
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
    storage: "INTERNAL_STORAGE"
  };
  async function createShape(s, path, warnings) {
    const n = figma.createShapeWithText();
    const key = String(s.shape || "rounded").toLowerCase().replace(/[^a-z]/g, "");
    const shape = SHAPES[key] || String(s.shape || "").toUpperCase();
    try {
      n.shapeType = shape;
    } catch (e) {
      warnings.push(path + ': unknown shape "' + s.shape + '", used a rounded rectangle');
      n.shapeType = "ROUNDED_RECTANGLE";
    }
    const w = typeof s.w === "number" ? s.w : typeof s.width === "number" ? s.width : 0;
    const h = typeof s.h === "number" ? s.h : typeof s.height === "number" ? s.height : 0;
    if (w || h)
      n.resize(w || n.width, h || n.height);
    if (s.fill !== undefined)
      n.fills = s.fill === null ? [] : [solid(s.fill)];
    if (s.stroke !== undefined)
      n.strokes = s.stroke === null ? [] : [solid(s.stroke)];
    if (typeof s.strokeWidth === "number")
      n.strokeWeight = s.strokeWidth;
    if (s.text !== undefined)
      await setSublayerText(n.text, s.text, { size: s.size, color: s.color });
    return n;
  }
  async function createTable(s, path) {
    const rows = Array.isArray(s.rows) ? s.rows : [];
    if (!rows.length)
      throw codeError(path + ': a table needs rows:[["Header 1","Header 2"],["a","b"]]', "BAD_ARGS");
    let cols = 0;
    for (let i = 0;i < rows.length; i++)
      cols = Math.max(cols, Array.isArray(rows[i]) ? rows[i].length : 1);
    const t = figma.createTable(rows.length, cols);
    for (let r = 0;r < rows.length; r++) {
      for (let c = 0;c < cols; c++) {
        const value = Array.isArray(rows[r]) ? rows[r][c] : c === 0 ? rows[r] : "";
        const cell = t.cellAt(r, c);
        await setSublayerText(cell.text, value === undefined ? "" : value);
        if (r === 0 && s.header !== false)
          cell.fills = [solid(s.headerFill || "#F2F2F2")];
      }
    }
    return t;
  }
  var LANGUAGES = ["TYPESCRIPT", "CPP", "RUBY", "CSS", "JAVASCRIPT", "HTML", "JSON", "GRAPHQL", "PYTHON", "GO", "SQL", "SWIFT", "KOTLIN", "RUST", "BASH", "PLAINTEXT", "DART"];
  var LANGUAGE_ALIASES = { ts: "TYPESCRIPT", tsx: "TYPESCRIPT", js: "JAVASCRIPT", jsx: "JAVASCRIPT", "c++": "CPP", py: "PYTHON", sh: "BASH", shell: "BASH", text: "PLAINTEXT", txt: "PLAINTEXT", golang: "GO", rb: "RUBY" };
  function createCodeBlock(s) {
    const n = figma.createCodeBlock();
    const lang = String(s.language || "plaintext").toLowerCase();
    const code = LANGUAGE_ALIASES[lang] || lang.toUpperCase();
    n.codeLanguage = LANGUAGES.indexOf(code) !== -1 ? code : "PLAINTEXT";
    n.code = String(s.code === undefined ? "" : s.code);
    return n;
  }
  function createSlide() {
    return figma.createSlide();
  }
  var CAPS = { arrow: "ARROW_LINES", triangle: "ARROW_EQUILATERAL", filled: "TRIANGLE_FILLED", diamond: "DIAMOND_FILLED", circle: "CIRCLE_FILLED", none: "NONE" };
  var LINES = { elbowed: "ELBOWED", elbow: "ELBOWED", straight: "STRAIGHT", curved: "CURVED", curve: "CURVED" };
  var MAGNETS = ["AUTO", "TOP", "LEFT", "BOTTOM", "RIGHT", "CENTER", "NONE"];
  async function createConnector(s, fromId, toId) {
    const n = figma.createConnector();
    const magnet = function(v) {
      const m = String(v || "AUTO").toUpperCase();
      return MAGNETS.indexOf(m) !== -1 ? m : "AUTO";
    };
    n.connectorStart = { endpointNodeId: fromId, magnet: magnet(s.fromMagnet) };
    n.connectorEnd = { endpointNodeId: toId, magnet: magnet(s.toMagnet) };
    n.connectorLineType = LINES[String(s.line || "elbowed").toLowerCase()] || "ELBOWED";
    n.connectorEndStrokeCap = CAPS[String(s.endArrow === undefined ? "arrow" : s.endArrow).toLowerCase()] || "ARROW_LINES";
    n.connectorStartStrokeCap = CAPS[String(s.startArrow === undefined ? "none" : s.startArrow).toLowerCase()] || "NONE";
    if (s.color || s.stroke)
      n.strokes = [solid(s.color || s.stroke)];
    if (typeof s.strokeWidth === "number")
      n.strokeWeight = s.strokeWidth;
    if (s.dashed)
      n.dashPattern = [8, 6];
    if (s.label !== undefined && s.label !== "")
      await setSublayerText(n.text, s.label);
    return n;
  }

  // plugin/lib/prototype.ts
  var TRIGGERS = {
    click: "ON_CLICK",
    tap: "ON_CLICK",
    hover: "ON_HOVER",
    press: "ON_PRESS",
    drag: "ON_DRAG",
    after: "AFTER_TIMEOUT",
    timeout: "AFTER_TIMEOUT",
    "mouse-enter": "MOUSE_ENTER",
    "mouse-leave": "MOUSE_LEAVE",
    "mouse-down": "MOUSE_DOWN",
    "mouse-up": "MOUSE_UP"
  };
  var NAVIGATION = {
    navigate: "NAVIGATE",
    overlay: "OVERLAY",
    swap: "SWAP",
    "swap-overlay": "SWAP",
    scroll: "SCROLL_TO",
    "scroll-to": "SCROLL_TO",
    "change-to": "CHANGE_TO"
  };
  var EASINGS = {
    linear: "LINEAR",
    "ease-in": "EASE_IN",
    "ease-out": "EASE_OUT",
    "ease-in-out": "EASE_IN_AND_OUT",
    "ease-in-back": "EASE_IN_BACK",
    "ease-out-back": "EASE_OUT_BACK",
    "ease-in-out-back": "EASE_IN_AND_OUT_BACK",
    gentle: "GENTLE",
    quick: "QUICK",
    bouncy: "BOUNCY",
    slow: "SLOW"
  };
  var DIRECTIONAL = {
    "move-in": "MOVE_IN",
    "move-out": "MOVE_OUT",
    push: "PUSH",
    slide: "SLIDE_IN",
    "slide-in": "SLIDE_IN",
    "slide-out": "SLIDE_OUT"
  };
  var key = function(v) {
    return String(v || "").toLowerCase().replace(/[_\s]+/g, "-");
  };
  function transition(spec) {
    let t = key(spec.transition || "instant");
    if (t === "instant" || t === "none")
      return null;
    let direction = key(spec.direction || "left");
    const m = /^(.*)-(left|right|top|bottom|up|down)$/.exec(t);
    if (m && DIRECTIONAL[m[1]]) {
      t = m[1];
      direction = m[2];
    }
    direction = direction === "up" ? "top" : direction === "down" ? "bottom" : direction;
    let ms = typeof spec.duration === "number" ? spec.duration : 300;
    if (ms <= 10)
      ms = ms * 1000;
    const easing = { type: EASINGS[key(spec.easing || "ease-out")] || "EASE_OUT" };
    const duration = ms / 1000;
    if (t === "dissolve" || t === "fade")
      return { type: "DISSOLVE", easing, duration };
    if (t === "smart" || t === "smart-animate")
      return { type: "SMART_ANIMATE", easing, duration };
    if (DIRECTIONAL[t]) {
      return {
        type: DIRECTIONAL[t],
        direction: direction.toUpperCase(),
        matchLayers: !!spec.matchLayers,
        easing,
        duration
      };
    }
    throw codeError('Unknown transition "' + spec.transition + '" (instant, dissolve, smart, move-in, move-out, push, slide-in, slide-out)', "BAD_ARGS");
  }
  function trigger(spec) {
    const t = TRIGGERS[key(spec.trigger || "click")];
    if (!t)
      throw codeError('Unknown trigger "' + spec.trigger + '" (click, hover, press, drag, after, mouse-enter, mouse-leave)', "BAD_ARGS");
    if (t === "AFTER_TIMEOUT")
      return { type: t, timeout: (typeof spec.delay === "number" ? spec.delay : 800) / 1000 };
    if (t === "MOUSE_ENTER" || t === "MOUSE_LEAVE")
      return { type: t, delay: (spec.delay || 0) / 1000, deprecatedVersion: false };
    if (t === "MOUSE_DOWN" || t === "MOUSE_UP")
      return { type: t, delay: (spec.delay || 0) / 1000 };
    return { type: t };
  }
  async function toReaction(spec, resolve) {
    const action = key(spec.action || (spec.url ? "url" : spec.to ? "navigate" : "back"));
    let act;
    if (action === "back")
      act = { type: "BACK" };
    else if (action === "close")
      act = { type: "CLOSE" };
    else if (action === "url" || action === "open-url")
      act = { type: "URL", url: String(spec.url) };
    else if (NAVIGATION[action]) {
      if (!spec.to)
        throw codeError('Action "' + action + '" needs `to` (a frame name or id)', "BAD_ARGS");
      act = { type: "NODE", destinationId: await resolve(String(spec.to)), navigation: NAVIGATION[action], transition: transition(spec), preserveScrollPosition: !!spec.preserveScroll };
    } else {
      throw codeError('Unknown action "' + spec.action + '" (navigate, overlay, swap, scroll-to, change-to, back, close, url)', "BAD_ARGS");
    }
    return { trigger: trigger(spec), actions: [act] };
  }
  async function resolveFrame(ref) {
    if (/^[\dI;:]+$/.test(ref))
      return (await getNode(ref)).id;
    const top = figma.currentPage.children;
    for (let i = 0;i < top.length; i++)
      if (top[i].name === ref)
        return top[i].id;
    const any = figma.currentPage.findOne(function(n) {
      return n.name === ref;
    });
    if (!any)
      throw codeError('No frame named "' + ref + '" on this page', "NOT_FOUND");
    return any.id;
  }
  async function setReactions(node, reactions, replace) {
    if (typeof node.setReactionsAsync !== "function")
      throw codeError("A " + node.type + " node cannot have prototype interactions", "BAD_ARGS");
    const current = replace ? [] : (node.reactions || []).slice();
    await node.setReactionsAsync(current.concat(reactions));
  }
  async function applyBuildReactions(pending, ids, warnings) {
    const resolve = function(ref) {
      return ids[ref] ? Promise.resolve(ids[ref]) : resolveFrame(ref);
    };
    for (let i = 0;i < pending.length; i++) {
      const item = pending[i];
      const list2 = Array.isArray(item.reactions) ? item.reactions : [item.reactions];
      const out = [];
      for (let k = 0;k < list2.length; k++) {
        try {
          out.push(await toReaction(list2[k] || {}, resolve));
        } catch (e) {
          warnings.push(item.path + ".reactions[" + k + "]: " + (e.message || e));
        }
      }
      try {
        if (out.length)
          await setReactions(item.node, out, false);
      } catch (e) {
        warnings.push(item.path + ".reactions: " + (e.message || e));
      }
    }
  }
  async function prototype(p) {
    const links = Array.isArray(p.links) ? p.links : [];
    const flows = Array.isArray(p.flows) ? p.flows : [];
    const clear = Array.isArray(p.clear) ? p.clear : [];
    const out = {};
    for (let i = 0;i < clear.length; i++)
      await setReactions(await getNode(clear[i]), [], true);
    if (clear.length)
      out.cleared = clear.length;
    const bySource = {};
    const order = [];
    for (let i = 0;i < links.length; i++) {
      const l = links[i] || {};
      if (!l.from)
        throw codeError("links[" + i + "]: `from` is required (the layer that reacts)", "BAD_ARGS");
      const from = await resolveFrame(String(l.from));
      let r;
      try {
        r = await toReaction(l, resolveFrame);
      } catch (e) {
        throw codeError("links[" + i + "]: " + (e.message || e), e.code || "BAD_ARGS");
      }
      if (!bySource[from]) {
        bySource[from] = [];
        order.push(from);
      }
      bySource[from].push(r);
    }
    for (let i = 0;i < order.length; i++)
      await setReactions(await getNode(order[i]), bySource[order[i]], !!p.replace);
    if (links.length)
      out.linked = links.length;
    if (flows.length) {
      const page = figma.currentPage;
      const points = page.flowStartingPoints.slice();
      for (let i = 0;i < flows.length; i++) {
        const f = flows[i] || {};
        const id = await resolveFrame(String(f.nodeId || f.frame || f.start || ""));
        const node = await getNode(id);
        if (!node.parent || node.parent.type !== "PAGE")
          throw codeError('Flow start "' + node.name + '" must be a top-level frame', "BAD_ARGS");
        const name = String(f.name || node.name);
        let found = false;
        for (let k = 0;k < points.length; k++) {
          if (points[k].nodeId === id) {
            points[k] = { nodeId: id, name };
            found = true;
          }
        }
        if (!found)
          points.push({ nodeId: id, name });
      }
      page.flowStartingPoints = points;
      out.flows = points;
    }
    if (p.list || !links.length && !flows.length && !clear.length)
      out.interactions = await listReactions(p.nodeId);
    return out;
  }
  async function listReactions(nodeId) {
    const root = nodeId ? await getNode(nodeId) : figma.currentPage;
    const nodes = (root.type === "PAGE" ? [] : [root]).concat("findAll" in root ? root.findAll(function(n) {
      return n.reactions && n.reactions.length > 0;
    }) : []);
    const names = {};
    const out = [];
    for (let i = 0;i < nodes.length && out.length < 300; i++) {
      const n = nodes[i];
      const reactions = n.reactions || [];
      for (let k = 0;k < reactions.length; k++) {
        const r = reactions[k];
        const actions = r.actions || (r.action ? [r.action] : []);
        for (let a = 0;a < actions.length; a++) {
          const act = actions[a];
          const item = { from: n.id, fromName: n.name, trigger: r.trigger ? r.trigger.type : null, action: act.type };
          if (act.type === "NODE") {
            item.navigation = act.navigation;
            item.to = act.destinationId;
            if (act.destinationId && names[act.destinationId] === undefined) {
              const dest = await figma.getNodeByIdAsync(act.destinationId);
              names[act.destinationId] = dest ? dest.name : "";
            }
            item.toName = names[act.destinationId] || undefined;
            if (act.transition)
              item.transition = act.transition.type + (act.transition.direction ? " " + act.transition.direction : "") + " " + Math.round(act.transition.duration * 1000) + "ms";
          }
          if (act.type === "URL")
            item.url = act.url;
          out.push(item);
        }
      }
    }
    return { flows: figma.currentPage.flowStartingPoints, links: out };
  }

  // plugin/lib/tokens.ts
  var TYPES = { color: "COLOR", number: "FLOAT", string: "STRING", boolean: "BOOLEAN" };
  function counter() {
    return { created: 0, updated: 0 };
  }
  async function designTokens(p) {
    const warnings = (p.warnings || []).slice();
    const counts = {
      collections: counter(),
      modes: counter(),
      variables: counter(),
      paintStyles: counter(),
      textStyles: counter(),
      effectStyles: counter()
    };
    const collections = Array.isArray(p.collections) ? p.collections : [];
    const styles = p.styles || {};
    if (!collections.length && !(styles.colors || []).length && !(styles.text || []).length && !(styles.effects || []).length) {
      throw codeError("No tokens found: give collections and/or styles (see the tool description for the accepted formats)", "BAD_ARGS");
    }
    if (collections.length)
      await writeVariables(collections, counts, warnings);
    invalidateCaches();
    await writeStyles(styles, counts, warnings);
    invalidateCaches();
    const out = { counts };
    if (warnings.length)
      out.warnings = warnings.slice(0, 60);
    return out;
  }
  async function writeVariables(specs, counts, warnings) {
    const allCollections = await figma.variables.getLocalVariableCollectionsAsync();
    const allVars = await figma.variables.getLocalVariablesAsync();
    const byName = {};
    const collName = {};
    for (let i = 0;i < allCollections.length; i++)
      collName[allCollections[i].id] = allCollections[i].name;
    const index = function(v, collectionName) {
      byName[collectionName + "/" + v.name] = v;
      if (!byName[v.name])
        byName[v.name] = v;
    };
    for (let i = 0;i < allVars.length; i++)
      index(allVars[i], collName[allVars[i].variableCollectionId]);
    const pending = [];
    for (let c = 0;c < specs.length; c++) {
      const spec = specs[c];
      let collection = null;
      for (let i = 0;i < allCollections.length; i++)
        if (allCollections[i].name === spec.name)
          collection = allCollections[i];
      const fresh = !collection;
      if (!collection) {
        collection = figma.variables.createVariableCollection(String(spec.name));
        counts.collections.created++;
      } else {
        counts.collections.updated++;
      }
      const modeIds = ensureModes(collection, spec.modes || [], fresh, counts, warnings);
      const existing = {};
      for (let i = 0;i < allVars.length; i++)
        if (allVars[i].variableCollectionId === collection.id)
          existing[allVars[i].name] = allVars[i];
      const vars = spec.variables || [];
      for (let i = 0;i < vars.length; i++) {
        const v = vars[i];
        const item = { variable: existing[v.name] || null, spec: v, collection, modeIds };
        if (item.variable && v.type && TYPES[v.type] && item.variable.resolvedType !== TYPES[v.type]) {
          warnings.push('"' + v.name + '" exists as ' + item.variable.resolvedType + ", cannot change it to " + TYPES[v.type] + ": skipped");
          continue;
        }
        pending.push(item);
      }
    }
    for (let pass = 0;pass < 4; pass++) {
      for (let i = 0;i < pending.length; i++) {
        const item = pending[i];
        if (item.variable)
          continue;
        const type = item.spec.type ? TYPES[item.spec.type] : aliasTargetType(item.spec, item.collection.name, byName);
        if (!type)
          continue;
        item.variable = figma.variables.createVariable(String(item.spec.name), item.collection, type);
        index(item.variable, item.collection.name);
        counts.variables.created++;
        item.spec.created = true;
      }
    }
    for (let i = 0;i < pending.length; i++) {
      const item = pending[i];
      const v = item.variable;
      if (!v) {
        warnings.push('"' + item.spec.name + '": alias target not found, skipped');
        continue;
      }
      if (!item.spec.created)
        counts.variables.updated++;
      if (item.spec.description !== undefined)
        v.description = String(item.spec.description);
      if (Array.isArray(item.spec.scopes)) {
        try {
          v.scopes = item.spec.scopes;
        } catch (e) {
          warnings.push('"' + v.name + '": invalid scopes (' + (e.message || e) + ")");
        }
      }
      const values = item.spec.values || {};
      const modes = Object.keys(values);
      for (let m = 0;m < modes.length; m++) {
        const targets = [];
        if (modes[m] === "*") {
          for (let k = 0;k < item.collection.modes.length; k++)
            targets.push(item.collection.modes[k].modeId);
        } else if (item.modeIds[modes[m]]) {
          targets.push(item.modeIds[modes[m]]);
        } else {
          warnings.push('"' + v.name + '": unknown mode "' + modes[m] + '"');
          continue;
        }
        let value;
        try {
          value = toVariableValue(values[modes[m]], v, item.collection.name, byName);
        } catch (e) {
          warnings.push('"' + v.name + '": ' + (e.message || e));
          continue;
        }
        for (let k = 0;k < targets.length; k++) {
          try {
            v.setValueForMode(targets[k], value);
          } catch (e) {
            warnings.push('"' + v.name + '": ' + (e.message || e));
          }
        }
      }
    }
  }
  function ensureModes(collection, names, fresh, counts, warnings) {
    const ids = {};
    if (fresh && names.length) {
      collection.renameMode(collection.modes[0].modeId, String(names[0]));
      counts.modes.created++;
    }
    for (let i = 0;i < collection.modes.length; i++)
      ids[collection.modes[i].name] = collection.modes[i].modeId;
    for (let i = 0;i < names.length; i++) {
      const name = String(names[i]);
      if (ids[name])
        continue;
      try {
        ids[name] = collection.addMode(name);
        counts.modes.created++;
      } catch (e) {
        warnings.push('Cannot add mode "' + name + '" to "' + collection.name + '": ' + (e.message || e) + " (the Figma plan may limit modes)");
      }
    }
    return ids;
  }
  function findAlias(ref, collectionName, byName) {
    return byName[collectionName + "/" + ref] || byName[ref] || null;
  }
  function aliasTargetType(spec, collectionName, byName) {
    const values = spec.values || {};
    const keys = Object.keys(values);
    for (let i = 0;i < keys.length; i++) {
      const v = values[keys[i]];
      if (v && typeof v === "object" && v.alias) {
        const target = findAlias(String(v.alias), collectionName, byName);
        if (target)
          return target.resolvedType;
      }
    }
    return null;
  }
  function toVariableValue(raw, v, collectionName, byName) {
    if (raw && typeof raw === "object" && raw.alias) {
      const target = findAlias(String(raw.alias), collectionName, byName);
      if (!target)
        throw new Error('alias target "' + raw.alias + '" not found');
      if (target.id === v.id)
        throw new Error("a variable cannot alias itself");
      return figma.variables.createVariableAlias(target);
    }
    switch (v.resolvedType) {
      case "COLOR":
        return parseHex(String(raw));
      case "FLOAT":
        if (typeof raw !== "number" && isNaN(Number(raw)))
          throw new Error("expected a number, got " + JSON.stringify(raw));
        return Number(raw);
      case "BOOLEAN":
        return raw === true || raw === "true";
      default:
        return String(raw);
    }
  }
  async function writeStyles(styles, counts, warnings) {
    const local = await localStyles();
    const find = function(list2, name) {
      for (let i = 0;i < list2.length; i++)
        if (list2[i].name === name)
          return list2[i];
      return null;
    };
    const colors = styles.colors || [];
    for (let i = 0;i < colors.length; i++) {
      const s = colors[i];
      try {
        const value = s.value !== undefined ? s.value : s.color;
        const list2 = Array.isArray(value) ? value : [value];
        const paints = [];
        for (let k = 0;k < list2.length; k++)
          paints.push(await toPaint(list2[k]));
        let style = find(local.paint, s.name);
        if (style)
          counts.paintStyles.updated++;
        else {
          style = figma.createPaintStyle();
          style.name = String(s.name);
          counts.paintStyles.created++;
        }
        style.paints = paints;
        if (s.description !== undefined)
          style.description = String(s.description);
      } catch (e) {
        warnings.push('Color style "' + s.name + '": ' + (e.message || e));
      }
    }
    const texts = styles.text || [];
    for (let i = 0;i < texts.length; i++) {
      const s = texts[i];
      try {
        const font = await loadWithFallback(parseFont(s.font || "Inter", s.weight), warnings);
        let style = find(local.text, s.name);
        if (style)
          counts.textStyles.updated++;
        else {
          style = figma.createTextStyle();
          style.name = String(s.name);
          counts.textStyles.created++;
        }
        style.fontName = font;
        if (typeof s.size === "number")
          style.fontSize = s.size;
        if (s.lineHeight !== undefined && s.lineHeight !== null)
          style.lineHeight = lineHeight(s.lineHeight);
        if (s.letterSpacing !== undefined && s.letterSpacing !== null) {
          const ls = String(s.letterSpacing);
          style.letterSpacing = /%$/.test(ls) ? { value: parseFloat(ls), unit: "PERCENT" } : { value: Number(s.letterSpacing), unit: "PIXELS" };
        }
        if (typeof s.paragraphSpacing === "number")
          style.paragraphSpacing = s.paragraphSpacing;
        const cases = { upper: "UPPER", lower: "LOWER", title: "TITLE", none: "ORIGINAL" };
        if (s.case && cases[s.case])
          style.textCase = cases[s.case];
        const deco = { underline: "UNDERLINE", strike: "STRIKETHROUGH", strikethrough: "STRIKETHROUGH", none: "NONE" };
        if (s.decoration && deco[s.decoration])
          style.textDecoration = deco[s.decoration];
        if (s.description !== undefined)
          style.description = String(s.description);
      } catch (e) {
        warnings.push('Text style "' + s.name + '": ' + (e.message || e));
      }
    }
    const effects = styles.effects || [];
    for (let i = 0;i < effects.length; i++) {
      const s = effects[i];
      try {
        const value = s.value !== undefined ? s.value : s;
        const list2 = Array.isArray(value) ? value : [value];
        const out = [];
        for (let k = 0;k < list2.length; k++) {
          const e = list2[k];
          if (e && typeof e.blur === "number" && e.type === "layer")
            out.push({ type: "LAYER_BLUR", radius: e.blur, visible: true });
          else if (e && typeof e.blur === "number" && e.type === "background")
            out.push({ type: "BACKGROUND_BLUR", radius: e.blur, visible: true });
          else
            out.push(shadowEffect(e || {}));
        }
        let style = find(local.effect, s.name);
        if (style)
          counts.effectStyles.updated++;
        else {
          style = figma.createEffectStyle();
          style.name = String(s.name);
          counts.effectStyles.created++;
        }
        style.effects = out;
        if (s.description !== undefined)
          style.description = String(s.description);
      } catch (e) {
        warnings.push('Effect style "' + s.name + '": ' + (e.message || e));
      }
    }
  }
  async function loadWithFallback(f, warnings) {
    const candidates = [f, { family: f.family, style: "Regular" }, { family: "Inter", style: "Regular" }];
    for (let i = 0;i < candidates.length; i++) {
      try {
        await loadFont(candidates[i]);
        if (i > 0)
          warnings.push('Font "' + f.family + " " + f.style + '" unavailable, used "' + candidates[i].family + " " + candidates[i].style + '"');
        return candidates[i];
      } catch (e) {}
    }
    throw codeError('No usable font for "' + f.family + " " + f.style + '"', "FONT");
  }
  async function applyModes(node, modes, warnings, path) {
    if (!modes || typeof modes !== "object" || typeof node.setExplicitVariableModeForCollection !== "function")
      return;
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const names = Object.keys(modes);
    for (let i = 0;i < names.length; i++) {
      let collection = null;
      for (let k = 0;k < collections.length; k++)
        if (collections[k].name === names[i] || collections[k].id === names[i])
          collection = collections[k];
      if (!collection) {
        warnings.push(path + ': no variable collection named "' + names[i] + '"');
        continue;
      }
      let modeId = "";
      for (let k = 0;k < collection.modes.length; k++)
        if (collection.modes[k].name === modes[names[i]])
          modeId = collection.modes[k].modeId;
      if (!modeId) {
        warnings.push(path + ': collection "' + collection.name + '" has no mode "' + modes[names[i]] + '"');
        continue;
      }
      node.setExplicitVariableModeForCollection(collection, modeId);
    }
  }

  // plugin/lib/build.ts
  var MAX_NODES3 = 3000;
  var SHADOW_DEFAULT = { x: 0, y: 4, blur: 16, spread: 0, color: "#0000001F" };
  async function build(p, _timeoutMs, requestId) {
    const spec = p.spec;
    if (!spec || typeof spec !== "object")
      throw codeError("`spec` must be a node object or an array of node objects", "BAD_ARGS");
    const roots = Array.isArray(spec) ? spec : Array.isArray(spec.slides) ? spec.slides.map(function(sl) {
      return Object.assign({ type: "slide" }, sl);
    }) : [spec];
    const d = p.defaults || {};
    const ctx = {
      warnings: [],
      ids: {},
      count: 0,
      images: p.imageBytes || {},
      fonts: {},
      defaults: { font: d.font || "Inter", color: d.color || "#111111", size: d.size || 14 },
      binds: [],
      reactions: [],
      connectors: [],
      keys: {},
      requestId,
      total: countNodes(roots),
      lastProgress: 0
    };
    await preloadFonts(roots, ctx);
    const parent = await parentFor(p.parentId);
    const made = [];
    let cursorX = null;
    for (let i = 0;i < roots.length; i++) {
      const node = await createNode(roots[i], parent, ctx, "spec" + (roots.length > 1 ? "[" + i + "]" : ""));
      if (!node)
        continue;
      if (node.type !== "SLIDE" && !isAutoLayout(parent) && roots[i].x === undefined && roots[i].y === undefined) {
        if (cursorX === null) {
          place(node, p.x, p.y);
        } else {
          node.x = cursorX;
          node.y = made[0].y;
        }
        cursorX = node.x + node.width + 80;
      }
      made.push(node);
    }
    if (ctx.reactions.length)
      await applyBuildReactions(ctx.reactions, ctx.ids, ctx.warnings);
    const connectors = await createConnectors(ctx);
    for (let i = 0;i < ctx.binds.length; i++)
      ctx.warnings.push(ctx.binds[i].path + ": bind needs a component or componentSet ancestor, ignored");
    if (p.select !== false && made.length && parent.type === "PAGE" && parent === figma.currentPage) {
      figma.currentPage.selection = made;
      figma.viewport.scrollAndZoomIntoView(made);
    }
    const out = {
      rootId: made.length ? made[0].id : null,
      rootIds: made.map(function(n) {
        return n.id;
      }),
      created: ctx.count + connectors,
      ids: ctx.ids
    };
    if (ctx.warnings.length)
      out.warnings = ctx.warnings.slice(0, 50);
    return out;
  }
  function countNodes(list2) {
    let n = 0;
    for (let i = 0;i < list2.length; i++) {
      const s = list2[i];
      if (!s || typeof s !== "object")
        continue;
      n++;
      if (Array.isArray(s.children))
        n += countNodes(s.children);
      if (Array.isArray(s.variants)) {
        for (let k = 0;k < s.variants.length; k++)
          n += countNodes([Object.assign({}, s.base || {}, s.variants[k])]);
      }
    }
    return n;
  }
  function progress(ctx) {
    if (!ctx.requestId)
      return;
    const now = Date.now();
    if (now - ctx.lastProgress < 150 && ctx.count < ctx.total)
      return;
    ctx.lastProgress = now;
    figma.ui.postMessage({ t: "progress", id: ctx.requestId, text: Math.min(ctx.count, ctx.total) + " / " + ctx.total + " layers" });
  }
  function fontKey(s, ctx) {
    return parseFont(s.font || ctx.defaults.font, s.weight, ctx.defaults.font);
  }
  function spanFont(s, span, ctx) {
    if (!span.font && span.weight === undefined)
      return null;
    return parseFont(span.font || s.font || ctx.defaults.font, span.weight !== undefined ? span.weight : span.font ? undefined : s.weight, ctx.defaults.font);
  }
  async function preloadFonts(roots, ctx) {
    const wanted = {};
    const walk = function(s) {
      if (!s || typeof s !== "object")
        return;
      if (nodeType(s) === "text") {
        const f = fontKey(s, ctx);
        wanted[f.family + ":" + f.style] = f;
        const spans = Array.isArray(s.spans) ? s.spans : [];
        for (let i = 0;i < spans.length; i++) {
          const sf = spanFont(s, spans[i] || {}, ctx);
          if (sf)
            wanted[sf.family + ":" + sf.style] = sf;
        }
      }
      if (Array.isArray(s.children))
        s.children.forEach(walk);
      if (Array.isArray(s.variants)) {
        for (let i = 0;i < s.variants.length; i++)
          walk(Object.assign({}, s.base || {}, s.variants[i], { type: "component" }));
      }
    };
    roots.forEach(walk);
    const keys = Object.keys(wanted);
    await Promise.all(keys.map(async function(key2) {
      const f = wanted[key2];
      const candidates = [f, { family: f.family, style: "Regular" }, { family: "Inter", style: f.style }, { family: "Inter", style: "Regular" }];
      for (let i = 0;i < candidates.length; i++) {
        try {
          await loadFont(candidates[i]);
          ctx.fonts[key2] = candidates[i];
          if (i > 0)
            ctx.warnings.push('Font "' + f.family + " " + f.style + '" unavailable, used "' + candidates[i].family + " " + candidates[i].style + '"');
          return;
        } catch (e) {}
      }
    }));
  }
  function nodeType(s) {
    if (s.type) {
      const t = String(s.type).toLowerCase().replace(/[_\s-]/g, "");
      return t === "rectangle" ? "rect" : t === "circle" ? "ellipse" : t === "variants" ? "componentset" : t === "shapewithtext" ? "shape" : t === "code" ? "codeblock" : t;
    }
    if (Array.isArray(s.variants))
      return "componentset";
    if (s.text !== undefined || Array.isArray(s.spans))
      return "text";
    if (s.svg)
      return "svg";
    if (s.icon)
      return "icon";
    if (s.imageKey || s.src)
      return "image";
    if (s.component)
      return "instance";
    return "frame";
  }
  async function createNode(s, parent, ctx, path) {
    if (!s || typeof s !== "object") {
      ctx.warnings.push(path + ": not an object, skipped");
      return null;
    }
    if (ctx.count >= MAX_NODES3)
      throw codeError("Spec is too large (max " + MAX_NODES3 + " nodes). Split it into several build calls.", "TOO_LARGE");
    checkCancelled(ctx.requestId);
    const type = nodeType(s);
    requireEditor(type, path);
    let node;
    switch (type) {
      case "connector":
        ctx.connectors.push({ spec: s, parent, path });
        return null;
      case "sticky":
        node = await createSticky(s);
        break;
      case "shape":
        node = await createShape(s, path, ctx.warnings);
        break;
      case "table":
        node = await createTable(s, path);
        break;
      case "codeblock":
        node = createCodeBlock(s);
        break;
      case "section":
        node = figma.createSection();
        break;
      case "slide":
        node = createSlide();
        break;
      case "frame":
      case "component":
        node = type === "component" ? figma.createComponent() : figma.createFrame();
        break;
      case "text":
        node = figma.createText();
        break;
      case "rect":
        node = figma.createRectangle();
        break;
      case "ellipse":
        node = figma.createEllipse();
        break;
      case "line":
        node = figma.createLine();
        break;
      case "svg":
      case "icon":
        if (!s.svg)
          throw codeError(path + ": icons must be created with the build tool (the server fetches the SVG)", "BAD_ARGS");
        node = figma.createNodeFromSvg(String(s.svg));
        break;
      case "image":
        node = figma.createRectangle();
        break;
      case "instance":
        node = await createInstance(s, path);
        break;
      case "componentset":
        node = await createComponentSet(s, parent, ctx, path);
        break;
      default:
        throw codeError(path + ': unknown type "' + s.type + '"', "BAD_ARGS");
    }
    ctx.count++;
    progress(ctx);
    if (type !== "slide" || parent.type !== "PAGE")
      parent.appendChild(node);
    const parentAuto = isAutoLayout(parent);
    if (s.key !== undefined)
      ctx.keys[String(s.key)] = node.id;
    if (s.bind)
      ctx.binds.push({ node, bind: s.bind, path });
    const bindStart = ctx.binds.length;
    if (s.name)
      node.name = String(s.name);
    else if (type === "icon")
      node.name = "icon/" + s.icon;
    if (type === "frame" || type === "component")
      await setupFrame(node, s, ctx, path);
    else if (type === "slide")
      await setupFrame(node, s, ctx, path, true);
    else if (type === "section")
      await setupSection(node, s, ctx, path);
    else if (type === "componentset")
      await setupLayout(node, Object.assign({ layout: "row", wrap: true, gap: 16, padding: 16 }, s), ctx, path);
    else if (type === "text")
      await setupText(node, s, ctx);
    else if (type === "image")
      await setupImage(node, s, ctx, path);
    else if (type === "line") {
      node.resize(num(s.w, s.width, 100), 0);
      if (s.stroke === undefined)
        node.strokes = [solid2(ctx.defaults.color)];
    } else if ((type === "rect" || type === "ellipse") && s.w === undefined && s.width === undefined && s.size === undefined) {
      node.resize(100, 100);
    }
    if (type === "instance" && s.text && typeof s.text === "object")
      await overrideTexts(node, s.text, ctx);
    if (type === "componentset" && s.stroke === undefined) {
      const set = node;
      set.strokes = [solid2("#9747FF")];
      set.dashPattern = [10, 5];
      set.cornerRadius = 5;
    }
    if (FIXED_LOOK.indexOf(type) === -1)
      await applyVisuals(node, s, ctx, type);
    else if (typeof s.opacity === "number")
      node.opacity = s.opacity;
    if (type === "text" && Array.isArray(s.spans))
      await applySpans(node, s, ctx, path);
    if (FIXED_LOOK.indexOf(type) === -1 && type !== "section" && type !== "slide")
      applySize(node, s, parentAuto, type, ctx, path);
    if (type === "component" && !s.variantOf)
      await addProperties(node, s.properties, ctx.binds.splice(bindStart), ctx, path);
    if (parent.layoutMode === "GRID")
      placeInGrid(node, s, ctx, path);
    if (s.absolute && parentAuto)
      node.layoutPositioning = "ABSOLUTE";
    if (!parentAuto || s.absolute) {
      if (typeof s.x === "number")
        node.x = s.x;
      if (typeof s.y === "number")
        node.y = s.y;
    }
    if (s.grow && parentAuto)
      node.layoutGrow = 1;
    if (typeof s.rotation === "number" && "rotation" in node)
      node.rotation = s.rotation;
    if (s.visible === false)
      node.visible = false;
    if (s.locked)
      node.locked = true;
    if (s.modes)
      await applyModes(node, s.modes, ctx.warnings, path);
    if (s.reactions)
      ctx.reactions.push({ node, reactions: s.reactions, path });
    if (s.name) {
      let key2 = String(s.name);
      for (let n = 2;ctx.ids[key2]; n++)
        key2 = s.name + " #" + n;
      if (Object.keys(ctx.ids).length < 300)
        ctx.ids[key2] = node.id;
    }
    return node;
  }
  var FIXED_LOOK = ["sticky", "shape", "table", "codeblock"];
  async function setupFrame(f, s, ctx, path, keepFills) {
    if (!keepFills)
      f.fills = [];
    await setupLayout(f, s, ctx, path);
    const children = Array.isArray(s.children) ? s.children : [];
    for (let i = 0;i < children.length; i++) {
      try {
        await createNode(children[i], f, ctx, path + ".children[" + i + "]");
      } catch (e) {
        if (e.code === "TOO_LARGE" || e.code === "CANCELLED" || e.code === "WRONG_EDITOR")
          throw e;
        ctx.warnings.push(path + ".children[" + i + "]: " + (e.message || e));
      }
    }
  }
  async function setupSection(sec, s, ctx, path) {
    const children = Array.isArray(s.children) ? s.children : [];
    const made = [];
    for (let i = 0;i < children.length; i++) {
      try {
        const n = await createNode(children[i], sec, ctx, path + ".children[" + i + "]");
        if (n)
          made.push(n);
      } catch (e) {
        if (e.code === "TOO_LARGE" || e.code === "CANCELLED" || e.code === "WRONG_EDITOR")
          throw e;
        ctx.warnings.push(path + ".children[" + i + "]: " + (e.message || e));
      }
    }
    const w = num(s.w, s.width, 0);
    const h = num(s.h, s.height, 0);
    if (w && h) {
      sec.resizeWithoutConstraints(w, h);
      return;
    }
    const pad = typeof s.padding === "number" ? s.padding : 40;
    let right = 0;
    let bottom = 0;
    for (let i = 0;i < made.length; i++) {
      right = Math.max(right, made[i].x + made[i].width);
      bottom = Math.max(bottom, made[i].y + made[i].height);
    }
    sec.resizeWithoutConstraints(Math.max(w || right + pad, 100), Math.max(h || bottom + pad, 100));
  }
  async function createConnectors(ctx) {
    let made = 0;
    for (let i = 0;i < ctx.connectors.length; i++) {
      const c = ctx.connectors[i];
      const ends = [];
      const sides = ["from", "to"];
      for (let k = 0;k < 2; k++) {
        const ref = c.spec[sides[k]];
        let id = ref === undefined ? "" : ctx.keys[String(ref)] || ctx.ids[String(ref)] || "";
        if (!id && ref !== undefined && /^[\dI;:]+$/.test(String(ref))) {
          const n = await figma.getNodeByIdAsync(String(ref));
          if (n)
            id = n.id;
        }
        ends.push(id);
      }
      if (!ends[0] || !ends[1]) {
        ctx.warnings.push(c.path + ': connector ends not found (from "' + c.spec.from + '", to "' + c.spec.to + '")');
        continue;
      }
      try {
        const n = await createConnector(c.spec, ends[0], ends[1]);
        c.parent.appendChild(n);
        if (c.spec.name)
          n.name = String(c.spec.name);
        made++;
      } catch (e) {
        ctx.warnings.push(c.path + ": " + (e.message || e));
      }
    }
    return made;
  }
  async function setupLayout(f, s, ctx, path) {
    const layout = String(s.layout || s.direction || "").toLowerCase();
    let mode = layout === "row" || layout === "horizontal" ? "HORIZONTAL" : layout === "column" || layout === "col" || layout === "vertical" ? "VERTICAL" : layout === "grid" ? "GRID" : "NONE";
    f.clipsContent = !!s.clip;
    if (mode === "GRID") {
      if (await setupGrid(f, s, ctx, path))
        return;
      mode = "HORIZONTAL";
      s = Object.assign({}, s, { wrap: true, rowGap: s.rowGap !== undefined ? s.rowGap : s.gap, gap: s.columnGap !== undefined ? s.columnGap : s.gap });
    }
    if (mode !== "NONE") {
      f.layoutMode = mode;
      f.primaryAxisSizingMode = "AUTO";
      f.counterAxisSizingMode = "AUTO";
      if (s.gap !== undefined) {
        if (s.gap === "auto")
          f.primaryAxisAlignItems = "SPACE_BETWEEN";
        else
          await setNumber(f, "itemSpacing", s.gap);
      }
      if (s.padding !== undefined)
        await setPadding(f, s.padding);
      const justify = { start: "MIN", center: "CENTER", end: "MAX", between: "SPACE_BETWEEN" };
      const align = { start: "MIN", center: "CENTER", end: "MAX", baseline: "BASELINE" };
      if (s.justify && justify[s.justify])
        f.primaryAxisAlignItems = justify[s.justify];
      if (s.align && align[s.align])
        f.counterAxisAlignItems = align[s.align];
      if (s.wrap && mode === "HORIZONTAL") {
        f.layoutWrap = "WRAP";
        if (s.rowGap !== undefined)
          await setNumber(f, "counterAxisSpacing", s.rowGap);
      }
    } else if (s.w === undefined && s.width === undefined && s.size === undefined && f.type !== "SLIDE") {
      f.resize(100, 100);
    }
  }
  function track(v, fallback) {
    if (typeof v === "number")
      return { type: "FIXED", value: v };
    const str = String(v === undefined ? "" : v).toLowerCase();
    if (str === "hug" || str === "auto")
      return { type: "HUG" };
    const fr = /^([\d.]+)fr$/.exec(str);
    if (fr)
      return { type: "FLEX", value: parseFloat(fr[1]) };
    const px = /^([\d.]+)(px)?$/.exec(str);
    if (px)
      return { type: "FIXED", value: parseFloat(px[1]) };
    return fallback === "FLEX" ? { type: "FLEX", value: 1 } : { type: "HUG" };
  }
  async function setupGrid(f, s, ctx, path) {
    try {
      f.layoutMode = "GRID";
    } catch (e) {
      ctx.warnings.push(path + ": grid auto-layout is not available in this Figma version, used a wrapping row");
      return false;
    }
    const kids = Array.isArray(s.children) ? s.children : [];
    const cols = Array.isArray(s.columns) ? s.columns : null;
    const rows = Array.isArray(s.rows) ? s.rows : null;
    const colCount = Math.max(1, cols ? cols.length : Number(s.columns) || 2);
    let cells = 0;
    for (let i = 0;i < kids.length; i++)
      cells += spanOf(kids[i], "col") * spanOf(kids[i], "row");
    const rowCount = Math.max(1, rows ? rows.length : Number(s.rows) || Math.ceil(cells / colCount));
    const fixedW = typeof s.w === "number" || typeof s.width === "number" || s.w === "fill";
    const fixedH = typeof s.h === "number" || typeof s.height === "number" || s.h === "fill";
    const set = function(what, fn) {
      try {
        fn();
      } catch (e) {
        ctx.warnings.push(path + ": grid " + what + ": " + (e.message || e));
      }
    };
    set("columns", function() {
      f.gridColumnCount = colCount;
    });
    set("rows", function() {
      f.gridRowCount = rowCount;
    });
    set("column sizes", function() {
      for (let i = 0;i < colCount; i++)
        applyTrack(f.gridColumnSizes[i], track(cols ? cols[i] : undefined, fixedW ? "FLEX" : "HUG"));
    });
    set("row sizes", function() {
      for (let i = 0;i < rowCount; i++)
        applyTrack(f.gridRowSizes[i], track(rows ? rows[i] : undefined, fixedH ? "FLEX" : "HUG"));
    });
    if (!fixedW)
      set("sizing", function() {
        f.layoutSizingHorizontal = "HUG";
      });
    if (!fixedH)
      set("sizing", function() {
        f.layoutSizingVertical = "HUG";
      });
    if ("gridItemsPositioning" in f)
      set("auto flow", function() {
        f.gridItemsPositioning = "ROW_AUTO_FLOW";
      });
    const colGap = s.columnGap !== undefined ? s.columnGap : s.gap;
    const rowGap = s.rowGap !== undefined ? s.rowGap : s.gap;
    if (colGap !== undefined && colGap !== "auto")
      await setNumber(f, "gridColumnGap", colGap);
    if (rowGap !== undefined && rowGap !== "auto")
      await setNumber(f, "gridRowGap", rowGap);
    if (s.padding !== undefined)
      await setPadding(f, s.padding);
    return true;
  }
  function applyTrack(t, spec) {
    if (!t)
      return;
    t.type = spec.type;
    if (spec.value !== undefined && spec.type !== "HUG")
      t.value = spec.value;
  }
  function spanOf(s, axis) {
    if (!s || typeof s !== "object")
      return 1;
    if (Array.isArray(s.span))
      return Math.max(1, Number(axis === "row" ? s.span[0] : s.span[1]) || 1);
    const v = axis === "col" ? s.colSpan !== undefined ? s.colSpan : s.span : s.rowSpan;
    return Math.max(1, Number(v) || 1);
  }
  function placeInGrid(node, s, ctx, path) {
    try {
      if (spanOf(s, "col") > 1)
        node.gridColumnSpan = spanOf(s, "col");
      if (spanOf(s, "row") > 1)
        node.gridRowSpan = spanOf(s, "row");
      const align = { start: "MIN", center: "CENTER", end: "MAX" };
      if (s.cellAlign && align[s.cellAlign])
        node.gridChildHorizontalAlign = align[s.cellAlign];
      if (s.cellValign && align[s.cellValign])
        node.gridChildVerticalAlign = align[s.cellValign];
    } catch (e) {
      ctx.warnings.push(path + ": grid span: " + (e.message || e));
    }
  }
  async function setupText(t, s, ctx) {
    const wanted = fontKey(s, ctx);
    t.fontName = ctx.fonts[wanted.family + ":" + wanted.style] || { family: "Inter", style: "Regular" };
    const spans = Array.isArray(s.spans) ? s.spans : [];
    t.characters = spans.length ? spans.map(function(sp) {
      return sp && sp.text !== undefined ? String(sp.text) : "";
    }).join("") : String(s.text === undefined ? "" : s.text);
    t.fontSize = typeof s.size === "number" ? s.size : ctx.defaults.size;
    if (s.lineHeight !== undefined)
      t.lineHeight = lineHeight(s.lineHeight);
    if (s.letterSpacing !== undefined) {
      const ls = String(s.letterSpacing);
      t.letterSpacing = /%$/.test(ls) ? { value: parseFloat(ls), unit: "PERCENT" } : { value: Number(s.letterSpacing), unit: "PIXELS" };
    }
    const halign = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" };
    if (s.align && halign[s.align])
      t.textAlignHorizontal = halign[s.align];
    const valign = { top: "TOP", center: "CENTER", bottom: "BOTTOM" };
    if (s.valign && valign[s.valign])
      t.textAlignVertical = valign[s.valign];
    if (s.decoration === "underline")
      t.textDecoration = "UNDERLINE";
    if (s.decoration === "strike" || s.decoration === "strikethrough")
      t.textDecoration = "STRIKETHROUGH";
    const cases = { upper: "UPPER", lower: "LOWER", title: "TITLE" };
    if (s.case && cases[s.case])
      t.textCase = cases[s.case];
    if (typeof s.maxLines === "number") {
      t.textTruncation = "ENDING";
      t.maxLines = s.maxLines;
    }
    if (s.fill === undefined && s.color === undefined && !s.textStyle)
      t.fills = [solid2(ctx.defaults.color)];
    if (s.textStyle) {
      const style = await findStyle("text", stripPrefix(s.textStyle));
      await loadFont(style.fontName);
      await t.setTextStyleIdAsync(style.id);
    }
  }
  async function applySpans(t, s, ctx, path) {
    let at = 0;
    for (let i = 0;i < s.spans.length; i++) {
      const sp = s.spans[i] || {};
      const end = at + String(sp.text === undefined ? "" : sp.text).length;
      if (end === at)
        continue;
      try {
        const f = spanFont(s, sp, ctx);
        if (f)
          t.setRangeFontName(at, end, ctx.fonts[f.family + ":" + f.style] || f);
        if (typeof sp.size === "number")
          t.setRangeFontSize(at, end, sp.size);
        const color = sp.color !== undefined ? sp.color : sp.fill;
        if (typeof color === "string" && color.indexOf("style:") === 0) {
          await t.setRangeFillStyleIdAsync(at, end, (await findStyle("paint", stripPrefix(color))).id);
        } else if (color !== undefined) {
          t.setRangeFills(at, end, [await toPaint(color, ctx.images)]);
        }
        const deco = { underline: "UNDERLINE", strike: "STRIKETHROUGH", strikethrough: "STRIKETHROUGH", none: "NONE" };
        if (sp.link) {
          t.setRangeHyperlink(at, end, { type: "URL", value: String(sp.link) });
          if (sp.decoration === undefined)
            t.setRangeTextDecoration(at, end, "UNDERLINE");
        }
        if (sp.decoration && deco[sp.decoration])
          t.setRangeTextDecoration(at, end, deco[sp.decoration]);
        const cases = { upper: "UPPER", lower: "LOWER", title: "TITLE", none: "ORIGINAL" };
        if (sp.case && cases[sp.case])
          t.setRangeTextCase(at, end, cases[sp.case]);
      } catch (e) {
        ctx.warnings.push(path + ".spans[" + i + "]: " + (e.message || e));
      }
      at = end;
    }
  }
  async function setupImage(r, s, ctx, path) {
    const bytes = ctx.images[s.imageKey];
    if (!bytes)
      throw codeError(path + ": image data missing (use `src` with the build tool)", "BAD_ARGS");
    const image = figma.createImage(bytes);
    const size = await image.getSizeAsync();
    let w = num(s.w, s.width, 0);
    let h = num(s.h, s.height, 0);
    if (!w && !h) {
      w = size.width;
      h = size.height;
    } else if (!h)
      h = w * size.height / size.width;
    else if (!w)
      w = h * size.width / size.height;
    r.resize(Math.max(1, w), Math.max(1, h));
    const modes = { fill: "FILL", fit: "FIT", crop: "CROP", tile: "TILE" };
    r.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: modes[String(s.fit || "fill").toLowerCase()] || "FILL" }];
    if (!s.name)
      r.name = "Image";
  }
  async function findComponent(ref, path) {
    let comp = null;
    if (/^[\dI;:]+$/.test(ref)) {
      const n = await figma.getNodeByIdAsync(ref);
      if (n && (n.type === "COMPONENT" || n.type === "COMPONENT_SET"))
        comp = n;
    } else if (/^[0-9a-f]{40}$/i.test(ref)) {
      comp = await figma.importComponentByKeyAsync(ref);
    } else {
      const list2 = await localComponents();
      for (let i = 0;i < list2.length && !comp; i++)
        if (list2[i].name === ref)
          comp = list2[i];
      for (let i = 0;i < list2.length && !comp; i++)
        if (list2[i].name.toLowerCase() === ref.toLowerCase())
          comp = list2[i];
    }
    if (!comp)
      throw codeError(path + ': component "' + ref + '" not found. Use get_design_system to list components.', "NOT_FOUND");
    return comp;
  }
  async function createInstance(s, path) {
    const comp = await findComponent(String(s.component), path);
    const main = comp.type === "COMPONENT_SET" ? comp.defaultVariant : comp;
    const inst = main.createInstance();
    if (s.props && typeof s.props === "object") {
      const defs = inst.componentProperties;
      const out = {};
      const keys = Object.keys(s.props);
      for (let i = 0;i < keys.length; i++) {
        const k = keys[i];
        let real = defs[k] ? k : "";
        if (!real) {
          const all = Object.keys(defs);
          for (let j = 0;j < all.length && !real; j++)
            if (all[j].split("#")[0] === k)
              real = all[j];
        }
        if (real)
          out[real] = s.props[k];
      }
      if (Object.keys(out).length)
        inst.setProperties(out);
    }
    return inst;
  }
  async function createComponentSet(s, parent, ctx, path) {
    const variants = Array.isArray(s.variants) ? s.variants : [];
    if (!variants.length)
      throw codeError(path + ': a componentSet needs variants:[{props:{Variant:"Primary"}, ...}]', "BAD_ARGS");
    const start = ctx.binds.length;
    const comps = [];
    for (let i = 0;i < variants.length; i++) {
      const v = Object.assign({}, s.base || {}, variants[i] || {});
      const props = v.props || {};
      const keys = Object.keys(props);
      if (!keys.length)
        throw codeError(path + ".variants[" + i + ']: props:{Name:"value"} is required', "BAD_ARGS");
      const spec = Object.assign({}, v, {
        type: "component",
        variantOf: true,
        name: keys.map(function(k) {
          return k + "=" + props[k];
        }).join(", ")
      });
      delete spec.props;
      comps.push(await createNode(spec, parent, ctx, path + ".variants[" + i + "]"));
    }
    const set = figma.combineAsVariants(comps, parent);
    set.name = String(s.name || "Component");
    await addProperties(set, s.properties, ctx.binds.splice(start), ctx, path);
    return set;
  }
  async function addProperties(owner, properties, binds, ctx, path) {
    const keys = {};
    const types = {};
    const props = properties && typeof properties === "object" ? properties : {};
    const names = Object.keys(props);
    for (let i = 0;i < names.length; i++) {
      const name = names[i];
      let def = props[name];
      if (typeof def === "string")
        def = { type: "text", default: def };
      else if (typeof def === "boolean")
        def = { type: "boolean", default: def };
      const t = String(def.type || "text").toLowerCase();
      try {
        if (t === "boolean" || t === "bool") {
          keys[name] = owner.addComponentProperty(name, "BOOLEAN", def.default !== false);
          types[name] = "BOOLEAN";
        } else if (t === "instance" || t === "instance_swap" || t === "swap") {
          const comp = await findComponent(String(def.default), path + ".properties." + name);
          const main = comp.type === "COMPONENT_SET" ? comp.defaultVariant : comp;
          const preferred = [];
          const list2 = Array.isArray(def.preferred) ? def.preferred : [];
          for (let k = 0;k < list2.length; k++) {
            const p = await findComponent(String(list2[k]), path + ".properties." + name);
            preferred.push({ type: p.type === "COMPONENT_SET" ? "COMPONENT_SET" : "COMPONENT", key: p.key });
          }
          keys[name] = owner.addComponentProperty(name, "INSTANCE_SWAP", main.id, preferred.length ? { preferredValues: preferred } : undefined);
          types[name] = "INSTANCE_SWAP";
        } else {
          keys[name] = owner.addComponentProperty(name, "TEXT", String(def.default === undefined ? "" : def.default));
          types[name] = "TEXT";
        }
      } catch (e) {
        ctx.warnings.push(path + ".properties." + name + ": " + (e.message || e));
      }
    }
    for (let i = 0;i < binds.length; i++) {
      const b = binds[i];
      const map = typeof b.bind === "string" ? { auto: b.bind } : b.bind;
      const refs = {};
      const fields = Object.keys(map || {});
      for (let k = 0;k < fields.length; k++) {
        const prop = String(map[fields[k]]);
        let field = fields[k];
        if (!keys[prop] && b.node.type === "TEXT" && (field === "auto" || field === "characters")) {
          keys[prop] = owner.addComponentProperty(prop, "TEXT", b.node.characters);
          types[prop] = "TEXT";
        }
        if (!keys[prop]) {
          ctx.warnings.push(b.path + ': no component property "' + prop + '" (declare it in properties)');
          continue;
        }
        if (field === "auto")
          field = types[prop] === "TEXT" ? "characters" : types[prop] === "BOOLEAN" ? "visible" : "mainComponent";
        refs[field] = keys[prop];
      }
      if (!Object.keys(refs).length)
        continue;
      try {
        b.node.componentPropertyReferences = Object.assign({}, b.node.componentPropertyReferences || {}, refs);
      } catch (e) {
        ctx.warnings.push(b.path + ": bind: " + (e.message || e));
      }
    }
  }
  async function overrideTexts(inst, texts, ctx) {
    const names = Object.keys(texts);
    for (let i = 0;i < names.length; i++) {
      const t = inst.findOne(function(n) {
        return n.type === "TEXT" && n.name === names[i];
      });
      if (!t) {
        ctx.warnings.push('No text layer "' + names[i] + '" in instance "' + inst.name + '"');
        continue;
      }
      const fonts = t.characters.length ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName];
      await Promise.all(fonts.map(loadFont));
      t.characters = String(texts[names[i]]);
    }
  }
  async function applyVisuals(node, s, ctx, type) {
    const fill = s.fill !== undefined ? s.fill : type === "text" ? s.color : undefined;
    if (fill !== undefined && "fills" in node && type !== "image")
      await setPaints(node, "fills", fill, ctx.images);
    if (s.stroke !== undefined && "strokes" in node) {
      await setPaints(node, "strokes", s.stroke, ctx.images);
      if (Array.isArray(s.strokeWidth) && "strokeTopWeight" in node) {
        const w = s.strokeWidth.map(Number);
        node.strokeTopWeight = w[0] || 0;
        node.strokeRightWeight = w[1] === undefined ? w[0] || 0 : w[1] || 0;
        node.strokeBottomWeight = w[2] === undefined ? w[0] || 0 : w[2] || 0;
        node.strokeLeftWeight = w[3] === undefined ? w[1] === undefined ? w[0] || 0 : w[1] || 0 : w[3] || 0;
      } else {
        node.strokeWeight = typeof s.strokeWidth === "number" ? s.strokeWidth : 1;
      }
      if (Array.isArray(s.strokeDash) && "dashPattern" in node)
        node.dashPattern = s.strokeDash.map(Number);
      if ("strokeAlign" in node && type !== "line" && type !== "text") {
        node.strokeAlign = String(s.strokeAlign || "inside").toUpperCase();
      }
    }
    if (s.radius !== undefined && "cornerRadius" in node) {
      if (Array.isArray(s.radius)) {
        const r = s.radius;
        await setNumber(node, "topLeftRadius", r[0]);
        await setNumber(node, "topRightRadius", r[1] === undefined ? r[0] : r[1]);
        await setNumber(node, "bottomRightRadius", r[2] === undefined ? r[0] : r[2]);
        await setNumber(node, "bottomLeftRadius", r[3] === undefined ? r[1] === undefined ? r[0] : r[1] : r[3]);
      } else if (typeof s.radius === "string" && s.radius.indexOf("var:") === 0) {
        const fields = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
        for (let i = 0;i < fields.length; i++)
          await setNumber(node, fields[i], s.radius);
      } else {
        node.cornerRadius = Number(s.radius);
      }
    }
    if (typeof s.opacity === "number")
      node.opacity = s.opacity;
    if ("effects" in node && (s.shadow !== undefined || s.blur !== undefined)) {
      if (typeof s.shadow === "string" && s.shadow.indexOf("style:") === 0) {
        const style = await findStyle("effect", stripPrefix(s.shadow));
        await node.setEffectStyleIdAsync(style.id);
      } else {
        const effects = [];
        const shadows = s.shadow === true ? [SHADOW_DEFAULT] : Array.isArray(s.shadow) ? s.shadow : s.shadow ? [s.shadow] : [];
        for (let i = 0;i < shadows.length; i++)
          effects.push(shadowEffect(shadows[i]));
        if (typeof s.blur === "number")
          effects.push({ type: "LAYER_BLUR", radius: s.blur, visible: true });
        if (typeof s.backgroundBlur === "number")
          effects.push({ type: "BACKGROUND_BLUR", radius: s.backgroundBlur, visible: true });
        node.effects = effects;
      }
    }
  }
  function shadowEffect(sh) {
    const c = parseHex(sh.color || SHADOW_DEFAULT.color);
    return {
      type: sh.inner ? "INNER_SHADOW" : "DROP_SHADOW",
      color: { r: c.r, g: c.g, b: c.b, a: c.a },
      offset: { x: num(sh.x, undefined, 0), y: num(sh.y, undefined, 4) },
      radius: num(sh.blur, undefined, 16),
      spread: num(sh.spread, undefined, 0),
      visible: true,
      blendMode: "NORMAL"
    };
  }
  function stripPrefix(v) {
    return String(v).replace(/^(style|var):/, "");
  }
  function solid2(hex) {
    const c = parseHex(hex);
    return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  }
  async function setPaints(node, field, value, images) {
    if (typeof value === "string" && value.indexOf("style:") === 0) {
      const style = await findStyle("paint", stripPrefix(value));
      if (field === "fills")
        await node.setFillStyleIdAsync(style.id);
      else
        await node.setStrokeStyleIdAsync(style.id);
      return;
    }
    const list2 = value === null || value === "none" ? [] : Array.isArray(value) ? value : [value];
    const paints = [];
    for (let i = 0;i < list2.length; i++)
      paints.push(await toPaint(list2[i], images));
    node[field] = paints;
  }
  var FITS = { fill: "FILL", cover: "FILL", fit: "FIT", contain: "FIT", crop: "CROP", tile: "TILE" };
  async function toPaint(v, images) {
    if (typeof v === "string") {
      if (v.indexOf("var:") === 0) {
        const variable = await findVariable(stripPrefix(v));
        return figma.variables.setBoundVariableForPaint(solid2("#000000"), "color", variable);
      }
      return solid2(v);
    }
    if (v && Array.isArray(v.gradient)) {
      const stops = v.gradient.map(function(c, i, all) {
        const hex = typeof c === "string" ? c : c.color;
        const pos = typeof c === "object" && typeof c.at === "number" ? c.at : all.length === 1 ? 0 : i / (all.length - 1);
        const rgba = parseHex(hex);
        return { position: pos, color: { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a } };
      });
      const radial = v.type === "radial";
      const a = (typeof v.angle === "number" ? v.angle : 90) * Math.PI / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const transform = radial ? [
        [1, 0, 0],
        [0, 1, 0]
      ] : [
        [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
        [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos]
      ];
      return { type: radial ? "GRADIENT_RADIAL" : "GRADIENT_LINEAR", gradientTransform: transform, gradientStops: stops };
    }
    if (v && v.imageKey !== undefined) {
      const bytes = images && images[v.imageKey];
      if (!bytes)
        throw codeError("Image fill data missing (use {image: src} with the build tool)", "BAD_ARGS");
      const paint = { type: "IMAGE", imageHash: figma.createImage(bytes).hash, scaleMode: FITS[String(v.fit || "fill").toLowerCase()] || "FILL" };
      if (typeof v.opacity === "number")
        return Object.assign({}, paint, { opacity: v.opacity });
      return paint;
    }
    if (v && typeof v.type === "string")
      return v;
    throw codeError("Invalid paint: " + JSON.stringify(v), "BAD_ARGS");
  }
  async function setNumber(node, field, value) {
    if (typeof value === "string" && value.indexOf("var:") === 0) {
      const variable = await findVariable(stripPrefix(value));
      node.setBoundVariable(field, variable);
    } else {
      node[field] = Number(value);
    }
  }
  async function setPadding(f, p) {
    const v = Array.isArray(p) ? p : [p];
    const top = v[0];
    const right = v[1] === undefined ? v[0] : v[1];
    const bottom = v[2] === undefined ? v[0] : v[2];
    const left = v[3] === undefined ? right : v[3];
    await setNumber(f, "paddingTop", top);
    await setNumber(f, "paddingRight", right);
    await setNumber(f, "paddingBottom", bottom);
    await setNumber(f, "paddingLeft", left);
  }
  function lineHeight(v) {
    if (v === "auto")
      return { unit: "AUTO" };
    const s = String(v);
    if (/%$/.test(s))
      return { value: parseFloat(s), unit: "PERCENT" };
    const n = Number(v);
    return n <= 4 ? { value: n * 100, unit: "PERCENT" } : { value: n, unit: "PIXELS" };
  }
  function num(a, b, fallback) {
    if (typeof a === "number")
      return a;
    if (typeof b === "number")
      return b;
    return fallback;
  }
  function sizing(v) {
    if (typeof v === "number")
      return "FIXED";
    if (v === "fill")
      return "FILL";
    if (v === "hug")
      return "HUG";
    return null;
  }
  function applySize(node, s, parentAuto, type, ctx, path) {
    let w = s.w !== undefined ? s.w : s.width;
    let h = s.h !== undefined ? s.h : s.height;
    if (typeof s.size === "number" && type !== "text") {
      if (w === undefined)
        w = s.size;
      if (h === undefined)
        h = s.size;
    }
    if (typeof w === "number" || typeof h === "number") {
      if (type === "svg" || type === "icon") {
        const ratio = node.height ? node.width / node.height : 1;
        const nw = typeof w === "number" ? w : h * ratio;
        const nh = typeof h === "number" ? h : w / ratio;
        node.rescale(Math.min(nw / node.width, nh / node.height));
      } else if (type !== "line" && type !== "image") {
        node.resize(Math.max(0.01, typeof w === "number" ? w : node.width), Math.max(0.01, typeof h === "number" ? h : node.height));
      }
    }
    if (type === "text") {
      const t = node;
      t.textAutoResize = typeof w === "number" || w === "fill" ? typeof h === "number" ? "NONE" : "HEIGHT" : "WIDTH_AND_HEIGHT";
    }
    if (!("layoutSizingHorizontal" in node))
      return;
    const hs = sizing(w);
    const vs = sizing(h);
    const trySet = function(field, value) {
      if (value === "FILL" && !parentAuto) {
        ctx.warnings.push(path + ': "fill" needs an auto-layout parent, ignored');
        return;
      }
      if (value === "HUG" && !isAutoLayout(node) && type !== "text")
        return;
      try {
        node[field] = value;
      } catch (e) {
        ctx.warnings.push(path + ": " + field + " " + value + " not applicable");
      }
    };
    if (hs)
      trySet("layoutSizingHorizontal", hs);
    if (vs)
      trySet("layoutSizingVertical", vs);
  }

  // plugin/lib/checkpoint.ts
  var PAGE_NAME = "⟲ Bridge checkpoints";
  var KEY = "bridge-checkpoint";
  async function checkpointPage(create) {
    for (let i = 0;i < figma.root.children.length; i++) {
      const p = figma.root.children[i];
      if (p.getPluginData(KEY) === "page" || p.name === PAGE_NAME) {
        await p.loadAsync();
        return p;
      }
    }
    if (!create)
      return null;
    const page = figma.createPage();
    page.name = PAGE_NAME;
    page.setPluginData(KEY, "page");
    return page;
  }
  function holders(page) {
    return page.children.filter(function(n) {
      return n.type === "FRAME" && !!n.getPluginData(KEY);
    });
  }
  function metaOf(f) {
    return JSON.parse(f.getPluginData(KEY));
  }
  async function checkpoint(p) {
    const action = String(p.action || "save");
    if (action === "save")
      return save(p);
    if (action === "list")
      return list2();
    if (action === "restore")
      return restore(p);
    if (action === "delete")
      return remove(p);
    throw codeError('Unknown checkpoint action "' + action + '" (save, list, restore, delete)', "BAD_ARGS");
  }
  async function save(p) {
    let nodes = [];
    if (Array.isArray(p.nodeIds) && p.nodeIds.length) {
      for (let i = 0;i < p.nodeIds.length; i++)
        nodes.push(await getNode(p.nodeIds[i]));
    } else {
      nodes = figma.currentPage.selection.slice();
    }
    if (!nodes.length)
      throw codeError("Nothing to save: pass nodeIds or select layers", "BAD_ARGS");
    const page = await checkpointPage(true);
    const meta = { id: String(Date.now().toString(36)), label: String(p.label || ""), at: Date.now() };
    const holder = figma.createFrame();
    page.appendChild(holder);
    holder.name = "Checkpoint " + meta.id + (meta.label ? " · " + meta.label : "");
    holder.fills = [];
    holder.clipsContent = false;
    holder.setPluginData(KEY, JSON.stringify(meta));
    const last = holders(page);
    holder.y = last.length > 1 ? last[last.length - 2].y + last[last.length - 2].height + 200 : 0;
    for (let i = 0;i < nodes.length; i++) {
      const n = nodes[i];
      const parent = n.parent;
      const item = { orig: n.id, parent: parent ? parent.id : "", index: parent ? parent.children.indexOf(n) : 0, x: n.x, y: n.y, name: n.name };
      const copy = n.clone();
      holder.appendChild(copy);
      copy.setPluginData(KEY, JSON.stringify(item));
    }
    return { checkpointId: meta.id, label: meta.label, saved: nodes.length };
  }
  async function list2() {
    const page = await checkpointPage(false);
    if (!page)
      return { checkpoints: [] };
    return {
      checkpoints: holders(page).map(function(h) {
        const m = metaOf(h);
        return {
          id: m.id,
          label: m.label,
          savedAt: new Date(m.at).toISOString(),
          layers: h.children.map(function(c) {
            return JSON.parse(c.getPluginData(KEY) || "{}").name || c.name;
          })
        };
      })
    };
  }
  async function find(id) {
    const page = await checkpointPage(false);
    if (page) {
      const all = holders(page);
      if (id === "latest" && all.length)
        return { page, holder: all[all.length - 1] };
      for (let i = 0;i < all.length; i++)
        if (metaOf(all[i]).id === id)
          return { page, holder: all[i] };
    }
    throw codeError('Checkpoint "' + id + '" not found. Use checkpoint {action:"list"}.', "NOT_FOUND");
  }
  async function restore(p) {
    const found = await find(String(p.id || "latest"));
    const restored = {};
    const kids = found.holder.children.slice();
    for (let i = 0;i < kids.length; i++) {
      const copy = kids[i];
      const item = JSON.parse(copy.getPluginData(KEY) || "{}");
      const original = item.orig ? await figma.getNodeByIdAsync(item.orig) : null;
      let parent = item.parent ? await figma.getNodeByIdAsync(item.parent) : null;
      let index = item.index;
      if (original && original.parent && !original.removed) {
        parent = original.parent;
        index = parent.children.indexOf(original);
        original.remove();
      }
      if (!parent || !("insertChild" in parent))
        parent = figma.currentPage;
      const fresh = copy.clone();
      fresh.setPluginData(KEY, "");
      parent.insertChild(Math.max(0, Math.min(index, parent.children.length)), fresh);
      if (!("layoutMode" in parent) || parent.layoutMode === "NONE" || fresh.layoutPositioning === "ABSOLUTE") {
        fresh.x = item.x;
        fresh.y = item.y;
      }
      fresh.name = item.name || fresh.name;
      restored[item.orig] = fresh.id;
    }
    return { restored, note: "Restored layers have new ids (old → new above). The checkpoint is kept." };
  }
  async function remove(p) {
    if (p.id === "all") {
      const page = await checkpointPage(false);
      if (page) {
        if (figma.currentPage === page)
          await figma.setCurrentPageAsync(figma.root.children[0]);
        page.remove();
      }
      return { deleted: "all" };
    }
    const found = await find(String(p.id || ""));
    found.holder.remove();
    if (!holders(found.page).length && figma.root.children.length > 1) {
      if (figma.currentPage === found.page)
        await figma.setCurrentPageAsync(figma.root.children[0]);
      found.page.remove();
    }
    return { deleted: p.id };
  }

  // plugin/lib/describe.ts
  async function describe(p) {
    let targets;
    if (p.nodeId)
      targets = [await getNode(p.nodeId)];
    else if (figma.currentPage.selection.length)
      targets = figma.currentPage.selection.slice();
    else
      targets = [figma.currentPage];
    for (let i = 0;i < targets.length; i++)
      if (targets[i].type === "PAGE")
        await targets[i].loadAsync();
    const maxDepth = Math.max(0, Math.min(12, typeof p.depth === "number" ? p.depth : 3));
    const budget = Math.max(10, Math.min(2000, p.maxNodes || 300));
    const lines = [];
    let count = 0;
    let truncated = false;
    const walk = async function(node, depth) {
      if (count >= budget) {
        truncated = true;
        return;
      }
      count++;
      lines.push(repeat("  ", depth) + await line(node));
      const kids = "children" in node ? node.children : [];
      if (!kids.length)
        return;
      if (depth >= maxDepth) {
        lines.push(repeat("  ", depth + 1) + "… " + kids.length + " children (increase depth or describe " + node.id + ")");
        return;
      }
      for (let i = 0;i < kids.length; i++) {
        if (count >= budget) {
          lines.push(repeat("  ", depth + 1) + "… " + (kids.length - i) + " more");
          truncated = true;
          return;
        }
        await walk(kids[i], depth + 1);
      }
    };
    for (let i = 0;i < targets.length; i++)
      await walk(targets[i], 0);
    return { outline: lines.join(`
`), nodes: count, truncated };
  }
  function repeat(s, n) {
    let out = "";
    for (let i = 0;i < n; i++)
      out += s;
    return out;
  }
  async function line(n) {
    const parts = [n.type, JSON.stringify(n.name), n.id];
    if (n.type === "PAGE" || n.type === "DOCUMENT")
      return parts.join(" ");
    if (n.visible === false)
      parts.push("[hidden]");
    if (typeof n.width === "number")
      parts.push(round(n.width) + "×" + round(n.height));
    if (n.parent && !isAutoLayout(n.parent) && typeof n.x === "number")
      parts.push("@" + round(n.x) + "," + round(n.y));
    if (n.parent && isAutoLayout(n.parent) && n.layoutSizingHorizontal) {
      parts.push("size:" + n.layoutSizingHorizontal.toLowerCase() + "/" + n.layoutSizingVertical.toLowerCase());
      if (n.layoutPositioning === "ABSOLUTE")
        parts.push("absolute");
    }
    if (isAutoLayout(n))
      parts.push(layoutText(n));
    if (n.clipsContent)
      parts.push("clip");
    if (n.type === "TEXT") {
      const text = n.characters.length > 80 ? n.characters.slice(0, 77) + "…" : n.characters;
      parts.push(JSON.stringify(text));
      if (n.fontName !== figma.mixed)
        parts.push(n.fontName.family + " " + n.fontName.style);
      else
        parts.push("mixed fonts");
      if (n.fontSize !== figma.mixed)
        parts.push(String(round(n.fontSize)) + "px");
      const lh = n.lineHeight;
      if (lh !== figma.mixed && lh.unit !== "AUTO")
        parts.push("lh:" + round(lh.value) + (lh.unit === "PERCENT" ? "%" : "px"));
      const ts = await styleName(n.textStyleId);
      if (ts)
        parts.push("textStyle:" + JSON.stringify(ts));
    }
    const fills = await paintsText(n, "fills", "fillStyleId");
    if (fills)
      parts.push((n.type === "TEXT" ? "color:" : "fill:") + fills);
    const strokes = await paintsText(n, "strokes", "strokeStyleId");
    if (strokes && n.strokeWeight !== figma.mixed && n.strokeWeight > 0)
      parts.push("stroke:" + strokes + " " + round(n.strokeWeight));
    if ("cornerRadius" in n) {
      if (n.cornerRadius === figma.mixed)
        parts.push("radius:" + [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].join(","));
      else if (n.cornerRadius > 0)
        parts.push("radius:" + round(n.cornerRadius));
    }
    if (typeof n.opacity === "number" && n.opacity < 1)
      parts.push("opacity:" + round(n.opacity));
    if (n.effects && n.effects.length) {
      const es = await styleName(n.effectStyleId);
      parts.push("effects:" + (es ? JSON.stringify(es) : n.effects.map(function(e) {
        return e.type.toLowerCase().replace("_shadow", "-shadow").replace("layer_", "").replace("background_", "bg-");
      }).join("+")));
    }
    if (n.type === "INSTANCE") {
      const main = await n.getMainComponentAsync();
      if (main) {
        const setName = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : main.name;
        parts.push("of:" + JSON.stringify(setName));
      }
      const props = n.componentProperties;
      const keys = Object.keys(props);
      if (keys.length) {
        parts.push("{" + keys.slice(0, 8).map(function(k) {
          return k.split("#")[0] + "=" + props[k].value;
        }).join(", ") + "}");
      }
    }
    if (n.type === "COMPONENT_SET") {
      const defs = n.componentPropertyDefinitions;
      parts.push("variants{" + Object.keys(defs).filter(function(k) {
        return defs[k].type === "VARIANT";
      }).map(function(k) {
        return k + ":" + (defs[k].variantOptions || []).join("|");
      }).join("; ") + "}");
    }
    if (n.boundVariables && Object.keys(n.boundVariables).length)
      parts.push("vars:" + Object.keys(n.boundVariables).join(","));
    return parts.join(" ");
  }
  function layoutText(n) {
    if (n.layoutMode === "GRID") {
      const gaps = n.gridColumnGap === n.gridRowGap ? "gap:" + round(n.gridColumnGap) : "gap:" + round(n.gridColumnGap) + "/" + round(n.gridRowGap);
      return "grid " + n.gridColumnCount + "×" + n.gridRowCount + (n.gridColumnGap || n.gridRowGap ? " " + gaps : "");
    }
    const out = [n.layoutMode === "HORIZONTAL" ? "row" : "column"];
    if (n.primaryAxisAlignItems === "SPACE_BETWEEN")
      out.push("gap:auto");
    else if (n.itemSpacing)
      out.push("gap:" + round(n.itemSpacing));
    const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(round);
    if (pad[0] || pad[1] || pad[2] || pad[3]) {
      out.push("pad:" + (pad[0] === pad[2] && pad[1] === pad[3] ? pad[0] === pad[1] ? pad[0] : pad[0] + "," + pad[1] : pad.join(",")));
    }
    const names = { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" };
    if (n.primaryAxisAlignItems !== "MIN" && n.primaryAxisAlignItems !== "SPACE_BETWEEN")
      out.push("justify:" + names[n.primaryAxisAlignItems]);
    if (n.counterAxisAlignItems !== "MIN")
      out.push("align:" + names[n.counterAxisAlignItems]);
    if (n.layoutWrap === "WRAP")
      out.push("wrap");
    return out.join(" ");
  }
  async function paintsText(n, field, styleField) {
    if (!(field in n))
      return null;
    const style = await styleName(n[styleField]);
    if (style)
      return "style:" + JSON.stringify(style);
    const paints = n[field];
    if (paints === figma.mixed)
      return "mixed";
    const visible = paints.filter(function(p) {
      return p.visible !== false;
    });
    if (!visible.length)
      return null;
    return visible.map(function(p) {
      if (p.type === "SOLID") {
        const bound = p.boundVariables && p.boundVariables.color ? "var" : "";
        return (bound ? bound + ":" : "") + toHex(p.color, p.opacity);
      }
      if (p.type === "IMAGE")
        return "image(" + String(p.scaleMode).toLowerCase() + ")";
      if (p.type.indexOf("GRADIENT") === 0) {
        return p.type.replace("GRADIENT_", "").toLowerCase() + "-gradient(" + p.gradientStops.map(function(s) {
          return toHex(s.color);
        }).join(",") + ")";
      }
      return p.type.toLowerCase();
    }).join("+");
  }

  // plugin/lib/export.ts
  var MAX_NODES4 = 1500;
  var MAX_ASSET_BYTES = 40 << 20;
  var VECTOR_TYPES = ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "ELLIPSE", "LINE"];
  var VISUAL_CSS = [
    "background",
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-radius",
    "box-shadow",
    "opacity",
    "filter",
    "backdrop-filter",
    "mix-blend-mode",
    "outline",
    "outline-offset"
  ];
  async function exportTree(p) {
    const node = p.nodeId ? await getNode(p.nodeId) : figma.currentPage.selection[0];
    if (!node)
      throw codeError("No nodeId given and nothing is selected", "BAD_ARGS");
    if (node.type === "PAGE" || node.type === "DOCUMENT")
      throw codeError("Export a frame or layer, not a page", "BAD_ARGS");
    const ctx = { count: 0, truncated: false, assets: {}, assetBytes: 0, imageFiles: {}, names: {}, warnings: [] };
    const tree = await walk(node, null, ctx);
    return { tree, assets: ctx.assets, nodes: ctx.count, truncated: ctx.truncated, warnings: ctx.warnings.slice(0, 40) };
  }
  function fileName(base, ext, ctx) {
    const clean = String(base).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "asset";
    const n = ctx.names[clean + ext] = (ctx.names[clean + ext] || 0) + 1;
    return clean + (n > 1 ? "-" + n : "") + "." + ext;
  }
  function sizing2(n, axis) {
    const v = n["layoutSizing" + (axis === "H" ? "Horizontal" : "Vertical")];
    return v === "FILL" ? "fill" : v === "HUG" ? "hug" : "fixed";
  }
  function isVectorOnly(n) {
    if (VECTOR_TYPES.indexOf(n.type) !== -1)
      return !hasImageFill(n);
    if (n.type === "TEXT" || hasImageFill(n))
      return false;
    if (!("children" in n) || !n.children.length)
      return false;
    for (let i = 0;i < n.children.length; i++)
      if (n.children[i].visible && !isVectorOnly(n.children[i]))
        return false;
    return true;
  }
  function hasImageFill(n) {
    return "fills" in n && n.fills !== figma.mixed && n.fills.some(function(f) {
      return f.type === "IMAGE" && f.visible !== false;
    });
  }
  async function imageAsset(n, ctx) {
    const paint = n.fills.filter(function(f) {
      return f.type === "IMAGE" && f.visible !== false;
    })[0];
    if (!paint || !paint.imageHash)
      return null;
    let file = ctx.imageFiles[paint.imageHash];
    if (!file) {
      const image = figma.getImageByHash(paint.imageHash);
      if (!image)
        return null;
      const bytes = await image.getBytesAsync();
      if (ctx.assetBytes + bytes.length > MAX_ASSET_BYTES) {
        ctx.warnings.push(n.name + ": image skipped (assets over " + (MAX_ASSET_BYTES >> 20) + " MB)");
        return null;
      }
      ctx.assetBytes += bytes.length;
      file = fileName(n.name, "img", ctx);
      ctx.assets[file] = { b64: figma.base64Encode(bytes) };
      ctx.imageFiles[paint.imageHash] = file;
    }
    return { file, fit: paint.scaleMode === "FIT" ? "contain" : paint.scaleMode === "TILE" ? "tile" : "cover" };
  }
  function tracks(list3) {
    return (list3 || []).map(function(t) {
      return t.type === "FIXED" ? round(t.value) + "px" : t.type === "HUG" ? "auto" : (t.value || 1) + "fr";
    });
  }
  async function walk(n, parent, ctx) {
    ctx.count++;
    const box = n.absoluteBoundingBox || { x: 0, y: 0, width: n.width || 0, height: n.height || 0 };
    const pbox = parent && parent.absoluteBoundingBox;
    const out = {
      id: n.id,
      name: n.name,
      type: n.type,
      x: pbox ? round(box.x - pbox.x) : 0,
      y: pbox ? round(box.y - pbox.y) : 0,
      w: round(box.width),
      h: round(box.height),
      sizeH: sizing2(n, "H"),
      sizeV: sizing2(n, "V")
    };
    if (n.layoutPositioning === "ABSOLUTE")
      out.absolute = true;
    if (n.layoutGrow === 1)
      out.grow = true;
    if (parent && parent.layoutMode === "GRID") {
      if (n.gridColumnSpan > 1)
        out.colSpan = n.gridColumnSpan;
      if (n.gridRowSpan > 1)
        out.rowSpan = n.gridRowSpan;
    }
    if (n.rotation && Math.abs(n.rotation) > 0.01 && n.type !== "TEXT")
      out.rotation = round(n.rotation);
    if (n.type === "INSTANCE") {
      const info = await instanceInfo(n);
      if (info)
        out.component = info;
    }
    let css = {};
    try {
      css = await n.getCSSAsync();
    } catch (e) {}
    const visual = {};
    for (let i = 0;i < VISUAL_CSS.length; i++)
      if (css[VISUAL_CSS[i]] !== undefined)
        visual[VISUAL_CSS[i]] = css[VISUAL_CSS[i]];
    out.css = visual;
    if (n.type !== "TEXT" && isVectorOnly(n)) {
      try {
        const svg = await n.exportAsync({ format: "SVG_STRING" });
        const file = fileName(n.name, "svg", ctx);
        ctx.assets[file] = { svg };
        out.asset = { file, kind: "svg" };
        out.css = {};
        return out;
      } catch (e) {
        ctx.warnings.push(n.name + ": SVG export failed, kept as a box");
      }
    }
    if (hasImageFill(n)) {
      const img = await imageAsset(n, ctx);
      if (img) {
        delete out.css.background;
        if ("children" in n && n.children.length)
          out.bgImage = img;
        else
          out.asset = { file: img.file, kind: "image", fit: img.fit };
      }
    }
    if (n.type === "TEXT") {
      out.text = textOf(n);
      return out;
    }
    if ("layoutMode" in n && n.layoutMode && n.layoutMode !== "NONE") {
      const l = {
        mode: n.layoutMode === "HORIZONTAL" ? "row" : n.layoutMode === "VERTICAL" ? "column" : "grid",
        padding: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(round)
      };
      if (l.mode === "grid") {
        l.columns = tracks(n.gridColumnSizes);
        l.rows = tracks(n.gridRowSizes);
        l.columnGap = round(n.gridColumnGap || 0);
        l.rowGap = round(n.gridRowGap || 0);
      } else {
        l.gap = n.primaryAxisAlignItems === "SPACE_BETWEEN" ? 0 : round(n.itemSpacing || 0);
        l.justify = n.primaryAxisAlignItems;
        l.align = n.counterAxisAlignItems;
        if (n.layoutWrap === "WRAP") {
          l.wrap = true;
          l.rowGap = round(n.counterAxisSpacing || 0);
        }
      }
      out.layout = l;
    }
    if (n.clipsContent)
      out.clip = true;
    if ("children" in n && n.children.length && !out.asset) {
      out.children = [];
      for (let i = 0;i < n.children.length; i++) {
        const c = n.children[i];
        if (!c.visible)
          continue;
        if (ctx.count >= MAX_NODES4) {
          ctx.truncated = true;
          break;
        }
        out.children.push(await walk(c, n, ctx));
      }
    }
    return out;
  }
  function textOf(t) {
    const segments = t.getStyledTextSegments(["fontName", "fontSize", "fontWeight", "fills", "textDecoration", "hyperlink", "letterSpacing", "lineHeight", "textCase"]);
    return {
      autoResize: t.textAutoResize,
      align: t.textAlignHorizontal,
      valign: t.textAlignVertical,
      truncate: t.textTruncation === "ENDING" ? t.maxLines || 1 : 0,
      segments: segments.map(function(s) {
        const fill = s.fills.filter(function(f) {
          return f.visible !== false;
        })[0];
        const seg = {
          text: s.characters,
          family: s.fontName.family,
          style: s.fontName.style,
          weight: s.fontWeight,
          size: round(s.fontSize)
        };
        if (fill && fill.type === "SOLID")
          seg.color = toHex(fill.color, fill.opacity);
        if (s.textDecoration !== "NONE")
          seg.decoration = s.textDecoration === "UNDERLINE" ? "underline" : "line-through";
        if (s.hyperlink && s.hyperlink.type === "URL")
          seg.link = s.hyperlink.value;
        if (s.letterSpacing && s.letterSpacing.value)
          seg.letterSpacing = s.letterSpacing.unit === "PERCENT" ? round(s.letterSpacing.value / 100) + "em" : round(s.letterSpacing.value) + "px";
        if (s.lineHeight && s.lineHeight.unit !== "AUTO")
          seg.lineHeight = s.lineHeight.unit === "PERCENT" ? String(round(s.lineHeight.value / 100)) : round(s.lineHeight.value) + "px";
        if (s.textCase && s.textCase !== "ORIGINAL")
          seg.textCase = s.textCase === "UPPER" ? "uppercase" : s.textCase === "LOWER" ? "lowercase" : "capitalize";
        return seg;
      })
    };
  }
  async function instanceInfo(n) {
    let main = null;
    try {
      main = await n.getMainComponentAsync();
    } catch (e) {}
    if (!main)
      return null;
    const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : null;
    const props = {};
    const defs = n.componentProperties;
    const keys = Object.keys(defs);
    for (let i = 0;i < keys.length; i++) {
      const d = defs[keys[i]];
      if (d.type === "INSTANCE_SWAP")
        continue;
      props[keys[i].split("#")[0]] = d.value;
    }
    const info = { name: set || main.name, props };
    if (set)
      info.variant = main.name;
    const text = n.findOne(function(t) {
      return t.type === "TEXT" && t.visible;
    });
    if (text && text.characters.trim())
      info.text = text.characters.trim().slice(0, 200);
    return info;
  }

  // plugin/lib/design-system.ts
  var ALL = ["colors", "text", "effects", "variables", "components"];
  async function getDesignSystem(p) {
    const include = Array.isArray(p.include) && p.include.length ? p.include : ALL;
    const limit = Math.max(1, Math.min(2000, p.limit || 300));
    const out = {};
    const counts = {};
    if (include.indexOf("colors") !== -1 || include.indexOf("text") !== -1 || include.indexOf("effects") !== -1) {
      const styles = await localStyles();
      if (include.indexOf("colors") !== -1) {
        counts.colors = styles.paint.length;
        out.colors = styles.paint.slice(0, limit).map(function(s) {
          return { name: s.name, value: paintValue(s.paints) };
        });
      }
      if (include.indexOf("text") !== -1) {
        counts.text = styles.text.length;
        out.text = styles.text.slice(0, limit).map(function(s) {
          const lh = s.lineHeight;
          return {
            name: s.name,
            font: s.fontName.family + ":" + s.fontName.style,
            size: round(s.fontSize),
            lineHeight: lh.unit === "AUTO" ? "auto" : round(lh.value) + (lh.unit === "PERCENT" ? "%" : "px"),
            letterSpacing: s.letterSpacing.value ? round(s.letterSpacing.value) + (s.letterSpacing.unit === "PERCENT" ? "%" : "px") : undefined
          };
        });
      }
      if (include.indexOf("effects") !== -1) {
        counts.effects = styles.effect.length;
        out.effects = styles.effect.slice(0, limit).map(function(s) {
          return {
            name: s.name,
            effects: s.effects.map(function(e) {
              return e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW" ? e.type.toLowerCase() + " " + e.offset.x + "," + e.offset.y + " blur " + e.radius + " " + toHex(e.color) : e.type.toLowerCase() + " " + e.radius;
            })
          };
        });
      }
    }
    if (include.indexOf("variables") !== -1) {
      const v = await localVariables();
      const byId = {};
      for (let i = 0;i < v.vars.length; i++)
        byId[v.vars[i].id] = v.vars[i];
      counts.variables = v.vars.length;
      out.variables = v.collections.map(function(c) {
        const defaultMode = c.defaultModeId;
        const vars = v.vars.filter(function(x) {
          return x.variableCollectionId === c.id;
        }).slice(0, limit).map(function(x) {
          return { name: x.name, type: x.resolvedType.toLowerCase(), value: variableValue(x.valuesByMode[defaultMode], byId) };
        });
        return {
          collection: c.name,
          modes: c.modes.map(function(m) {
            return m.name;
          }),
          variables: vars
        };
      });
    }
    if (include.indexOf("components") !== -1) {
      const list3 = await localComponents();
      counts.components = list3.length;
      out.components = list3.slice(0, limit).map(function(c) {
        const item = { name: c.name, id: c.id, page: (pageOf(c) || { name: "?" }).name };
        if (c.type === "COMPONENT_SET") {
          const defs = c.componentPropertyDefinitions;
          const props = {};
          const keys = Object.keys(defs);
          for (let i = 0;i < keys.length; i++) {
            const d = defs[keys[i]];
            props[keys[i].split("#")[0]] = d.type === "VARIANT" ? d.variantOptions : d.type.toLowerCase();
          }
          item.props = props;
          item.variants = c.children.length;
        } else {
          const defs = c.componentPropertyDefinitions;
          const keys = Object.keys(defs);
          if (keys.length) {
            item.props = {};
            for (let i = 0;i < keys.length; i++)
              item.props[keys[i].split("#")[0]] = defs[keys[i]].type.toLowerCase();
          }
        }
        if (c.description)
          item.description = c.description.slice(0, 120);
        item.key = c.key;
        return item;
      });
    }
    out.counts = counts;
    out.usage = 'In build specs: fill:"style:<color name>", textStyle:"style:<text name>", shadow:"style:<effect name>", ' + 'fill:"var:<variable>", gap/padding/radius:"var:<number variable>", {type:"instance", component:"<component name>", props:{...}}.';
    return out;
  }
  function paintValue(paints) {
    if (!paints.length)
      return "none";
    const p = paints[0];
    if (p.type === "SOLID")
      return toHex(p.color, p.opacity);
    if (p.type.indexOf("GRADIENT") === 0) {
      return p.type.replace("GRADIENT_", "").toLowerCase() + "-gradient(" + p.gradientStops.map(function(s) {
        return toHex(s.color);
      }).join(",") + ")";
    }
    return p.type.toLowerCase();
  }
  function variableValue(v, byId) {
    if (v && typeof v === "object") {
      if (v.type === "VARIABLE_ALIAS")
        return "→ " + (byId[v.id] ? byId[v.id].name : v.id);
      if ("r" in v)
        return toHex(v);
    }
    return v;
  }

  // plugin/lib/tokens-export.ts
  var TYPES2 = { COLOR: "color", FLOAT: "number", STRING: "string", BOOLEAN: "boolean" };
  async function exportTokens(p) {
    const only = Array.isArray(p.collections) && p.collections.length ? p.collections : null;
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const vars = await figma.variables.getLocalVariablesAsync();
    const byId = {};
    for (let i = 0;i < vars.length; i++)
      byId[vars[i].id] = vars[i];
    const collName = {};
    for (let i = 0;i < collections.length; i++)
      collName[collections[i].id] = collections[i].name;
    const warnings = [];
    const aliasOf = async function(id) {
      let v = byId[id] || null;
      if (!v) {
        try {
          v = await figma.variables.getVariableByIdAsync(id);
        } catch (e) {}
        if (v)
          byId[id] = v;
      }
      if (!v)
        return { alias: { collection: "", name: id, missing: true } };
      let collection = collName[v.variableCollectionId];
      if (collection === undefined) {
        try {
          const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
          collection = c ? c.name : "";
        } catch (e) {
          collection = "";
        }
        collName[v.variableCollectionId] = collection;
      }
      const out2 = { alias: { collection, name: v.name } };
      if (v.remote)
        out2.alias.remote = true;
      return out2;
    };
    const value = async function(raw, type) {
      if (raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS")
        return aliasOf(raw.id);
      if (type === "COLOR" && raw && typeof raw === "object")
        return toHex(raw);
      if (type === "FLOAT")
        return round(Number(raw));
      return raw;
    };
    const outCollections = [];
    for (let c = 0;c < collections.length; c++) {
      const col = collections[c];
      if (only && only.indexOf(col.name) === -1)
        continue;
      const modes = col.modes.slice().sort(function(a, b) {
        return (a.modeId === col.defaultModeId ? 0 : 1) - (b.modeId === col.defaultModeId ? 0 : 1);
      });
      const list3 = [];
      for (let i = 0;i < vars.length; i++) {
        const v = vars[i];
        if (v.variableCollectionId !== col.id)
          continue;
        const values = {};
        for (let m = 0;m < modes.length; m++)
          values[modes[m].name] = await value(v.valuesByMode[modes[m].modeId], v.resolvedType);
        const item = { name: v.name, type: TYPES2[v.resolvedType] || "string", values };
        if (v.description)
          item.description = v.description;
        if (v.scopes && v.scopes.length && !(v.scopes.length === 1 && v.scopes[0] === "ALL_SCOPES"))
          item.scopes = v.scopes.slice();
        if (v.hiddenFromPublishing)
          item.hidden = true;
        list3.push(item);
      }
      outCollections.push({
        name: col.name,
        modes: modes.map(function(m) {
          return m.name;
        }),
        variables: list3
      });
    }
    const styles = await localStyles();
    const paint = [];
    for (let i = 0;i < styles.paint.length; i++) {
      const s = styles.paint[i];
      const paints = [];
      for (let k = 0;k < s.paints.length; k++) {
        const pt = s.paints[k];
        if (pt.visible === false)
          continue;
        if (pt.type === "SOLID") {
          const bound = pt.boundVariables && pt.boundVariables.color;
          paints.push(bound ? await aliasOf(bound.id) : toHex(pt.color, pt.opacity));
        } else if (pt.type.indexOf("GRADIENT") === 0) {
          const t = pt.gradientTransform;
          const g = {
            gradient: pt.gradientStops.map(function(st) {
              return { color: toHex(st.color), at: round(st.position) };
            })
          };
          if (pt.type === "GRADIENT_LINEAR")
            g.angle = round(Math.atan2(t[0][1], t[0][0]) * 180 / Math.PI);
          else
            g.type = pt.type.replace("GRADIENT_", "").toLowerCase();
          paints.push(g);
        } else {
          warnings.push('Paint style "' + s.name + '": ' + pt.type.toLowerCase() + " paints are not exported");
        }
      }
      if (!paints.length)
        continue;
      const item = { name: s.name, value: paints.length === 1 ? paints[0] : paints };
      if (s.description)
        item.description = s.description;
      paint.push(item);
    }
    const text = [];
    for (let i = 0;i < styles.text.length; i++) {
      const s = styles.text[i];
      const item = { name: s.name, font: s.fontName.family, style: s.fontName.style, size: round(s.fontSize) };
      const lh = s.lineHeight;
      if (lh.unit === "PIXELS")
        item.lineHeight = round(lh.value);
      else if (lh.unit === "PERCENT")
        item.lineHeight = round(lh.value) + "%";
      if (s.letterSpacing.value)
        item.letterSpacing = s.letterSpacing.unit === "PERCENT" ? round(s.letterSpacing.value) + "%" : round(s.letterSpacing.value);
      if (s.textCase && s.textCase !== "ORIGINAL")
        item.case = s.textCase === "UPPER" ? "upper" : s.textCase === "LOWER" ? "lower" : "title";
      if (s.textDecoration && s.textDecoration !== "NONE")
        item.decoration = s.textDecoration === "UNDERLINE" ? "underline" : "strike";
      if (s.paragraphSpacing)
        item.paragraphSpacing = round(s.paragraphSpacing);
      const bound = s.boundVariables || {};
      const keys = Object.keys(bound);
      if (keys.length) {
        item.variables = {};
        for (let k = 0;k < keys.length; k++)
          if (bound[keys[k]] && bound[keys[k]].id)
            item.variables[keys[k]] = (await aliasOf(bound[keys[k]].id)).alias;
      }
      if (s.description)
        item.description = s.description;
      text.push(item);
    }
    const effect = [];
    for (let i = 0;i < styles.effect.length; i++) {
      const s = styles.effect[i];
      const list3 = [];
      for (let k = 0;k < s.effects.length; k++) {
        const e = s.effects[k];
        if (e.visible === false)
          continue;
        if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
          const sh = { x: round(e.offset.x), y: round(e.offset.y), blur: round(e.radius), spread: round(e.spread || 0), color: toHex(e.color) };
          if (e.type === "INNER_SHADOW")
            sh.inner = true;
          if (e.boundVariables && e.boundVariables.color)
            sh.colorVariable = (await aliasOf(e.boundVariables.color.id)).alias;
          list3.push(sh);
        } else {
          list3.push({ type: e.type === "LAYER_BLUR" ? "layer" : "background", blur: round(e.radius) });
        }
      }
      if (!list3.length)
        continue;
      const item = { name: s.name, value: list3 };
      if (s.description)
        item.description = s.description;
      effect.push(item);
    }
    const out = { fileName: figma.root.name, collections: outCollections, styles: { colors: paint, text, effects: effect } };
    if (warnings.length)
      out.warnings = warnings.slice(0, 40);
    return out;
  }

  // plugin/lib/find.ts
  var MAX_LIMIT = 500;
  function matcher(q) {
    if (q === undefined || q === null || q === "")
      return null;
    const str = String(q);
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(str);
    if (m) {
      let re;
      try {
        re = new RegExp(m[1], m[2].replace("g", ""));
      } catch (e) {
        throw codeError("Invalid regex " + str + ": " + (e.message || e), "BAD_ARGS");
      }
      return function(s) {
        return re.test(s);
      };
    }
    const needle = str.toLowerCase();
    return function(s) {
      return s.toLowerCase().indexOf(needle) !== -1;
    };
  }
  async function find2(p) {
    const byName = matcher(p.name);
    const byText = matcher(p.text);
    const byStyle = matcher(p.style);
    const byComponent = matcher(p.component);
    const types = (Array.isArray(p.type) ? p.type : p.type ? [p.type] : []).map(function(t) {
      return String(t).toUpperCase().replace(/[\s-]/g, "_");
    });
    if (!byName && !byText && !byStyle && !byComponent && !types.length) {
      throw codeError("Give at least one filter: name, text, type, style or component", "BAD_ARGS");
    }
    const limit = Math.max(1, Math.min(MAX_LIMIT, p.limit || 50));
    let roots;
    if (p.parentId)
      roots = [await getNode(p.parentId)];
    else if (p.pageId)
      roots = [await getNode(p.pageId)];
    else
      roots = figma.root.children.slice();
    for (let i = 0;i < roots.length; i++)
      if (roots[i].type === "PAGE")
        await roots[i].loadAsync();
    const test = function(n) {
      if (types.length && types.indexOf(n.type) === -1)
        return false;
      if (byName && !byName(n.name))
        return false;
      if (byText && !(n.type === "TEXT" && byText(n.characters)))
        return false;
      if (byComponent && n.type !== "INSTANCE")
        return false;
      if (byStyle && !(n.fillStyleId || n.strokeStyleId || n.textStyleId || n.effectStyleId))
        return false;
      return true;
    };
    let candidates = [];
    for (let i = 0;i < roots.length; i++) {
      const r = roots[i];
      if (r.type !== "PAGE" && test(r))
        candidates.push(r);
      if ("findAll" in r)
        candidates = candidates.concat(r.findAll(test));
    }
    const matches = [];
    let total = 0;
    for (let i = 0;i < candidates.length; i++) {
      const n = candidates[i];
      if (byStyle && !await usesStyle(n, byStyle))
        continue;
      if (byComponent && !await isInstanceOf(n, byComponent, String(p.component)))
        continue;
      total++;
      if (matches.length < limit)
        matches.push(describeMatch(n));
    }
    return { total, matches, truncated: total > matches.length };
  }
  async function usesStyle(n, test) {
    const fields = ["fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId"];
    for (let i = 0;i < fields.length; i++) {
      const name = await styleName(n[fields[i]]);
      if (name && test(name))
        return true;
    }
    return false;
  }
  async function isInstanceOf(n, test, ref) {
    const main = await n.getMainComponentAsync();
    if (!main)
      return false;
    if (main.id === ref || main.key === ref || test(main.name))
      return true;
    const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
    return !!set && (set.id === ref || set.key === ref || test(set.name));
  }
  function describeMatch(n) {
    const names = [];
    let p = n.parent;
    while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
      names.unshift(p.name);
      p = p.parent;
    }
    const page = pageOf(n);
    const out = { id: n.id, name: n.name, type: n.type, page: page ? page.name : null, path: names.join(" / ") };
    if (n.type === "TEXT")
      out.text = n.characters.length > 80 ? n.characters.slice(0, 77) + "…" : n.characters;
    return out;
  }

  // plugin/lib/selection.ts
  var MAX_WAIT_MS = 120000;
  var waiters = {};
  var listening = false;
  function selectionSummary() {
    const sel = figma.currentPage.selection;
    return {
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      count: sel.length,
      selection: sel.slice(0, 100).map(function(n) {
        const b = n.absoluteBoundingBox;
        return {
          id: n.id,
          name: n.name,
          type: n.type,
          bounds: b ? { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) } : null
        };
      })
    };
  }
  function onSelectionChange() {
    if (!figma.currentPage.selection.length)
      return;
    const ids = Object.keys(waiters);
    for (let i = 0;i < ids.length; i++)
      finish(ids[i], null);
  }
  function finish(id, error, timedOut) {
    const w = waiters[id];
    if (!w)
      return;
    delete waiters[id];
    clearTimeout(w.timer);
    figma.ui.postMessage({ t: "waitDone", id });
    if (!Object.keys(waiters).length && listening) {
      figma.off("selectionchange", onSelectionChange);
      listening = false;
    }
    if (error)
      w.reject(error);
    else {
      const out = selectionSummary();
      out.timedOut = !!timedOut;
      w.resolve(out);
    }
  }
  function waitForSelection(p, timeoutMs, requestId) {
    const ms = Math.max(1000, Math.min(MAX_WAIT_MS, Number(p.timeoutMs) || timeoutMs || 60000));
    const message = String(p.message || "Select one or more layers");
    return new Promise(function(resolve, reject) {
      waiters[requestId] = {
        resolve,
        reject,
        timer: setTimeout(function() {
          finish(requestId, null, true);
        }, ms)
      };
      if (!listening) {
        figma.on("selectionchange", onSelectionChange);
        listening = true;
      }
      figma.ui.postMessage({ t: "wait", id: requestId, message, until: Date.now() + ms });
      figma.notify("Your agent is waiting: " + message, { timeout: 4000 });
    });
  }
  function cancelWait(id) {
    finish(id, codeError("The user cancelled the selection request", "CANCELLED"));
  }
  // package.json
  var version = "1.9.0";

  // plugin/code.ts
  var DEFAULT_SIZE = { width: 340, height: 540 };
  var MIN_SIZE = { width: 280, height: 260 };
  var MAX_SIZE = { width: 900, height: 1200 };
  var COMPACT_HEIGHT = 44;
  figma.skipInvisibleInstanceChildren = true;
  figma.showUI(__html__, { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, themeColors: true, title: "Figma Bridge" });
  var sessionId = randomId();
  var size = { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  var compact = false;
  function randomId() {
    let s = "";
    for (let i = 0;i < 16; i++)
      s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
  function post(msg) {
    figma.ui.postMessage(msg);
  }
  function sessionInfo() {
    return { id: sessionId, fileName: figma.root.name, page: figma.currentPage.name, editorType: figma.editorType };
  }
  function clampSize(w, h) {
    return {
      width: Math.round(Math.min(MAX_SIZE.width, Math.max(MIN_SIZE.width, Number(w) || DEFAULT_SIZE.width))),
      height: Math.round(Math.min(MAX_SIZE.height, Math.max(MIN_SIZE.height, Number(h) || DEFAULT_SIZE.height)))
    };
  }
  function applySize2() {
    figma.ui.resize(size.width, compact ? COMPACT_HEIGHT : size.height);
  }
  async function sendInit() {
    const channel = await figma.clientStorage.getAsync("channel") || "default";
    const saved = await figma.clientStorage.getAsync("size");
    if (saved)
      size = clampSize(saved.width, saved.height);
    compact = !!await figma.clientStorage.getAsync("compact");
    applySize2();
    post({ t: "init", version, session: sessionInfo(), settings: { channel, compact } });
  }
  try {
    if (!figma.root.getRelaunchData().open)
      figma.root.setRelaunchData({ open: "Connect this file to your AI agent" });
  } catch (e) {}
  var lastFileName = figma.root.name;
  figma.on("currentpagechange", function() {
    post({ t: "info", session: sessionInfo() });
  });
  setInterval(function() {
    if (figma.root.name !== lastFileName) {
      lastFileName = figma.root.name;
      post({ t: "info", session: sessionInfo() });
    }
  }, 3000);
  figma.ui.onmessage = function(msg) {
    if (!msg || typeof msg !== "object")
      return;
    if (msg.t === "ready")
      sendInit();
    else if (msg.t === "req")
      handleRequest(msg);
    else if (msg.t === "set")
      figma.clientStorage.setAsync(msg.key, msg.value);
    else if (msg.t === "compact") {
      compact = !!msg.value;
      applySize2();
      figma.clientStorage.setAsync("compact", compact);
    } else if (msg.t === "resize") {
      size = clampSize(msg.width, msg.height);
      compact = false;
      applySize2();
      if (msg.save)
        figma.clientStorage.setAsync("size", size);
    } else if (msg.t === "resetSize") {
      size = { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
      applySize2();
      figma.clientStorage.setAsync("size", size);
    } else if (msg.t === "notify")
      figma.notify(String(msg.text), { timeout: 2500 });
    else if (msg.t === "focus")
      focusNode(String(msg.nodeId));
    else if (msg.t === "cancelWait")
      cancelWait(String(msg.id));
    else if (msg.t === "cancel") {
      markCancelled(String(msg.id));
      cancelWait(String(msg.id));
    }
  };
  async function focusNode(id) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type === "DOCUMENT") {
      figma.notify("This layer no longer exists", { timeout: 2000 });
      return;
    }
    const page = pageOf(node);
    if (page && page !== figma.currentPage)
      await figma.setCurrentPageAsync(page);
    if (node.type === "PAGE")
      return;
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
  }
  var HANDLERS = {
    run_script: runScript,
    build,
    describe,
    find: find2,
    get_design_system: getDesignSystem,
    design_tokens: designTokens,
    export_tokens: exportTokens,
    audit,
    get_css: getCss,
    checkpoint,
    screenshot,
    place_image: placeImage,
    import_svg: importSvg,
    get_context: getContext,
    list_fonts: listFonts,
    wait_for_selection: waitForSelection,
    prototype,
    annotate,
    export_tree: exportTree,
    ping: function() {
      return Promise.resolve({ pong: true, session: sessionInfo() });
    }
  };
  var EDITORS2 = {
    prototype: ["figma"],
    annotate: ["figma", "dev"],
    design_tokens: ["figma", "slides"],
    export_tokens: ["figma", "slides", "dev"]
  };
  var EDITOR_NAMES2 = { figma: "Figma Design", figjam: "FigJam", slides: "Figma Slides", dev: "Dev Mode" };
  var READ_ONLY = {
    describe: true,
    find: true,
    get_design_system: true,
    export_tokens: true,
    audit: true,
    get_css: true,
    screenshot: true,
    get_context: true,
    list_fonts: true,
    wait_for_selection: true,
    export_tree: true,
    ping: true
  };
  async function handleRequest(msg) {
    const started = Date.now();
    const mutates = !READ_ONLY[msg.method] || !!(msg.params && (msg.params.fix === true || msg.params.fixes && msg.params.fixes.length));
    let reply;
    if (mutates)
      commitUndo();
    try {
      const handler = HANDLERS[msg.method];
      if (!handler)
        throw codeError("Unknown method: " + msg.method + " (reopen the plugin after updating it)", "UNKNOWN_METHOD");
      const editors = EDITORS2[msg.method];
      if (editors && editors.indexOf(figma.editorType) === -1) {
        throw codeError(msg.method + " is not available in " + (EDITOR_NAMES2[figma.editorType] || figma.editorType) + " (works in " + editors.map(function(e) {
          return EDITOR_NAMES2[e];
        }).join(", ") + ").", "WRONG_EDITOR");
      }
      if (mutates && figma.editorType === "dev")
        throw codeError("Dev Mode is read-only: switch the file to Design mode to let the agent edit it.", "WRONG_EDITOR");
      const result = await handler(msg.params || {}, Math.min(Number(msg.timeoutMs) || 30000, 120000), String(msg.id));
      reply = { t: "res", id: msg.id, ok: true, result };
    } catch (e) {
      reply = Object.assign({ t: "res", id: msg.id, ok: false }, describeError(e));
    }
    if (mutates) {
      commitUndo();
      invalidateCaches();
    }
    clearCancelled(String(msg.id));
    reply.ms = Date.now() - started;
    post(reply);
  }
  function commitUndo() {
    try {
      figma.commitUndo();
    } catch (e) {}
  }
  function describeError(e) {
    const out = {
      error: e && e.message ? String(e.message) : String(e),
      code: e && e.code || "PLUGIN_ERROR"
    };
    if (e && e.stack)
      out.stack = String(e.stack).split(`
`).slice(0, 6).join(`
`);
    if (e && e.line)
      out.line = e.line;
    if (e && e.logs && e.logs.length)
      out.logs = e.logs;
    return out;
  }
  var AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  var SCRIPT_ARGS = ["figma", "console", "utils", "lib"];
  var lineBase = null;
  var currentConsole = console;
  var lib = {};
  var libHash = "";
  function loadLibrary(hash, sources) {
    if (!hash || hash === libHash)
      return;
    const names = Object.keys(lib);
    for (let i = 0;i < names.length; i++)
      delete lib[names[i]];
    const keys = Object.keys(sources || {});
    for (let i = 0;i < keys.length; i++) {
      const name = keys[i];
      try {
        const fn = new AsyncFunction("figma", "utils", "lib", "console", "args", sources[name]);
        lib[name] = function(args) {
          return fn(figma, utils, lib, currentConsole, args);
        };
      } catch (e) {
        const message = "Snippet " + name + " does not compile: " + (e.message || e);
        lib[name] = function() {
          return Promise.reject(new Error(message));
        };
      }
    }
    libHash = hash;
  }
  function compile(code) {
    if (!/\breturn\b/.test(code)) {
      try {
        const expr = code.trim().replace(/;+\s*$/, "");
        return { fn: new AsyncFunction(SCRIPT_ARGS[0], SCRIPT_ARGS[1], SCRIPT_ARGS[2], SCRIPT_ARGS[3], `return (
` + expr + `
);`), offset: 1 };
      } catch (e) {}
    }
    return { fn: new AsyncFunction(SCRIPT_ARGS[0], SCRIPT_ARGS[1], SCRIPT_ARGS[2], SCRIPT_ARGS[3], code), offset: 0 };
  }
  function stackLine(stack) {
    const lines = String(stack || "").split(`
`);
    for (let pass = 0;pass < 2; pass++) {
      for (let i = 0;i < lines.length; i++) {
        const l = lines[i];
        if (pass === 0 && !/anonymous|eval|<input>/.test(l))
          continue;
        const m = /:(\d+)(?::\d+)?\)?\s*$/.exec(l);
        if (m)
          return Number(m[1]);
      }
    }
    return null;
  }
  async function scriptLine(e, offset) {
    if (lineBase === null) {
      lineBase = 0;
      try {
        await new AsyncFunction("throw new Error('probe')")();
      } catch (probe) {
        const n = stackLine(probe.stack);
        if (n !== null)
          lineBase = n - 1;
      }
    }
    const raw = stackLine(e && e.stack);
    if (raw === null) {
      const m = /line (\d+)/i.exec(String(e && e.message));
      return m ? Number(m[1]) : undefined;
    }
    const line2 = raw - lineBase - offset;
    return line2 >= 1 ? line2 : undefined;
  }
  async function runScript(p, timeoutMs) {
    const logs = [];
    const scriptConsole = makeConsole(logs);
    let compiled = { fn: null, offset: 0 };
    let timer;
    loadLibrary(p.libHash, p.lib);
    currentConsole = scriptConsole;
    try {
      compiled = compile(String(p.code || ""));
      const value = await Promise.race([
        compiled.fn(figma, scriptConsole, utils, lib),
        new Promise(function(_, reject) {
          timer = setTimeout(function() {
            reject(codeError("Script timed out after " + timeoutMs + " ms (async work may still be running in Figma)", "TIMEOUT"));
          }, timeoutMs);
        })
      ]);
      const out = { result: toSafe(value, 0, []) };
      if (logs.length)
        out.logs = logs;
      return out;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!err.code)
        err.code = err.name === "SyntaxError" ? "SYNTAX_ERROR" : "SCRIPT_ERROR";
      err.line = await scriptLine(err, compiled.offset);
      err.logs = logs;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  function makeConsole(logs) {
    function add(level) {
      return function() {
        const parts = [];
        for (let i = 0;i < arguments.length; i++) {
          const a = arguments[i];
          parts.push(typeof a === "string" ? a : safeStringify(a));
        }
        if (logs.length < 200)
          logs.push((level === "log" ? "" : level + ": ") + parts.join(" ").slice(0, 2000));
      };
    }
    return { log: add("log"), info: add("info"), warn: add("warn"), error: add("error"), debug: add("debug") };
  }
  var utils = {
    loadFonts: async function(...fonts) {
      const names = fontNamesOf(fonts);
      await Promise.all(names.map(loadFont));
      return names.length;
    },
    node: function(id) {
      return figma.getNodeByIdAsync(id);
    },
    page: async function(nameOrId) {
      const pages = figma.root.children;
      let page = null;
      for (let i = 0;i < pages.length; i++)
        if (pages[i].id === nameOrId || pages[i].name === nameOrId)
          page = pages[i];
      if (!page)
        throw new Error("Page not found: " + nameOrId);
      await figma.setCurrentPageAsync(page);
      return page;
    },
    hex: function(hex) {
      const c = parseHex(hex);
      return c.a === 1 ? { r: c.r, g: c.g, b: c.b } : c;
    },
    solid: function(hex, opacity) {
      const c = parseHex(hex);
      return [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: opacity === undefined ? c.a : opacity }];
    },
    build: function(spec, options) {
      return build(Object.assign({}, options || {}, { spec, select: options && options.select === true }));
    },
    describe: async function(node, depth) {
      const id = node && typeof node === "object" ? node.id : node;
      const out = await describe({ nodeId: id, depth });
      return out.outline;
    }
  };
  async function getCss(p) {
    const node = p.nodeId ? await getNode(p.nodeId) : figma.currentPage.selection[0];
    if (!node)
      throw codeError("No nodeId given and nothing is selected", "BAD_ARGS");
    if (typeof node.getCSSAsync !== "function")
      throw codeError("A " + node.type + " node has no CSS", "BAD_ARGS");
    const out = { nodeId: node.id, name: node.name, css: await node.getCSSAsync() };
    if (p.children && "children" in node) {
      out.children = [];
      const kids = node.children.slice(0, 50);
      for (let i = 0;i < kids.length; i++) {
        out.children.push({ nodeId: kids[i].id, name: kids[i].name, css: await kids[i].getCSSAsync() });
      }
    }
    return out;
  }
  async function screenshot(p) {
    const node = p.nodeId ? await getNode(p.nodeId) : figma.currentPage.selection[0];
    if (!node)
      throw codeError("No nodeId given and nothing is selected", "BAD_ARGS");
    if (typeof node.exportAsync !== "function")
      throw codeError("A " + node.type + " node cannot be exported", "BAD_ARGS");
    const box = node.absoluteRenderBounds || node.absoluteBoundingBox || { width: node.width || 1, height: node.height || 1 };
    let scale = p.scale || 1;
    if (!p.scale && p.width)
      scale = Math.max(0.05, Math.min(4, p.width / Math.max(box.width, 1)));
    if (p.maxDimension)
      scale = Math.min(scale, p.maxDimension / Math.max(box.width, box.height, 1));
    const format = p.format === "JPG" ? "JPG" : "PNG";
    const bytes = await node.exportAsync({ format, constraint: { type: "SCALE", value: scale } });
    const bb = node.absoluteBoundingBox;
    const offset = node.absoluteRenderBounds && bb ? { x: round(node.absoluteRenderBounds.x - bb.x), y: round(node.absoluteRenderBounds.y - bb.y) } : { x: 0, y: 0 };
    return { bytes, format, scale, offset, name: node.name, nodeId: node.id };
  }
  async function placeImage(p) {
    if (!(p.bytes instanceof Uint8Array))
      throw codeError("No image bytes received", "BAD_ARGS");
    const image = figma.createImage(p.bytes);
    const imgSize = await image.getSizeAsync();
    const paint = { type: "IMAGE", imageHash: image.hash, scaleMode: p.scaleMode || "FILL" };
    let target;
    if (p.nodeId) {
      target = await getNode(p.nodeId);
      if (!("fills" in target))
        throw codeError("A " + target.type + " node has no fills", "BAD_ARGS");
      if (p.name)
        target.name = p.name;
    } else {
      let w = p.width;
      let h = p.height;
      if (!w && !h) {
        w = imgSize.width;
        h = imgSize.height;
      } else if (!h)
        h = w * imgSize.height / imgSize.width;
      else if (!w)
        w = h * imgSize.width / imgSize.height;
      target = figma.createRectangle();
      target.name = p.name || "Image";
      target.resize(Math.max(1, w), Math.max(1, h));
      (await parentFor(p.parentId)).appendChild(target);
      place(target, p.x, p.y);
    }
    target.fills = [paint];
    return {
      nodeId: target.id,
      name: target.name,
      imageHash: image.hash,
      width: round(target.width),
      height: round(target.height),
      imageWidth: imgSize.width,
      imageHeight: imgSize.height
    };
  }
  async function importSvg(p) {
    if (!p.svg)
      throw codeError("Empty SVG", "BAD_ARGS");
    const node = figma.createNodeFromSvg(String(p.svg));
    if (p.name)
      node.name = p.name;
    (await parentFor(p.parentId)).appendChild(node);
    if (typeof p.size === "number" && node.height > 0)
      node.rescale(p.size / Math.max(node.width, node.height));
    if (!(("layoutMode" in node.parent) && node.parent.layoutMode !== "NONE"))
      place(node, p.x, p.y);
    return { nodeId: node.id, name: node.name, width: round(node.width), height: round(node.height) };
  }
  function bounds(n) {
    const b = n.absoluteBoundingBox;
    return b ? { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) } : null;
  }
  async function getContext() {
    const sel = figma.currentPage.selection;
    const vb = figma.viewport.bounds;
    return {
      fileName: figma.root.name,
      pages: figma.root.children.map(function(pg) {
        return { id: pg.id, name: pg.name };
      }),
      currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
      selectionCount: sel.length,
      selection: sel.slice(0, 100).map(function(n) {
        return { id: n.id, name: n.name, type: n.type, bounds: bounds(n) };
      }),
      viewport: {
        center: { x: round(figma.viewport.center.x), y: round(figma.viewport.center.y) },
        zoom: round(figma.viewport.zoom),
        bounds: { x: round(vb.x), y: round(vb.y), width: round(vb.width), height: round(vb.height) }
      }
    };
  }
  var fontCache = null;
  async function listFonts(p) {
    if (!fontCache)
      fontCache = await figma.listAvailableFontsAsync();
    const filter = String(p.filter || "").toLowerCase();
    const families = {};
    const order = [];
    for (let i = 0;i < fontCache.length; i++) {
      const f = fontCache[i].fontName;
      if (filter && f.family.toLowerCase().indexOf(filter) === -1)
        continue;
      if (!families[f.family]) {
        families[f.family] = [];
        order.push(f.family);
      }
      families[f.family].push(f.style);
    }
    const limit = p.limit || 100;
    return {
      totalFamilies: order.length,
      families: order.slice(0, limit).map(function(family) {
        return { family, styles: families[family] };
      })
    };
  }
})();

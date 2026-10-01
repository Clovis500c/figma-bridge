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

  // plugin/lib/audit.ts
  var MAX_NODES = 5000;
  var MAX_ISSUES = 120;
  var DEFAULT_NAME = /^(Frame|Rectangle|Ellipse|Group|Vector|Text|Line|Polygon|Star|Component|Instance|Section|Image)( \d+)?$/;
  async function audit(p) {
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
      if (issues.length < MAX_ISSUES)
        issues.push({ rule, severity, nodeId: n.id, name: n.name, message });
    };
    const visit = function(n, clipBox) {
      if (visited >= MAX_NODES)
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
      truncated: visited >= MAX_NODES || issues.length >= MAX_ISSUES
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
    const fg = solidOf(n.fills);
    if (!fg || n.fontSize === figma.mixed)
      return;
    const bg = backgroundOf(n, pageBg);
    if (!bg)
      return;
    const ratio = contrastRatio(fg, bg);
    const bold = n.fontName !== figma.mixed && /bold|black|heavy|semi/i.test(n.fontName.style);
    const large = n.fontSize >= 24 || bold && n.fontSize >= 18.66;
    const min = large ? 3 : 4.5;
    if (ratio < min) {
      report("contrast", ratio < min - 1.5 ? "error" : "warning", n, "Contrast " + round(ratio) + ":1 is below " + min + ":1 (WCAG AA" + (large ? ", large text" : "") + ")");
    }
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
    const find = function(list, name) {
      for (let i = 0;i < list.length; i++)
        if (list[i].name === name)
          return list[i];
      return null;
    };
    const colors = styles.colors || [];
    for (let i = 0;i < colors.length; i++) {
      const s = colors[i];
      try {
        const value = s.value !== undefined ? s.value : s.color;
        const list = Array.isArray(value) ? value : [value];
        const paints = [];
        for (let k = 0;k < list.length; k++)
          paints.push(await toPaint(list[k]));
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
        const list = Array.isArray(value) ? value : [value];
        const out = [];
        for (let k = 0;k < list.length; k++) {
          const e = list[k];
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
  var MAX_NODES2 = 3000;
  var SHADOW_DEFAULT = { x: 0, y: 4, blur: 16, spread: 0, color: "#0000001F" };
  async function build(p) {
    const spec = p.spec;
    if (!spec || typeof spec !== "object")
      throw codeError("`spec` must be a node object or an array of node objects", "BAD_ARGS");
    const roots = Array.isArray(spec) ? spec : [spec];
    const d = p.defaults || {};
    const ctx = {
      warnings: [],
      ids: {},
      count: 0,
      images: p.imageBytes || {},
      fonts: {},
      defaults: { font: d.font || "Inter", color: d.color || "#111111", size: d.size || 14 }
    };
    await preloadFonts(roots, ctx);
    const parent = await parentFor(p.parentId);
    const made = [];
    let cursorX = null;
    for (let i = 0;i < roots.length; i++) {
      const node = await createNode(roots[i], parent, ctx, "spec" + (roots.length > 1 ? "[" + i + "]" : ""));
      if (!node)
        continue;
      if (!isAutoLayout(parent) && roots[i].x === undefined && roots[i].y === undefined) {
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
    if (p.select !== false && made.length && parent.type === "PAGE" && parent === figma.currentPage) {
      figma.currentPage.selection = made;
      figma.viewport.scrollAndZoomIntoView(made);
    }
    const out = {
      rootId: made.length ? made[0].id : null,
      rootIds: made.map(function(n) {
        return n.id;
      }),
      created: ctx.count,
      ids: ctx.ids
    };
    if (ctx.warnings.length)
      out.warnings = ctx.warnings.slice(0, 50);
    return out;
  }
  function fontKey(s, ctx) {
    return parseFont(s.font || ctx.defaults.font, s.weight, ctx.defaults.font);
  }
  async function preloadFonts(roots, ctx) {
    const wanted = {};
    const walk = function(s) {
      if (!s || typeof s !== "object")
        return;
      if (nodeType(s) === "text") {
        const f = fontKey(s, ctx);
        wanted[f.family + ":" + f.style] = f;
      }
      if (Array.isArray(s.children))
        s.children.forEach(walk);
    };
    roots.forEach(walk);
    const keys = Object.keys(wanted);
    await Promise.all(keys.map(async function(key) {
      const f = wanted[key];
      const candidates = [f, { family: f.family, style: "Regular" }, { family: "Inter", style: f.style }, { family: "Inter", style: "Regular" }];
      for (let i = 0;i < candidates.length; i++) {
        try {
          await loadFont(candidates[i]);
          ctx.fonts[key] = candidates[i];
          if (i > 0)
            ctx.warnings.push('Font "' + f.family + " " + f.style + '" unavailable, used "' + candidates[i].family + " " + candidates[i].style + '"');
          return;
        } catch (e) {}
      }
    }));
  }
  function nodeType(s) {
    if (s.type) {
      const t = String(s.type).toLowerCase();
      return t === "rectangle" ? "rect" : t === "circle" ? "ellipse" : t;
    }
    if (s.text !== undefined)
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
    if (ctx.count >= MAX_NODES2)
      throw codeError("Spec is too large (max " + MAX_NODES2 + " nodes). Split it into several build calls.", "TOO_LARGE");
    const type = nodeType(s);
    let node;
    switch (type) {
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
      default:
        throw codeError(path + ': unknown type "' + s.type + '"', "BAD_ARGS");
    }
    ctx.count++;
    parent.appendChild(node);
    const parentAuto = isAutoLayout(parent);
    if (s.name)
      node.name = String(s.name);
    else if (type === "icon")
      node.name = "icon/" + s.icon;
    if (type === "frame" || type === "component")
      await setupFrame(node, s, ctx, path);
    else if (type === "text")
      await setupText(node, s, ctx);
    else if (type === "image")
      await setupImage(node, s, ctx, path);
    else if (type === "line") {
      node.resize(num(s.w, s.width, 100), 0);
      if (s.stroke === undefined)
        node.strokes = [solid(ctx.defaults.color)];
    } else if ((type === "rect" || type === "ellipse") && s.w === undefined && s.width === undefined && s.size === undefined) {
      node.resize(100, 100);
    }
    if (type === "instance" && s.text && typeof s.text === "object")
      await overrideTexts(node, s.text, ctx);
    await applyVisuals(node, s, ctx, type);
    applySize(node, s, parentAuto, type, ctx, path);
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
    if (typeof s.rotation === "number")
      node.rotation = s.rotation;
    if (s.visible === false)
      node.visible = false;
    if (s.locked)
      node.locked = true;
    if (s.modes)
      await applyModes(node, s.modes, ctx.warnings, path);
    if (s.name) {
      let key = String(s.name);
      for (let n = 2;ctx.ids[key]; n++)
        key = s.name + " #" + n;
      if (Object.keys(ctx.ids).length < 300)
        ctx.ids[key] = node.id;
    }
    return node;
  }
  async function setupFrame(f, s, ctx, path) {
    f.fills = [];
    const layout = String(s.layout || s.direction || "").toLowerCase();
    const mode = layout === "row" || layout === "horizontal" ? "HORIZONTAL" : layout === "column" || layout === "col" || layout === "vertical" ? "VERTICAL" : "NONE";
    f.clipsContent = !!s.clip;
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
    } else if (s.w === undefined && s.width === undefined && s.size === undefined) {
      f.resize(100, 100);
    }
    const children = Array.isArray(s.children) ? s.children : [];
    for (let i = 0;i < children.length; i++) {
      try {
        await createNode(children[i], f, ctx, path + ".children[" + i + "]");
      } catch (e) {
        if (e.code === "TOO_LARGE")
          throw e;
        ctx.warnings.push(path + ".children[" + i + "]: " + (e.message || e));
      }
    }
  }
  async function setupText(t, s, ctx) {
    const wanted = fontKey(s, ctx);
    t.fontName = ctx.fonts[wanted.family + ":" + wanted.style] || { family: "Inter", style: "Regular" };
    t.characters = String(s.text === undefined ? "" : s.text);
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
      t.fills = [solid(ctx.defaults.color)];
    if (s.textStyle) {
      const style = await findStyle("text", stripPrefix(s.textStyle));
      await loadFont(style.fontName);
      await t.setTextStyleIdAsync(style.id);
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
  async function createInstance(s, path) {
    const ref = String(s.component);
    let comp = null;
    if (/^[\dI;:]+$/.test(ref)) {
      const n = await figma.getNodeByIdAsync(ref);
      if (n && (n.type === "COMPONENT" || n.type === "COMPONENT_SET"))
        comp = n;
    } else if (/^[0-9a-f]{40}$/i.test(ref)) {
      comp = await figma.importComponentByKeyAsync(ref);
    } else {
      const list = await localComponents();
      for (let i = 0;i < list.length && !comp; i++)
        if (list[i].name === ref)
          comp = list[i];
      for (let i = 0;i < list.length && !comp; i++)
        if (list[i].name.toLowerCase() === ref.toLowerCase())
          comp = list[i];
    }
    if (!comp)
      throw codeError(path + ': component "' + ref + '" not found. Use get_design_system to list components.', "NOT_FOUND");
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
      await setPaints(node, "fills", fill);
    if (s.stroke !== undefined && "strokes" in node) {
      await setPaints(node, "strokes", s.stroke);
      node.strokeWeight = typeof s.strokeWidth === "number" ? s.strokeWidth : 1;
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
  function solid(hex) {
    const c = parseHex(hex);
    return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  }
  async function setPaints(node, field, value) {
    if (typeof value === "string" && value.indexOf("style:") === 0) {
      const style = await findStyle("paint", stripPrefix(value));
      if (field === "fills")
        await node.setFillStyleIdAsync(style.id);
      else
        await node.setStrokeStyleIdAsync(style.id);
      return;
    }
    const list = value === null || value === "none" ? [] : Array.isArray(value) ? value : [value];
    const paints = [];
    for (let i = 0;i < list.length; i++)
      paints.push(await toPaint(list[i]));
    node[field] = paints;
  }
  async function toPaint(v) {
    if (typeof v === "string") {
      if (v.indexOf("var:") === 0) {
        const variable = await findVariable(stripPrefix(v));
        return figma.variables.setBoundVariableForPaint(solid("#000000"), "color", variable);
      }
      return solid(v);
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
      return list();
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
  async function list() {
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
      const list2 = await localComponents();
      counts.components = list2.length;
      out.components = list2.slice(0, limit).map(function(c) {
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

  // plugin/code.ts
  var VERSION = "1.3.0";
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
    return { id: sessionId, fileName: figma.root.name, page: figma.currentPage.name };
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
    post({ t: "init", version: VERSION, session: sessionInfo(), settings: { channel, compact } });
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
    get_design_system: getDesignSystem,
    design_tokens: designTokens,
    audit,
    get_css: getCss,
    checkpoint,
    screenshot,
    place_image: placeImage,
    import_svg: importSvg,
    get_context: getContext,
    list_fonts: listFonts,
    ping: function() {
      return Promise.resolve({ pong: true, session: sessionInfo() });
    }
  };
  var READ_ONLY = {
    describe: true,
    get_design_system: true,
    audit: true,
    get_css: true,
    screenshot: true,
    get_context: true,
    list_fonts: true,
    ping: true
  };
  async function handleRequest(msg) {
    const started = Date.now();
    const mutates = !READ_ONLY[msg.method];
    let reply;
    if (mutates)
      commitUndo();
    try {
      const handler = HANDLERS[msg.method];
      if (!handler)
        throw codeError("Unknown method: " + msg.method + " (reopen the plugin after updating it)", "UNKNOWN_METHOD");
      const result = await handler(msg.params || {}, Math.min(Number(msg.timeoutMs) || 30000, 120000));
      reply = { t: "res", id: msg.id, ok: true, result };
    } catch (e) {
      reply = Object.assign({ t: "res", id: msg.id, ok: false }, describeError(e));
    }
    if (mutates) {
      commitUndo();
      invalidateCaches();
    }
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
    if (p.maxDimension)
      scale = Math.min(scale, p.maxDimension / Math.max(box.width, box.height, 1));
    const format = p.format === "JPG" ? "JPG" : "PNG";
    const bytes = await node.exportAsync({ format, constraint: { type: "SCALE", value: scale } });
    return { bytes, format, scale, name: node.name, nodeId: node.id };
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

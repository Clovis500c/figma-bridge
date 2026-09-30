(() => {
  // plugin/code.ts
  var VERSION = "1.1.0";
  var DEFAULT_SIZE = { width: 340, height: 540 };
  var MIN_SIZE = { width: 280, height: 260 };
  var MAX_SIZE = { width: 900, height: 1200 };
  var COMPACT_HEIGHT = 44;
  figma.skipInvisibleInstanceChildren = true;
  figma.showUI(__html__, { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, themeColors: true, title: "Figma Bridge" });
  var size = { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
  var compact = false;
  function clampSize(w, h) {
    return {
      width: Math.round(Math.min(MAX_SIZE.width, Math.max(MIN_SIZE.width, Number(w) || DEFAULT_SIZE.width))),
      height: Math.round(Math.min(MAX_SIZE.height, Math.max(MIN_SIZE.height, Number(h) || DEFAULT_SIZE.height)))
    };
  }
  function applySize() {
    figma.ui.resize(size.width, compact ? COMPACT_HEIGHT : size.height);
  }
  var sessionId = randomId();
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
  async function sendInit() {
    const channel = await figma.clientStorage.getAsync("channel") || "default";
    const saved = await figma.clientStorage.getAsync("size");
    if (saved)
      size = clampSize(saved.width, saved.height);
    compact = !!await figma.clientStorage.getAsync("compact");
    applySize();
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
      applySize();
      figma.clientStorage.setAsync("compact", compact);
    } else if (msg.t === "resize") {
      size = clampSize(msg.width, msg.height);
      compact = false;
      applySize();
      if (msg.save)
        figma.clientStorage.setAsync("size", size);
    } else if (msg.t === "resetSize") {
      size = { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height };
      applySize();
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
    let page = node;
    while (page && page.type !== "PAGE")
      page = page.parent;
    if (page && page !== figma.currentPage)
      await figma.setCurrentPageAsync(page);
    if (node.type === "PAGE")
      return;
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
  }
  var HANDLERS = {
    run_script: runScript,
    screenshot,
    place_image: placeImage,
    import_svg: importSvg,
    get_context: getContext,
    list_fonts: listFonts,
    ping: function() {
      return Promise.resolve({ pong: true, session: sessionInfo() });
    }
  };
  async function handleRequest(msg) {
    const started = Date.now();
    let reply;
    try {
      const handler = HANDLERS[msg.method];
      if (!handler)
        throw codeError("Unknown method: " + msg.method, "UNKNOWN_METHOD");
      const result = await handler(msg.params || {}, Math.min(Number(msg.timeoutMs) || 30000, 120000));
      reply = { t: "res", id: msg.id, ok: true, result };
    } catch (e) {
      reply = Object.assign({ t: "res", id: msg.id, ok: false }, describeError(e));
    }
    reply.ms = Date.now() - started;
    post(reply);
  }
  function codeError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
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
  var SCRIPT_ARGS = ["figma", "console", "utils"];
  var lineBase = null;
  function compile(code) {
    if (!/\breturn\b/.test(code)) {
      try {
        const expr = code.trim().replace(/;+\s*$/, "");
        return { fn: new AsyncFunction(SCRIPT_ARGS[0], SCRIPT_ARGS[1], SCRIPT_ARGS[2], `return (
` + expr + `
);`), offset: 1 };
      } catch (e) {}
    }
    return { fn: new AsyncFunction(SCRIPT_ARGS[0], SCRIPT_ARGS[1], SCRIPT_ARGS[2], code), offset: 0 };
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
    const line = raw - lineBase - offset;
    return line >= 1 ? line : undefined;
  }
  async function runScript(p, timeoutMs) {
    const logs = [];
    const scriptConsole = makeConsole(logs);
    let compiled = { fn: null, offset: 0 };
    let timer;
    try {
      compiled = compile(String(p.code || ""));
      const value = await Promise.race([
        compiled.fn(figma, scriptConsole, utils),
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
  function safeStringify(v) {
    try {
      return JSON.stringify(toSafe(v, 0, []));
    } catch (e) {
      return String(v);
    }
  }
  function isNode(v) {
    return v && typeof v === "object" && typeof v.id === "string" && typeof v.type === "string" && "removed" in v;
  }
  function nodeRef(n) {
    return n.removed ? { id: n.id, removed: true } : { id: n.id, name: n.name, type: n.type };
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
      return nodeRef(v);
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
  var fontLoads = {};
  function fontNamesOf(f) {
    if (typeof f === "string") {
      const i = f.indexOf(":");
      return [{ family: i === -1 ? f : f.slice(0, i), style: i === -1 ? "Regular" : f.slice(i + 1) }];
    }
    if (isNode(f) && f.type === "TEXT") {
      const text = f;
      if (text.characters.length)
        return text.getRangeAllFontNames(0, text.characters.length);
      return text.fontName === figma.mixed ? [] : [text.fontName];
    }
    if (f && typeof f.family === "string")
      return [{ family: f.family, style: f.style || "Regular" }];
    if (Array.isArray(f)) {
      let all = [];
      for (let i = 0;i < f.length; i++)
        all = all.concat(fontNamesOf(f[i]));
      return all;
    }
    throw new Error("loadFonts: expected 'Family:Style', FontName or TextNode, got " + safeStringify(f));
  }
  function parseHex(hex) {
    let h = String(hex).replace(/^#/, "");
    if (h.length === 3 || h.length === 4) {
      h = h.split("").map(function(c) {
        return c + c;
      }).join("");
    }
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h))
      throw new Error("Invalid hex color: " + hex);
    const n = function(i) {
      return parseInt(h.slice(i, i + 2), 16) / 255;
    };
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  var utils = {
    loadFonts: async function(...fonts) {
      const names = fontNamesOf(fonts);
      await Promise.all(names.map(function(n) {
        const key = n.family + "\x00" + n.style;
        if (!fontLoads[key]) {
          fontLoads[key] = figma.loadFontAsync(n).catch(function(e) {
            delete fontLoads[key];
            throw new Error('Font "' + n.family + " " + n.style + '" is not available: ' + (e && e.message ? e.message : e));
          });
        }
        return fontLoads[key];
      }));
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
    }
  };
  async function getNode(id) {
    const node = await figma.getNodeByIdAsync(id);
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
    const size = await image.getSizeAsync();
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
        w = size.width;
        h = size.height;
      } else if (!h)
        h = w * size.height / size.width;
      else if (!w)
        w = h * size.width / size.height;
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
      imageWidth: size.width,
      imageHeight: size.height
    };
  }
  async function importSvg(p) {
    if (!p.svg)
      throw codeError("Empty SVG", "BAD_ARGS");
    const node = figma.createNodeFromSvg(String(p.svg));
    if (p.name)
      node.name = p.name;
    (await parentFor(p.parentId)).appendChild(node);
    place(node, p.x, p.y);
    return { nodeId: node.id, name: node.name, width: round(node.width), height: round(node.height) };
  }
  function round(n) {
    return Math.round(n * 100) / 100;
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

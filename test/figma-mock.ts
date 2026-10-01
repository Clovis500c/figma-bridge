// A small in-memory stand-in for the Figma Plugin API, enough to unit-test plugin modules
// (plugin/lib/*) without Figma. Nodes are plain objects; only what the tests touch is modelled.

let nextId = 1;
const mixed = Symbol("mixed");

export interface MockNode {
  id: string;
  type: string;
  name: string;
  parent: MockNode | null;
  children?: MockNode[];
  visible: boolean;
  removed: boolean;
  boundVariables: Record<string, any>;
  [key: string]: any;
}

export interface MockVariable {
  id: string;
  name: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  valuesByMode: Record<string, any>;
  variableCollectionId: string;
  scopes: string[];
  description: string;
  remote: boolean;
  hiddenFromPublishing: boolean;
  resolveForConsumer(node: MockNode): { value: any; resolvedType: string };
}

export function hex(h: string, a?: number) {
  const n = (i: number) => parseInt(h.replace("#", "").slice(i, i + 2), 16) / 255;
  return a === undefined ? { r: n(0), g: n(2), b: n(4) } : { r: n(0), g: n(2), b: n(4), a };
}

export const solid = (h: string, opacity = 1) => ({ type: "SOLID", color: hex(h), opacity, visible: true });

export function node(type: string, props: Record<string, any> = {}, children?: MockNode[]): MockNode {
  const n: MockNode = {
    id: `1:${nextId++}`,
    type,
    name: props.name ?? type.charAt(0) + type.slice(1).toLowerCase(),
    parent: null,
    visible: true,
    removed: false,
    boundVariables: {},
    fills: [],
    strokes: [],
    fillStyleId: "",
    strokeStyleId: "",
    effectStyleId: "",
    ...(type === "TEXT" ? { characters: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 14, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 }, textStyleId: "", hasMissingFont: false } : {}),
    ...(type === "FRAME" || type === "COMPONENT" ? { layoutMode: "NONE", itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0, clipsContent: false } : {}),
    ...props,
    width: props.width ?? 100,
    height: props.height ?? 100,
    x: 0,
    y: 0,
    appendChild(child: MockNode) {
      if (child.parent?.children) child.parent.children = child.parent.children.filter((c) => c !== child);
      (this.children ??= []).push(child);
      child.parent = this as MockNode;
    },
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    resizeWithoutConstraints(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    remove() {
      if (this.parent?.children) this.parent.children = this.parent.children.filter((c: MockNode) => c !== this);
      this.removed = true;
    },
    findOne(pred: (n: MockNode) => boolean): MockNode | null {
      for (const c of this.children ?? []) {
        if (pred(c)) return c;
        const hit = c.findOne?.(pred);
        if (hit) return hit;
      }
      return null;
    },
    setBoundVariable(field: string, v: MockVariable | null) {
      if (v) this.boundVariables[field] = { type: "VARIABLE_ALIAS", id: v.id };
      else delete this.boundVariables[field];
    },
    async setTextStyleIdAsync(id: string) {
      this.textStyleId = id;
    },
    async getInstancesAsync() {
      return [];
    },
  };
  if (children) {
    n.children = children;
    for (const c of children) c.parent = n;
  }
  return n;
}

export function installFigma(opts: {
  pages: MockNode[];
  collections?: { id: string; name: string; modes: { modeId: string; name: string }[]; defaultModeId: string }[];
  variables?: (Omit<MockVariable, "resolveForConsumer" | "description" | "remote" | "hiddenFromPublishing" | "scopes"> & { scopes?: string[] })[];
  paintStyles?: any[];
  textStyles?: any[];
  effectStyles?: any[];
  editorType?: string;
}) {
  const root: any = {
    type: "DOCUMENT",
    name: "Mock file",
    children: opts.pages,
    parent: null,
    findAllWithCriteria(c: { types: string[] }) {
      return all().filter((n) => c.types.includes(n.type));
    },
  };
  for (const p of opts.pages) p.parent = root;
  const collections = opts.collections ?? [];
  const variables: MockVariable[] = (opts.variables ?? []).map((v: any) => ({
    description: "",
    remote: false,
    hiddenFromPublishing: false,
    scopes: ["ALL_SCOPES"],
    ...v,
    resolveForConsumer(this: MockVariable) {
      let cur: MockVariable | undefined = this;
      for (let i = 0; i < 10 && cur; i++) {
        const col = collections.find((c) => c.id === cur!.variableCollectionId)!;
        const raw: any = cur.valuesByMode[col.defaultModeId];
        if (raw && raw.type === "VARIABLE_ALIAS") cur = variables.find((x) => x.id === raw.id);
        else return { value: raw, resolvedType: cur.resolvedType };
      }
      return { value: null, resolvedType: this.resolvedType };
    },
  }));
  const all = (): MockNode[] => {
    const out: MockNode[] = [];
    const walk = (n: any) => {
      out.push(n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(root);
    return out;
  };
  const figma: any = {
    mixed,
    root,
    currentPage: opts.pages[0],
    editorType: "figma",
    fileKey: undefined,
    skipInvisibleInstanceChildren: true,
    async loadAllPagesAsync() {},
    async loadFontAsync() {},
    async getNodeByIdAsync(id: string) {
      return all().find((n) => n.id === id) ?? null;
    },
    async getStyleByIdAsync(id: string) {
      return [...(opts.paintStyles ?? []), ...(opts.textStyles ?? []), ...(opts.effectStyles ?? [])].find((s) => s.id === id) ?? null;
    },
    async getLocalPaintStylesAsync() {
      return opts.paintStyles ?? [];
    },
    async getLocalTextStylesAsync() {
      return opts.textStyles ?? [];
    },
    async getLocalEffectStylesAsync() {
      return opts.effectStyles ?? [];
    },
    variables: {
      async getLocalVariablesAsync() {
        return variables;
      },
      async getLocalVariableCollectionsAsync() {
        return collections;
      },
      async getVariableByIdAsync(id: string) {
        return variables.find((v) => v.id === id) ?? null;
      },
      async getVariableCollectionByIdAsync(id: string) {
        return collections.find((c) => c.id === id) ?? null;
      },
      setBoundVariableForPaint(paint: any, _field: string, v: MockVariable) {
        return { ...paint, boundVariables: { color: { type: "VARIABLE_ALIAS", id: v.id } } };
      },
    },
    ui: { postMessage() {} },
  };
  // Node creation, enough for build: frames, text, shapes, FigJam and Slides nodes.
  const sublayer = () => ({ characters: "", fontName: { family: "Inter", style: "Medium" }, fontSize: 16, fills: [], getRangeAllFontNames: () => [{ family: "Inter", style: "Medium" }] });
  const created = (type: string, extra: Record<string, any> = {}) => {
    const n = node(type, { name: "", ...extra });
    n.name = extra.name ?? "";
    return n;
  };
  const frameProps = () => ({ layoutMode: "NONE", children: [], clipsContent: false, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO" });
  /** Grid tracks follow their count, like Figma. */
  const gridify = (n: MockNode) => {
    for (const [count, sizes] of [["gridColumnCount", "gridColumnSizes"], ["gridRowCount", "gridRowSizes"]] as const) {
      let v = 0;
      n[sizes] = [];
      Object.defineProperty(n, count, {
        enumerable: true,
        get: () => v,
        set: (k: number) => {
          v = k;
          n[sizes] = Array.from({ length: k }, () => ({ type: "FLEX", value: 1 }));
        },
      });
    }
    return n;
  };
  const textRanges = () => {
    const ranges: any[] = [];
    const rec = (kind: string) => (start: number, end: number, value: unknown) => void ranges.push({ kind, start, end, value });
    return {
      ranges,
      setRangeFontName: rec("font"),
      setRangeFontSize: rec("size"),
      setRangeFills: rec("fills"),
      setRangeHyperlink: rec("link"),
      setRangeTextDecoration: rec("decoration"),
      setRangeTextCase: rec("case"),
      setRangeFillStyleIdAsync: async (a: number, b: number, id: string) => void ranges.push({ kind: "fillStyle", start: a, end: b, value: id }),
    };
  };
  Object.assign(figma, {
    editorType: opts.editorType ?? "figma",
    viewport: { center: { x: 0, y: 0 }, zoom: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scrollAndZoomIntoView() {} },
    commitUndo() {},
    notify() {},
    createFrame: () => gridify(created("FRAME", frameProps())),
    createComponent: () => gridify(created("COMPONENT", frameProps())),
    createRectangle: () => created("RECTANGLE"),
    createEllipse: () => created("ELLIPSE"),
    createLine: () => created("LINE"),
    createText: () => created("TEXT", { characters: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12, textAutoResize: "NONE", layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", ...textRanges() }),
    createSection: () => created("SECTION", { children: [] }),
    createNodeFromSvg: (svg: string) => {
      const w = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 24);
      const h = Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 24);
      const n = created("FRAME", { ...frameProps(), width: w, height: h, svg });
      n.rescale = (k: number) => {
        n.width *= k;
        n.height *= k;
      };
      return n;
    },
    createSticky: () => created("STICKY", { text: sublayer(), isWideWidth: false, authorVisible: true, width: 240, height: 240 }),
    createShapeWithText: () => created("SHAPE_WITH_TEXT", { text: sublayer(), shapeType: "SQUARE", strokeWeight: 1, width: 208, height: 208 }),
    createConnector: () => created("CONNECTOR", { text: sublayer(), connectorLineType: "ELBOWED", connectorStart: {}, connectorEnd: {}, dashPattern: [] }),
    createCodeBlock: () => created("CODE_BLOCK", { code: "", codeLanguage: "PLAINTEXT" }),
    createTable: (rows: number, cols: number) => {
      const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ({ type: "TABLE_CELL", rowIndex: r, columnIndex: c, text: sublayer(), fills: [] })));
      return created("TABLE", { numRows: rows, numColumns: cols, cellAt: (r: number, c: number) => cells[r]![c]!, cells });
    },
    createSlide: () => {
      const slide = created("SLIDE", { ...frameProps(), width: 1920, height: 1080, fills: [solid("#FFFFFF")] });
      const grid = (figma.slides ??= []);
      grid.push(slide);
      figma.currentPage.appendChild(slide);
      return slide;
    },
  });
  for (const p of opts.pages) {
    p.selection = p.selection ?? [];
    p.backgrounds = p.backgrounds ?? [solid("#FFFFFF")];
  }
  (globalThis as any).figma = figma;
  return { figma, variables, all };
}

export function page(name: string, children: MockNode[]) {
  return node("PAGE", { name, selection: [] }, children);
}

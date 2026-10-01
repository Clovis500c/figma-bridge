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

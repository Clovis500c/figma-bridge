// build {type:"diagram"}: a Mermaid-like flowchart → FigJam shapes (or stickies) laid out in layers,
// with connectors, inside a section. Subgraphs become nested sections.

export interface DiagramNode {
  id: string;
  label: string;
  shape: string;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  thick?: boolean;
  arrow: boolean;
}
export interface Subgraph {
  id: string;
  label: string;
  nodes: string[];
}
export interface Diagram {
  direction: "TB" | "BT" | "LR" | "RL";
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  subgraphs: Subgraph[];
}

// id[Text] id(Text) id([Text]) id[[Text]] id[(Text)] id((Text)) id{Text} id{{Text}} id>Text] id[/Text/] id[\Text\]
const SHAPES: [RegExp, string][] = [
  [/^\(\((.*)\)\)$/s, "ellipse"],
  [/^\(\[(.*)\]\)$/s, "rounded"],
  [/^\[\[(.*)\]\]$/s, "process"],
  [/^\[\((.*)\)\]$/s, "database"],
  [/^\{\{(.*)\}\}$/s, "hexagon"],
  [/^\[\/(.*)\/\]$/s, "parallelogram"],
  [/^\[\\(.*)\\\]$/s, "parallelogramleft"],
  [/^\[\/(.*)\\\]$/s, "trapezoid"],
  [/^>(.*)\]$/s, "chevron"],
  [/^\((.*)\)$/s, "rounded"],
  [/^\{(.*)\}$/s, "diamond"],
  [/^\[(.*)\]$/s, "square"],
];

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/s, "$1").replace(/<br\s*\/?>/gi, "\n");

/** Splits a statement into node references and edges: A[x] -->|label| B --- C */
const EDGE = /\s*(<?-{2,}>|<?-\.+->|<?={2,}>|-{3,}|={3,}|-\.+-|--\s+[^-]+?\s+-->|==\s+[^=]+?\s+==>|-\.\s+[^.]+?\s+\.->)\s*(?:\|([^|]*)\|)?\s*/;

export function parseDiagram(source: string): Diagram {
  const lines = source
    .replace(/%%.*$/gm, "")
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  const d: Diagram = { direction: "TB", nodes: [], edges: [], subgraphs: [] };
  const byId = new Map<string, DiagramNode>();
  const stack: Subgraph[] = [];
  const node = (ref: string): string | null => {
    const m = /^([A-Za-z0-9_\-.$]+)\s*(.*)$/s.exec(ref.trim());
    if (!m) return null;
    const id = m[1]!;
    const rest = m[2]!.trim();
    let n = byId.get(id);
    if (!n) {
      n = { id, label: id, shape: "rounded" };
      byId.set(id, n);
      d.nodes.push(n);
    }
    if (rest) {
      for (const [re, shape] of SHAPES) {
        const s = re.exec(rest);
        if (s) {
          n.label = unquote(s[1]!);
          n.shape = shape;
          break;
        }
      }
    }
    for (const g of stack) if (!g.nodes.includes(id)) g.nodes.push(id);
    return id;
  };
  for (const line of lines) {
    const header = /^(?:flowchart|graph)\s*(TB|TD|BT|LR|RL)?\b/i.exec(line);
    if (header) {
      const dir = (header[1] ?? "TB").toUpperCase();
      d.direction = (dir === "TD" ? "TB" : dir) as Diagram["direction"];
      continue;
    }
    const sub = /^subgraph\s+([^\s[]+)(?:\s*\[(.*)\])?\s*(.*)$/i.exec(line);
    if (sub) {
      const g: Subgraph = { id: sub[1]!, label: unquote(sub[2] ?? (sub[3] || sub[1]!)), nodes: [] };
      d.subgraphs.push(g);
      stack.push(g);
      continue;
    }
    if (/^end$/i.test(line)) {
      stack.pop();
      continue;
    }
    if (/^(direction|classDef|class|style|linkStyle|click)\b/.test(line)) continue;
    // A chain of nodes joined by edges; "A & B --> C" links every pair.
    const parts: string[] = [];
    const links: { op: string; label?: string }[] = [];
    let rest = line;
    for (;;) {
      const m = EDGE.exec(rest);
      if (!m) {
        parts.push(rest);
        break;
      }
      parts.push(rest.slice(0, m.index));
      let op = m[1]!;
      let label = m[2];
      const inline = /^(--|==|-\.)\s+(.+?)\s+(-->|==>|\.->)$/.exec(op);
      if (inline) {
        label = inline[2];
        op = inline[1] === "--" ? "-->" : inline[1] === "==" ? "==>" : "-.->";
      }
      links.push({ op, label: label?.trim() || undefined });
      rest = rest.slice(m.index + m[0].length);
    }
    const groups = parts.map((p) => p.split(/\s+&\s+/).map(node).filter((x): x is string => !!x));
    links.forEach((l, i) => {
      for (const from of groups[i] ?? []) {
        for (const to of groups[i + 1] ?? []) {
          d.edges.push({ from, to, label: l.label, dashed: l.op.includes("."), thick: l.op.includes("="), arrow: />$/.test(l.op) });
        }
      }
    });
  }
  return d;
}

export interface LaidOut {
  positions: Map<string, { x: number; y: number; w: number; h: number }>;
  width: number;
  height: number;
}

/** Layered layout: longest-path layers, barycenter ordering, centered rows (or columns for LR). */
export function layoutDiagram(d: Diagram, opts: { gap?: number; layerGap?: number; size?: (n: DiagramNode) => { w: number; h: number } } = {}): LaidOut {
  const size = opts.size ?? defaultSize;
  const ids = d.nodes.map((n) => n.id);
  const out = new Map<string, string[]>(ids.map((i) => [i, []]));
  const inn = new Map<string, string[]>(ids.map((i) => [i, []]));
  // Break cycles: edges that go back to a node still on the DFS stack are ignored for layering.
  const state = new Map<string, number>();
  const forward: [string, string][] = [];
  const adj = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of d.edges) if (e.from !== e.to) adj.get(e.from)!.push(e.to);
  const dfs = (v: string) => {
    state.set(v, 1);
    for (const w of adj.get(v)!) {
      if (state.get(w) === 1) continue;
      forward.push([v, w]);
      if (!state.get(w)) dfs(w);
    }
    state.set(v, 2);
  };
  for (const v of ids) if (!state.get(v)) dfs(v);
  for (const [a, b] of forward) {
    out.get(a)!.push(b);
    inn.get(b)!.push(a);
  }
  const layer = new Map<string, number>();
  const visit = (v: string): number => {
    if (layer.has(v)) return layer.get(v)!;
    layer.set(v, 0);
    const l = Math.max(0, ...inn.get(v)!.map((u) => visit(u) + 1));
    layer.set(v, l);
    return l;
  };
  for (const v of ids) visit(v);
  const layers: string[][] = [];
  for (const v of ids) (layers[layer.get(v)!] ??= []).push(v);
  // Barycenter sweeps reduce crossings.
  const pos = new Map<string, number>();
  const index = () => layers.forEach((l) => l.forEach((v, i) => pos.set(v, i)));
  index();
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const l of order) {
      const bary = (v: string) => {
        const ns = down ? inn.get(v)! : out.get(v)!;
        return ns.length ? ns.reduce((a, u) => a + pos.get(u)!, 0) / ns.length : pos.get(v)!;
      };
      l.sort((a, b) => bary(a) - bary(b));
      l.forEach((v, i) => pos.set(v, i));
    }
  }
  const horizontal = d.direction === "LR" || d.direction === "RL";
  const gap = opts.gap ?? 60;
  const layerGap = opts.layerGap ?? 100;
  const sizes = new Map(d.nodes.map((n) => [n.id, size(n)]));
  // Each layer is a row (TB) or a column (LR); layers are as deep as their largest node.
  const along = (v: string) => (horizontal ? sizes.get(v)!.h : sizes.get(v)!.w);
  const across = (v: string) => (horizontal ? sizes.get(v)!.w : sizes.get(v)!.h);
  const spans = layers.map((l) => l.reduce((a, v) => a + along(v), 0) + gap * Math.max(0, l.length - 1));
  const widest = Math.max(0, ...spans);
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  let depth = 0;
  layers.forEach((l, li) => {
    const thickness = Math.max(...l.map(across));
    let cursor = (widest - spans[li]!) / 2;
    for (const v of l) {
      const s = sizes.get(v)!;
      const main = cursor;
      const cross = depth + (thickness - across(v)) / 2;
      positions.set(v, horizontal ? { x: cross, y: main, w: s.w, h: s.h } : { x: main, y: cross, w: s.w, h: s.h });
      cursor += along(v) + gap;
    }
    depth += thickness + layerGap;
  });
  const total = Math.max(0, depth - layerGap);
  // Reversed directions mirror the depth axis.
  if (d.direction === "BT" || d.direction === "RL") {
    for (const p of positions.values()) {
      if (horizontal) p.x = total - p.x - p.w;
      else p.y = total - p.y - p.h;
    }
  }
  return { positions, width: horizontal ? total : widest, height: horizontal ? widest : total };
}

function defaultSize(n: DiagramNode): { w: number; h: number } {
  const lines = n.label.split("\n");
  const longest = Math.max(...lines.map((l) => l.length));
  const w = Math.min(320, Math.max(n.shape === "diamond" ? 180 : 160, longest * 9 + 48));
  const h = Math.max(n.shape === "diamond" ? 120 : 80, lines.length * 22 + 40);
  return n.shape === "ellipse" ? { w, h: Math.max(h, 100) } : { w, h };
}

/** {type:"diagram", source, name?, as?: "shapes"|"stickies", color?} → a section spec for build. */
export function diagramSpec(spec: Record<string, any>): Record<string, any> {
  const d = parseDiagram(String(spec.source ?? spec.mermaid ?? ""));
  if (!d.nodes.length) throw new Error('diagram: no nodes found. Example: source:"flowchart LR\\n A[Start] --> B{OK?}\\n B -->|yes| C(Done)"');
  const stickies = spec.as === "stickies";
  const STICKY = { w: 240, h: 240 };
  const lay = layoutDiagram(d, stickies ? { size: () => STICKY, gap: 80, layerGap: 120 } : {});
  const pad = 80;
  const head = 60;
  const inGroup = new Map<string, Subgraph>();
  for (const g of d.subgraphs) for (const id of g.nodes) if (!inGroup.has(id)) inGroup.set(id, g);
  const nodeSpec = (n: DiagramNode, dx: number, dy: number) => {
    const p = lay.positions.get(n.id)!;
    const base = { name: n.label.split("\n")[0], key: `${spec.key ?? "diagram"}:${n.id}`, x: Math.round(p.x + dx), y: Math.round(p.y + dy) };
    return stickies
      ? { ...base, type: "sticky", text: n.label, color: spec.color ?? "yellow" }
      : { ...base, type: "shape", shape: n.shape, text: n.label, w: Math.round(p.w), h: Math.round(p.h), ...(spec.color ? { fill: spec.color } : {}) };
  };
  const children: Record<string, any>[] = [];
  // Subgraphs: a section around their nodes, with the nodes inside it.
  for (const g of d.subgraphs) {
    const members = g.nodes.filter((id) => inGroup.get(id) === g).map((id) => d.nodes.find((n) => n.id === id)!);
    if (!members.length) continue;
    const ps = members.map((n) => lay.positions.get(n.id)!);
    const x0 = Math.min(...ps.map((p) => p.x)) - 40;
    const y0 = Math.min(...ps.map((p) => p.y)) - head;
    const x1 = Math.max(...ps.map((p) => p.x + p.w)) + 40;
    const y1 = Math.max(...ps.map((p) => p.y + p.h)) + 40;
    children.push({
      type: "section",
      name: g.label,
      x: Math.round(x0 + pad),
      y: Math.round(y0 + pad + head),
      w: Math.round(x1 - x0),
      h: Math.round(y1 - y0),
      children: members.map((n) => nodeSpec(n, -x0, -y0)),
    });
  }
  for (const n of d.nodes) if (!inGroup.has(n.id)) children.push(nodeSpec(n, pad, pad + head));
  for (const e of d.edges) {
    children.push({
      type: "connector",
      from: `${spec.key ?? "diagram"}:${e.from}`,
      to: `${spec.key ?? "diagram"}:${e.to}`,
      ...(e.label ? { label: e.label } : {}),
      ...(e.dashed ? { dashed: true } : {}),
      ...(e.thick ? { strokeWidth: 4 } : {}),
      ...(e.arrow ? {} : { endArrow: "none" }),
      line: spec.line ?? "elbowed",
    });
  }
  return {
    type: "section",
    name: spec.name ?? "Diagram",
    ...(spec.x !== undefined ? { x: spec.x } : {}),
    ...(spec.y !== undefined ? { y: spec.y } : {}),
    w: Math.round(lay.width + pad * 2),
    h: Math.round(lay.height + pad * 2 + head),
    children,
  };
}

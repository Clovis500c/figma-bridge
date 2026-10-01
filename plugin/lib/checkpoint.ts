// Checkpoints: copies of layers kept on a dedicated page, restorable later.
import { codeError, getNode } from "./util";

const PAGE_NAME = "⟲ Bridge checkpoints";
const KEY = "bridge-checkpoint";

interface Meta {
  id: string;
  label: string;
  at: number;
}
interface Item {
  orig: string;
  parent: string;
  index: number;
  x: number;
  y: number;
  name: string;
}

async function checkpointPage(create: boolean): Promise<PageNode | null> {
  for (let i = 0; i < figma.root.children.length; i++) {
    const p = figma.root.children[i];
    if (p.getPluginData(KEY) === "page" || p.name === PAGE_NAME) {
      await p.loadAsync();
      return p;
    }
  }
  if (!create) return null;
  const page = figma.createPage();
  page.name = PAGE_NAME;
  page.setPluginData(KEY, "page");
  return page;
}

function holders(page: PageNode): FrameNode[] {
  return page.children.filter(function (n) {
    return n.type === "FRAME" && !!n.getPluginData(KEY);
  }) as FrameNode[];
}

function metaOf(f: FrameNode): Meta {
  return JSON.parse(f.getPluginData(KEY));
}

export async function checkpoint(p: any) {
  const action = String(p.action || "save");
  if (action === "save") return save(p);
  if (action === "list") return list();
  if (action === "restore") return restore(p);
  if (action === "delete") return remove(p);
  throw codeError('Unknown checkpoint action "' + action + '" (save, list, restore, delete)', "BAD_ARGS");
}

async function save(p: any) {
  let nodes: SceneNode[] = [];
  if (Array.isArray(p.nodeIds) && p.nodeIds.length) {
    for (let i = 0; i < p.nodeIds.length; i++) nodes.push((await getNode(p.nodeIds[i])) as SceneNode);
  } else {
    nodes = figma.currentPage.selection.slice();
  }
  if (!nodes.length) throw codeError("Nothing to save: pass nodeIds or select layers", "BAD_ARGS");
  const page = await checkpointPage(true);
  const meta: Meta = { id: String(Date.now().toString(36)), label: String(p.label || ""), at: Date.now() };
  const holder = figma.createFrame();
  page!.appendChild(holder);
  holder.name = "Checkpoint " + meta.id + (meta.label ? " · " + meta.label : "");
  holder.fills = [];
  holder.clipsContent = false;
  holder.setPluginData(KEY, JSON.stringify(meta));
  const last = holders(page!);
  holder.y = last.length > 1 ? last[last.length - 2].y + last[last.length - 2].height + 200 : 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const parent = n.parent as BaseNode & ChildrenMixin;
    const item: Item = { orig: n.id, parent: parent ? parent.id : "", index: parent ? parent.children.indexOf(n) : 0, x: n.x, y: n.y, name: n.name };
    const copy = n.clone();
    holder.appendChild(copy);
    copy.setPluginData(KEY, JSON.stringify(item));
  }
  return { checkpointId: meta.id, label: meta.label, saved: nodes.length };
}

async function list() {
  const page = await checkpointPage(false);
  if (!page) return { checkpoints: [] };
  return {
    checkpoints: holders(page).map(function (h) {
      const m = metaOf(h);
      return {
        id: m.id,
        label: m.label,
        savedAt: new Date(m.at).toISOString(),
        layers: h.children.map(function (c) {
          return (JSON.parse(c.getPluginData(KEY) || "{}") as Item).name || c.name;
        }),
      };
    }),
  };
}

async function find(id: string): Promise<{ page: PageNode; holder: FrameNode }> {
  const page = await checkpointPage(false);
  if (page) {
    const all = holders(page);
    if (id === "latest" && all.length) return { page: page, holder: all[all.length - 1] };
    for (let i = 0; i < all.length; i++) if (metaOf(all[i]).id === id) return { page: page, holder: all[i] };
  }
  throw codeError('Checkpoint "' + id + '" not found. Use checkpoint {action:"list"}.', "NOT_FOUND");
}

async function restore(p: any) {
  const found = await find(String(p.id || "latest"));
  const restored: { [oldId: string]: string } = {};
  const kids = found.holder.children.slice();
  for (let i = 0; i < kids.length; i++) {
    const copy = kids[i];
    const item: Item = JSON.parse(copy.getPluginData(KEY) || "{}");
    const original = item.orig ? await figma.getNodeByIdAsync(item.orig) : null;
    let parent: any = item.parent ? await figma.getNodeByIdAsync(item.parent) : null;
    let index = item.index;
    if (original && original.parent && !original.removed) {
      parent = original.parent;
      index = parent.children.indexOf(original);
      original.remove();
    }
    if (!parent || !("insertChild" in parent)) parent = figma.currentPage;
    const fresh = copy.clone();
    fresh.setPluginData(KEY, "");
    parent.insertChild(Math.max(0, Math.min(index, parent.children.length)), fresh);
    if (!("layoutMode" in parent) || parent.layoutMode === "NONE" || (fresh as any).layoutPositioning === "ABSOLUTE") {
      fresh.x = item.x;
      fresh.y = item.y;
    }
    fresh.name = item.name || fresh.name;
    restored[item.orig] = fresh.id;
  }
  return { restored: restored, note: "Restored layers have new ids (old → new above). The checkpoint is kept." };
}

async function remove(p: any) {
  if (p.id === "all") {
    const page = await checkpointPage(false);
    if (page) {
      if (figma.currentPage === page) await figma.setCurrentPageAsync(figma.root.children[0]);
      page.remove();
    }
    return { deleted: "all" };
  }
  const found = await find(String(p.id || ""));
  found.holder.remove();
  if (!holders(found.page).length && figma.root.children.length > 1) {
    if (figma.currentPage === found.page) await figma.setCurrentPageAsync(figma.root.children[0]);
    found.page.remove();
  }
  return { deleted: p.id };
}

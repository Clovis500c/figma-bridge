// Dev Mode annotations: add notes (with pinned properties) to layers, list or clear them.
import { codeError, getNode } from "./util";

const COLORS = ["yellow", "orange", "red", "pink", "violet", "blue", "teal", "green"];

async function categoryId(label: string, color: string | undefined, created: string[]): Promise<string | undefined> {
  const api: any = (figma as any).annotations;
  if (!api || typeof api.getAnnotationCategoriesAsync !== "function") return undefined;
  const list: AnnotationCategory[] = await api.getAnnotationCategoriesAsync();
  for (let i = 0; i < list.length; i++) if (list[i].label.toLowerCase() === label.toLowerCase()) return list[i].id;
  const c = COLORS.indexOf(String(color)) !== -1 ? color : "blue";
  const cat = await api.addAnnotationCategoryAsync({ label: label, color: c });
  created.push(label);
  return cat.id;
}

function supports(node: any): boolean {
  return "annotations" in node;
}

export async function annotate(p: any) {
  const action = String(p.action || (p.label || p.properties ? "add" : "list"));
  if (action === "list") return list(p);
  if (!p.nodeId) throw codeError("`nodeId` is required to " + action + " annotations", "BAD_ARGS");
  const node: any = await getNode(p.nodeId);
  if (!supports(node)) throw codeError("A " + node.type + " node cannot have annotations", "BAD_ARGS");

  if (action === "clear") {
    const n = node.annotations.length;
    node.annotations = [];
    return { nodeId: node.id, removed: n };
  }
  if (action !== "add") throw codeError('Unknown action "' + action + '" (add, list, clear)', "BAD_ARGS");
  if (!p.label && !(p.properties && p.properties.length)) throw codeError("Give a label and/or properties", "BAD_ARGS");

  const annotation: any = {};
  if (p.label) annotation.labelMarkdown = String(p.label);
  if (Array.isArray(p.properties) && p.properties.length) {
    annotation.properties = p.properties.map(function (t: string) {
      return { type: String(t) };
    });
  }
  const createdCategories: string[] = [];
  if (p.category) {
    const id = await categoryId(String(p.category), p.color, createdCategories);
    if (id) annotation.categoryId = id;
  }
  const current: Annotation[] = p.replace ? [] : node.annotations.slice();
  try {
    node.annotations = current.concat([annotation]);
  } catch (e) {
    throw codeError("Figma rejected the annotation: " + ((e as Error).message || e) + " (check the property names)", "BAD_ARGS");
  }
  const out: any = { nodeId: node.id, annotations: node.annotations.length };
  if (createdCategories.length) out.createdCategory = createdCategories[0];
  return out;
}

async function list(p: any) {
  const root: any = p.nodeId ? await getNode(p.nodeId) : p.pageId ? await getNode(p.pageId) : figma.currentPage;
  if (root.type === "PAGE") await root.loadAsync();
  const nodes: any[] = (root.type === "PAGE" ? [] : [root]).concat(
    "findAll" in root
      ? root.findAll(function (n: any) {
          return supports(n) && n.annotations.length > 0;
        })
      : [],
  );
  const categories: { [id: string]: string } = {};
  const api: any = (figma as any).annotations;
  if (api && typeof api.getAnnotationCategoriesAsync === "function") {
    const cats: AnnotationCategory[] = await api.getAnnotationCategoriesAsync();
    for (let i = 0; i < cats.length; i++) categories[cats[i].id] = cats[i].label;
  }
  const out: any[] = [];
  for (let i = 0; i < nodes.length && out.length < 300; i++) {
    const n = nodes[i];
    if (!supports(n) || !n.annotations.length) continue;
    out.push({
      nodeId: n.id,
      name: n.name,
      annotations: n.annotations.map(function (a: Annotation) {
        const item: any = {};
        if (a.labelMarkdown || a.label) item.label = a.labelMarkdown || a.label;
        if (a.properties && a.properties.length) {
          item.properties = a.properties.map(function (x) {
            return x.type;
          });
        }
        if (a.categoryId) item.category = categories[a.categoryId] || a.categoryId;
        return item;
      }),
    });
  }
  return { count: out.length, nodes: out };
}

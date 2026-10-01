// Searches layers across pages by name, text, type, style or component.
import { codeError, getNode, pageOf, styleName } from "./util";

const MAX_LIMIT = 500;

/** "/pattern/flags" is a regex; anything else is a case-insensitive substring. */
function matcher(q: any): ((s: string) => boolean) | null {
  if (q === undefined || q === null || q === "") return null;
  const str = String(q);
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(str);
  if (m) {
    let re: RegExp;
    try {
      re = new RegExp(m[1], m[2].replace("g", ""));
    } catch (e) {
      throw codeError("Invalid regex " + str + ": " + ((e as Error).message || e), "BAD_ARGS");
    }
    return function (s: string) {
      return re.test(s);
    };
  }
  const needle = str.toLowerCase();
  return function (s: string) {
    return s.toLowerCase().indexOf(needle) !== -1;
  };
}

export async function find(p: any) {
  const byName = matcher(p.name);
  const byText = matcher(p.text);
  const byStyle = matcher(p.style);
  const byComponent = matcher(p.component);
  const types: string[] = (Array.isArray(p.type) ? p.type : p.type ? [p.type] : []).map(function (t: string) {
    return String(t).toUpperCase().replace(/[\s-]/g, "_");
  });
  if (!byName && !byText && !byStyle && !byComponent && !types.length) {
    throw codeError("Give at least one filter: name, text, type, style or component", "BAD_ARGS");
  }
  const limit = Math.max(1, Math.min(MAX_LIMIT, p.limit || 50));

  let roots: BaseNode[];
  if (p.parentId) roots = [await getNode(p.parentId)];
  else if (p.pageId) roots = [await getNode(p.pageId)];
  else roots = figma.root.children.slice();
  for (let i = 0; i < roots.length; i++) if (roots[i].type === "PAGE") await (roots[i] as PageNode).loadAsync();

  // Cheap synchronous filters first; style and component names need async lookups.
  const test = function (n: any): boolean {
    if (types.length && types.indexOf(n.type) === -1) return false;
    if (byName && !byName(n.name)) return false;
    if (byText && !(n.type === "TEXT" && byText(n.characters))) return false;
    if (byComponent && n.type !== "INSTANCE") return false;
    if (byStyle && !(n.fillStyleId || n.strokeStyleId || n.textStyleId || n.effectStyleId)) return false;
    return true;
  };
  let candidates: SceneNode[] = [];
  for (let i = 0; i < roots.length; i++) {
    const r: any = roots[i];
    if (r.type !== "PAGE" && test(r)) candidates.push(r);
    if ("findAll" in r) candidates = candidates.concat(r.findAll(test));
  }

  const matches: any[] = [];
  let total = 0;
  for (let i = 0; i < candidates.length; i++) {
    const n: any = candidates[i];
    if (byStyle && !(await usesStyle(n, byStyle))) continue;
    if (byComponent && !(await isInstanceOf(n, byComponent, String(p.component)))) continue;
    total++;
    if (matches.length < limit) matches.push(describeMatch(n));
  }
  return { total: total, matches: matches, truncated: total > matches.length };
}

async function usesStyle(n: any, test: (s: string) => boolean): Promise<boolean> {
  const fields = ["fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId"];
  for (let i = 0; i < fields.length; i++) {
    const name = await styleName(n[fields[i]]);
    if (name && test(name)) return true;
  }
  return false;
}

async function isInstanceOf(n: InstanceNode, test: (s: string) => boolean, ref: string): Promise<boolean> {
  const main = await n.getMainComponentAsync();
  if (!main) return false;
  if (main.id === ref || main.key === ref || test(main.name)) return true;
  const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
  return !!set && (set.id === ref || set.key === ref || test(set.name));
}

function describeMatch(n: SceneNode) {
  const names: string[] = [];
  let p: BaseNode | null = n.parent;
  while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
    names.unshift(p.name);
    p = p.parent;
  }
  const page = pageOf(n);
  const out: any = { id: n.id, name: n.name, type: n.type, page: page ? page.name : null, path: names.join(" / ") };
  if (n.type === "TEXT") out.text = n.characters.length > 80 ? n.characters.slice(0, 77) + "…" : n.characters;
  return out;
}

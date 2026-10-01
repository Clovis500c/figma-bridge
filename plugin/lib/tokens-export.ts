// design_tokens export, plugin side: reads every local variable collection (all modes, aliases kept as
// references) and the paint, text and effect styles. The server turns this into DTCG, CSS, Tailwind,
// SCSS or TypeScript.
import { localStyles, round, toHex } from "./util";

const TYPES: { [t: string]: string } = { COLOR: "color", FLOAT: "number", STRING: "string", BOOLEAN: "boolean" };

export async function exportTokens(p: any) {
  const only: string[] | null = Array.isArray(p.collections) && p.collections.length ? p.collections : null;
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const vars = await figma.variables.getLocalVariablesAsync();
  const byId: { [id: string]: Variable } = {};
  for (let i = 0; i < vars.length; i++) byId[vars[i].id] = vars[i];
  const collName: { [id: string]: string } = {};
  for (let i = 0; i < collections.length; i++) collName[collections[i].id] = collections[i].name;
  const warnings: string[] = [];

  // Aliases may point to library variables, which are not in the local list.
  const aliasOf = async function (id: string) {
    let v: Variable | null = byId[id] || null;
    if (!v) {
      try {
        v = await figma.variables.getVariableByIdAsync(id);
      } catch (e) {}
      if (v) byId[id] = v;
    }
    if (!v) return { alias: { collection: "", name: id, missing: true } };
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
    const out: any = { alias: { collection: collection, name: v.name } };
    if (v.remote) out.alias.remote = true;
    return out;
  };

  const value = async function (raw: any, type: string): Promise<any> {
    if (raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS") return aliasOf(raw.id);
    if (type === "COLOR" && raw && typeof raw === "object") return toHex(raw);
    if (type === "FLOAT") return round(Number(raw));
    return raw;
  };

  const outCollections: any[] = [];
  for (let c = 0; c < collections.length; c++) {
    const col = collections[c];
    if (only && only.indexOf(col.name) === -1) continue;
    // Default mode first: it is the base value everywhere else.
    const modes = col.modes.slice().sort(function (a, b) {
      return (a.modeId === col.defaultModeId ? 0 : 1) - (b.modeId === col.defaultModeId ? 0 : 1);
    });
    const list: any[] = [];
    for (let i = 0; i < vars.length; i++) {
      const v = vars[i];
      if (v.variableCollectionId !== col.id) continue;
      const values: any = {};
      for (let m = 0; m < modes.length; m++) values[modes[m].name] = await value(v.valuesByMode[modes[m].modeId], v.resolvedType);
      const item: any = { name: v.name, type: TYPES[v.resolvedType] || "string", values: values };
      if (v.description) item.description = v.description;
      if (v.scopes && v.scopes.length && !(v.scopes.length === 1 && v.scopes[0] === "ALL_SCOPES")) item.scopes = v.scopes.slice();
      if (v.hiddenFromPublishing) item.hidden = true;
      list.push(item);
    }
    outCollections.push({
      name: col.name,
      modes: modes.map(function (m) {
        return m.name;
      }),
      variables: list,
    });
  }

  const styles = await localStyles();
  const paint: any[] = [];
  for (let i = 0; i < styles.paint.length; i++) {
    const s = styles.paint[i];
    const paints: any[] = [];
    for (let k = 0; k < s.paints.length; k++) {
      const pt: any = s.paints[k];
      if (pt.visible === false) continue;
      if (pt.type === "SOLID") {
        const bound = pt.boundVariables && pt.boundVariables.color;
        paints.push(bound ? await aliasOf(bound.id) : toHex(pt.color, pt.opacity));
      } else if (pt.type.indexOf("GRADIENT") === 0) {
        const t = pt.gradientTransform;
        const g: any = {
          gradient: pt.gradientStops.map(function (st: ColorStop) {
            return { color: toHex(st.color), at: round(st.position) };
          }),
        };
        if (pt.type === "GRADIENT_LINEAR") g.angle = round((Math.atan2(t[0][1], t[0][0]) * 180) / Math.PI);
        else g.type = pt.type.replace("GRADIENT_", "").toLowerCase();
        paints.push(g);
      } else {
        warnings.push('Paint style "' + s.name + '": ' + pt.type.toLowerCase() + " paints are not exported");
      }
    }
    if (!paints.length) continue;
    const item: any = { name: s.name, value: paints.length === 1 ? paints[0] : paints };
    if (s.description) item.description = s.description;
    paint.push(item);
  }

  const text: any[] = [];
  for (let i = 0; i < styles.text.length; i++) {
    const s = styles.text[i];
    const item: any = { name: s.name, font: s.fontName.family, style: s.fontName.style, size: round(s.fontSize) };
    const lh = s.lineHeight;
    if (lh.unit === "PIXELS") item.lineHeight = round(lh.value);
    else if (lh.unit === "PERCENT") item.lineHeight = round(lh.value) + "%";
    if (s.letterSpacing.value) item.letterSpacing = s.letterSpacing.unit === "PERCENT" ? round(s.letterSpacing.value) + "%" : round(s.letterSpacing.value);
    if (s.textCase && s.textCase !== "ORIGINAL") item.case = s.textCase === "UPPER" ? "upper" : s.textCase === "LOWER" ? "lower" : "title";
    if (s.textDecoration && s.textDecoration !== "NONE") item.decoration = s.textDecoration === "UNDERLINE" ? "underline" : "strike";
    if (s.paragraphSpacing) item.paragraphSpacing = round(s.paragraphSpacing);
    const bound: any = (s as any).boundVariables || {};
    const keys = Object.keys(bound);
    if (keys.length) {
      item.variables = {};
      for (let k = 0; k < keys.length; k++) if (bound[keys[k]] && bound[keys[k]].id) item.variables[keys[k]] = (await aliasOf(bound[keys[k]].id)).alias;
    }
    if (s.description) item.description = s.description;
    text.push(item);
  }

  const effect: any[] = [];
  for (let i = 0; i < styles.effect.length; i++) {
    const s = styles.effect[i];
    const list: any[] = [];
    for (let k = 0; k < s.effects.length; k++) {
      const e: any = s.effects[k];
      if (e.visible === false) continue;
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
        const sh: any = { x: round(e.offset.x), y: round(e.offset.y), blur: round(e.radius), spread: round(e.spread || 0), color: toHex(e.color) };
        if (e.type === "INNER_SHADOW") sh.inner = true;
        if (e.boundVariables && e.boundVariables.color) sh.colorVariable = (await aliasOf(e.boundVariables.color.id)).alias;
        list.push(sh);
      } else {
        list.push({ type: e.type === "LAYER_BLUR" ? "layer" : "background", blur: round(e.radius) });
      }
    }
    if (!list.length) continue;
    const item: any = { name: s.name, value: list };
    if (s.description) item.description = s.description;
    effect.push(item);
  }

  const out: any = { fileName: figma.root.name, collections: outCollections, styles: { colors: paint, text: text, effects: effect } };
  if (warnings.length) out.warnings = warnings.slice(0, 40);
  return out;
}

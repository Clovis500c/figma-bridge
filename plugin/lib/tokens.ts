// Writes a design system: variable collections with modes, and paint/text/effect styles.
// Idempotent: everything is matched by name and updated in place. The server normalizes
// simple JSON, W3C tokens and Tailwind themes into the shape handled here.
import { lineHeight, shadowEffect, toPaint } from "./build";
import { codeError, invalidateCaches, loadFont, localStyles, parseFont, parseHex } from "./util";

interface Count {
  created: number;
  updated: number;
}

const TYPES: { [t: string]: VariableResolvedDataType } = { color: "COLOR", number: "FLOAT", string: "STRING", boolean: "BOOLEAN" };

function counter(): Count {
  return { created: 0, updated: 0 };
}

export async function designTokens(p: any) {
  const warnings: string[] = (p.warnings || []).slice();
  const counts = {
    collections: counter(),
    modes: counter(),
    variables: counter(),
    paintStyles: counter(),
    textStyles: counter(),
    effectStyles: counter(),
  };
  const collections: any[] = Array.isArray(p.collections) ? p.collections : [];
  const styles = p.styles || {};
  if (!collections.length && !(styles.colors || []).length && !(styles.text || []).length && !(styles.effects || []).length) {
    throw codeError("No tokens found: give collections and/or styles (see the tool description for the accepted formats)", "BAD_ARGS");
  }

  if (collections.length) await writeVariables(collections, counts, warnings);
  invalidateCaches(); // styles may reference the variables just written
  await writeStyles(styles, counts, warnings);
  invalidateCaches();

  const out: any = { counts: counts };
  if (warnings.length) out.warnings = warnings.slice(0, 60);
  return out;
}

// ─── Variables ──────────────────────────────────────────────────────────────

interface Pending {
  variable: Variable | null;
  spec: any;
  collection: VariableCollection;
  modeIds: { [name: string]: string };
}

async function writeVariables(specs: any[], counts: any, warnings: string[]) {
  const allCollections = await figma.variables.getLocalVariableCollectionsAsync();
  const allVars = await figma.variables.getLocalVariablesAsync();
  const byName: { [qualified: string]: Variable } = {};
  const collName: { [id: string]: string } = {};
  for (let i = 0; i < allCollections.length; i++) collName[allCollections[i].id] = allCollections[i].name;
  const index = function (v: Variable, collectionName: string) {
    byName[collectionName + "/" + v.name] = v;
    if (!byName[v.name]) byName[v.name] = v;
  };
  for (let i = 0; i < allVars.length; i++) index(allVars[i], collName[allVars[i].variableCollectionId]);

  const pending: Pending[] = [];
  for (let c = 0; c < specs.length; c++) {
    const spec = specs[c];
    let collection: VariableCollection | null = null;
    for (let i = 0; i < allCollections.length; i++) if (allCollections[i].name === spec.name) collection = allCollections[i];
    const fresh = !collection;
    if (!collection) {
      collection = figma.variables.createVariableCollection(String(spec.name));
      counts.collections.created++;
    } else {
      counts.collections.updated++;
    }
    const modeIds = ensureModes(collection, spec.modes || [], fresh, counts, warnings);

    const existing: { [name: string]: Variable } = {};
    for (let i = 0; i < allVars.length; i++) if (allVars[i].variableCollectionId === collection.id) existing[allVars[i].name] = allVars[i];
    const vars: any[] = spec.variables || [];
    for (let i = 0; i < vars.length; i++) {
      const v = vars[i];
      const item: Pending = { variable: existing[v.name] || null, spec: v, collection: collection, modeIds: modeIds };
      if (item.variable && v.type && TYPES[v.type] && item.variable.resolvedType !== TYPES[v.type]) {
        warnings.push('"' + v.name + '" exists as ' + item.variable.resolvedType + ", cannot change it to " + TYPES[v.type] + ": skipped");
        continue;
      }
      pending.push(item);
    }
  }

  // Create typed variables first, then alias-only ones whose type comes from their target.
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      if (item.variable) continue;
      const type = item.spec.type ? TYPES[item.spec.type] : aliasTargetType(item.spec, item.collection.name, byName);
      if (!type) continue;
      item.variable = figma.variables.createVariable(String(item.spec.name), item.collection, type);
      index(item.variable, item.collection.name);
      counts.variables.created++;
      item.spec.created = true;
    }
  }

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const v = item.variable;
    if (!v) {
      warnings.push('"' + item.spec.name + '": alias target not found, skipped');
      continue;
    }
    if (!item.spec.created) counts.variables.updated++;
    if (item.spec.description !== undefined) v.description = String(item.spec.description);
    if (Array.isArray(item.spec.scopes)) {
      try {
        v.scopes = item.spec.scopes;
      } catch (e) {
        warnings.push('"' + v.name + '": invalid scopes (' + ((e as Error).message || e) + ")");
      }
    }
    const values = item.spec.values || {};
    const modes = Object.keys(values);
    for (let m = 0; m < modes.length; m++) {
      const targets: string[] = [];
      if (modes[m] === "*") {
        for (let k = 0; k < item.collection.modes.length; k++) targets.push(item.collection.modes[k].modeId);
      } else if (item.modeIds[modes[m]]) {
        targets.push(item.modeIds[modes[m]]);
      } else {
        warnings.push('"' + v.name + '": unknown mode "' + modes[m] + '"');
        continue;
      }
      let value: VariableValue;
      try {
        value = toVariableValue(values[modes[m]], v, item.collection.name, byName);
      } catch (e) {
        warnings.push('"' + v.name + '": ' + ((e as Error).message || e));
        continue;
      }
      for (let k = 0; k < targets.length; k++) {
        try {
          v.setValueForMode(targets[k], value);
        } catch (e) {
          warnings.push('"' + v.name + '": ' + ((e as Error).message || e));
        }
      }
    }
  }
}

function ensureModes(collection: VariableCollection, names: string[], fresh: boolean, counts: any, warnings: string[]) {
  const ids: { [name: string]: string } = {};
  if (fresh && names.length) {
    collection.renameMode(collection.modes[0].modeId, String(names[0]));
    counts.modes.created++;
  }
  for (let i = 0; i < collection.modes.length; i++) ids[collection.modes[i].name] = collection.modes[i].modeId;
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i]);
    if (ids[name]) continue;
    try {
      ids[name] = collection.addMode(name);
      counts.modes.created++;
    } catch (e) {
      warnings.push('Cannot add mode "' + name + '" to "' + collection.name + '": ' + ((e as Error).message || e) + " (the Figma plan may limit modes)");
    }
  }
  return ids;
}

function findAlias(ref: string, collectionName: string, byName: { [n: string]: Variable }): Variable | null {
  return byName[collectionName + "/" + ref] || byName[ref] || null;
}

function aliasTargetType(spec: any, collectionName: string, byName: { [n: string]: Variable }): VariableResolvedDataType | null {
  const values = spec.values || {};
  const keys = Object.keys(values);
  for (let i = 0; i < keys.length; i++) {
    const v = values[keys[i]];
    if (v && typeof v === "object" && v.alias) {
      const target = findAlias(String(v.alias), collectionName, byName);
      if (target) return target.resolvedType;
    }
  }
  return null;
}

function toVariableValue(raw: any, v: Variable, collectionName: string, byName: { [n: string]: Variable }): VariableValue {
  if (raw && typeof raw === "object" && raw.alias) {
    const target = findAlias(String(raw.alias), collectionName, byName);
    if (!target) throw new Error('alias target "' + raw.alias + '" not found');
    if (target.id === v.id) throw new Error("a variable cannot alias itself");
    return figma.variables.createVariableAlias(target);
  }
  switch (v.resolvedType) {
    case "COLOR":
      return parseHex(String(raw));
    case "FLOAT":
      if (typeof raw !== "number" && isNaN(Number(raw))) throw new Error("expected a number, got " + JSON.stringify(raw));
      return Number(raw);
    case "BOOLEAN":
      return raw === true || raw === "true";
    default:
      return String(raw);
  }
}

// ─── Styles ─────────────────────────────────────────────────────────────────

async function writeStyles(styles: any, counts: any, warnings: string[]) {
  const local = await localStyles();
  const find = function (list: BaseStyle[], name: string): any {
    for (let i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
  };

  const colors: any[] = styles.colors || [];
  for (let i = 0; i < colors.length; i++) {
    const s = colors[i];
    try {
      const value = s.value !== undefined ? s.value : s.color;
      const list = Array.isArray(value) ? value : [value];
      const paints: Paint[] = [];
      for (let k = 0; k < list.length; k++) paints.push(await toPaint(list[k]));
      let style: PaintStyle = find(local.paint, s.name);
      if (style) counts.paintStyles.updated++;
      else {
        style = figma.createPaintStyle();
        style.name = String(s.name);
        counts.paintStyles.created++;
      }
      style.paints = paints;
      if (s.description !== undefined) style.description = String(s.description);
    } catch (e) {
      warnings.push('Color style "' + s.name + '": ' + ((e as Error).message || e));
    }
  }

  const texts: any[] = styles.text || [];
  for (let i = 0; i < texts.length; i++) {
    const s = texts[i];
    try {
      const font = await loadWithFallback(parseFont(s.font || "Inter", s.weight), warnings);
      let style: TextStyle = find(local.text, s.name);
      if (style) counts.textStyles.updated++;
      else {
        style = figma.createTextStyle();
        style.name = String(s.name);
        counts.textStyles.created++;
      }
      style.fontName = font;
      if (typeof s.size === "number") style.fontSize = s.size;
      if (s.lineHeight !== undefined && s.lineHeight !== null) style.lineHeight = lineHeight(s.lineHeight);
      if (s.letterSpacing !== undefined && s.letterSpacing !== null) {
        const ls = String(s.letterSpacing);
        style.letterSpacing = /%$/.test(ls) ? { value: parseFloat(ls), unit: "PERCENT" } : { value: Number(s.letterSpacing), unit: "PIXELS" };
      }
      if (typeof s.paragraphSpacing === "number") style.paragraphSpacing = s.paragraphSpacing;
      const cases: any = { upper: "UPPER", lower: "LOWER", title: "TITLE", none: "ORIGINAL" };
      if (s.case && cases[s.case]) style.textCase = cases[s.case];
      const deco: any = { underline: "UNDERLINE", strike: "STRIKETHROUGH", strikethrough: "STRIKETHROUGH", none: "NONE" };
      if (s.decoration && deco[s.decoration]) style.textDecoration = deco[s.decoration];
      if (s.description !== undefined) style.description = String(s.description);
    } catch (e) {
      warnings.push('Text style "' + s.name + '": ' + ((e as Error).message || e));
    }
  }

  const effects: any[] = styles.effects || [];
  for (let i = 0; i < effects.length; i++) {
    const s = effects[i];
    try {
      const value = s.value !== undefined ? s.value : s;
      const list: any[] = Array.isArray(value) ? value : [value];
      const out: Effect[] = [];
      for (let k = 0; k < list.length; k++) {
        const e = list[k];
        if (e && typeof e.blur === "number" && e.type === "layer") out.push({ type: "LAYER_BLUR", radius: e.blur, visible: true } as Effect);
        else if (e && typeof e.blur === "number" && e.type === "background") out.push({ type: "BACKGROUND_BLUR", radius: e.blur, visible: true } as Effect);
        else out.push(shadowEffect(e || {}));
      }
      let style: EffectStyle = find(local.effect, s.name);
      if (style) counts.effectStyles.updated++;
      else {
        style = figma.createEffectStyle();
        style.name = String(s.name);
        counts.effectStyles.created++;
      }
      style.effects = out;
      if (s.description !== undefined) style.description = String(s.description);
    } catch (e) {
      warnings.push('Effect style "' + s.name + '": ' + ((e as Error).message || e));
    }
  }
}

async function loadWithFallback(f: FontName, warnings: string[]): Promise<FontName> {
  const candidates: FontName[] = [f, { family: f.family, style: "Regular" }, { family: "Inter", style: "Regular" }];
  for (let i = 0; i < candidates.length; i++) {
    try {
      await loadFont(candidates[i]);
      if (i > 0) warnings.push('Font "' + f.family + " " + f.style + '" unavailable, used "' + candidates[i].family + " " + candidates[i].style + '"');
      return candidates[i];
    } catch (e) {}
  }
  throw codeError('No usable font for "' + f.family + " " + f.style + '"', "FONT");
}

// ─── Modes on frames (build `modes`) ────────────────────────────────────────

/** Applies {"Collection": "Mode"} to a frame, component or instance. */
export async function applyModes(node: any, modes: any, warnings: string[], path: string) {
  if (!modes || typeof modes !== "object" || typeof node.setExplicitVariableModeForCollection !== "function") return;
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const names = Object.keys(modes);
  for (let i = 0; i < names.length; i++) {
    let collection: VariableCollection | null = null;
    for (let k = 0; k < collections.length; k++) if (collections[k].name === names[i] || collections[k].id === names[i]) collection = collections[k];
    if (!collection) {
      warnings.push(path + ': no variable collection named "' + names[i] + '"');
      continue;
    }
    let modeId = "";
    for (let k = 0; k < collection.modes.length; k++) if (collection.modes[k].name === modes[names[i]]) modeId = collection.modes[k].modeId;
    if (!modeId) {
      warnings.push(path + ': collection "' + collection.name + '" has no mode "' + modes[names[i]] + '"');
      continue;
    }
    node.setExplicitVariableModeForCollection(collection, modeId);
  }
}

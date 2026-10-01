// Lists the file's reusable design tokens: styles, variables and components.
import { localComponents, localStyles, localVariables, pageOf, round, toHex } from "./util";

const ALL = ["colors", "text", "effects", "variables", "components"];

export async function getDesignSystem(p: any) {
  const include: string[] = Array.isArray(p.include) && p.include.length ? p.include : ALL;
  const limit = Math.max(1, Math.min(2000, p.limit || 300));
  const out: any = {};
  const counts: any = {};

  if (include.indexOf("colors") !== -1 || include.indexOf("text") !== -1 || include.indexOf("effects") !== -1) {
    const styles = await localStyles();
    if (include.indexOf("colors") !== -1) {
      counts.colors = styles.paint.length;
      out.colors = styles.paint.slice(0, limit).map(function (s) {
        return { name: s.name, value: paintValue(s.paints) };
      });
    }
    if (include.indexOf("text") !== -1) {
      counts.text = styles.text.length;
      out.text = styles.text.slice(0, limit).map(function (s) {
        const lh = s.lineHeight;
        return {
          name: s.name,
          font: s.fontName.family + ":" + s.fontName.style,
          size: round(s.fontSize),
          lineHeight: lh.unit === "AUTO" ? "auto" : round(lh.value) + (lh.unit === "PERCENT" ? "%" : "px"),
          letterSpacing: s.letterSpacing.value ? round(s.letterSpacing.value) + (s.letterSpacing.unit === "PERCENT" ? "%" : "px") : undefined,
        };
      });
    }
    if (include.indexOf("effects") !== -1) {
      counts.effects = styles.effect.length;
      out.effects = styles.effect.slice(0, limit).map(function (s) {
        return {
          name: s.name,
          effects: s.effects.map(function (e: any) {
            return e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"
              ? e.type.toLowerCase() + " " + e.offset.x + "," + e.offset.y + " blur " + e.radius + " " + toHex(e.color)
              : e.type.toLowerCase() + " " + e.radius;
          }),
        };
      });
    }
  }

  if (include.indexOf("variables") !== -1) {
    const v = await localVariables();
    const byId: { [id: string]: Variable } = {};
    for (let i = 0; i < v.vars.length; i++) byId[v.vars[i].id] = v.vars[i];
    counts.variables = v.vars.length;
    out.variables = v.collections.map(function (c) {
      const defaultMode = c.defaultModeId;
      const vars = v.vars
        .filter(function (x) {
          return x.variableCollectionId === c.id;
        })
        .slice(0, limit)
        .map(function (x) {
          return { name: x.name, type: x.resolvedType.toLowerCase(), value: variableValue(x.valuesByMode[defaultMode], byId) };
        });
      return {
        collection: c.name,
        modes: c.modes.map(function (m) {
          return m.name;
        }),
        variables: vars,
      };
    });
  }

  if (include.indexOf("components") !== -1) {
    const list = await localComponents();
    counts.components = list.length;
    out.components = list.slice(0, limit).map(function (c) {
      const item: any = { name: c.name, id: c.id, page: (pageOf(c) || { name: "?" }).name };
      if (c.type === "COMPONENT_SET") {
        const defs = c.componentPropertyDefinitions;
        const props: any = {};
        const keys = Object.keys(defs);
        for (let i = 0; i < keys.length; i++) {
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
          for (let i = 0; i < keys.length; i++) item.props[keys[i].split("#")[0]] = defs[keys[i]].type.toLowerCase();
        }
      }
      if (c.description) item.description = c.description.slice(0, 120);
      item.key = c.key;
      return item;
    });
  }

  out.counts = counts;
  out.usage =
    'In build specs: fill:"style:<color name>", textStyle:"style:<text name>", shadow:"style:<effect name>", ' +
    'fill:"var:<variable>", gap/padding/radius:"var:<number variable>", {type:"instance", component:"<component name>", props:{...}}.';
  return out;
}

function paintValue(paints: readonly Paint[]): string {
  if (!paints.length) return "none";
  const p: any = paints[0];
  if (p.type === "SOLID") return toHex(p.color, p.opacity);
  if (p.type.indexOf("GRADIENT") === 0) {
    return (
      p.type.replace("GRADIENT_", "").toLowerCase() +
      "-gradient(" +
      p.gradientStops
        .map(function (s: ColorStop) {
          return toHex(s.color);
        })
        .join(",") +
      ")"
    );
  }
  return p.type.toLowerCase();
}

function variableValue(v: any, byId: { [id: string]: Variable }): any {
  if (v && typeof v === "object") {
    if (v.type === "VARIABLE_ALIAS") return "→ " + (byId[v.id] ? byId[v.id].name : v.id);
    if ("r" in v) return toHex(v);
  }
  return v;
}

// Prototype links (reactions) between frames, and flow starting points.
import { codeError, getNode } from "./util";

const TRIGGERS: { [k: string]: string } = {
  click: "ON_CLICK",
  tap: "ON_CLICK",
  hover: "ON_HOVER",
  press: "ON_PRESS",
  drag: "ON_DRAG",
  after: "AFTER_TIMEOUT",
  timeout: "AFTER_TIMEOUT",
  "mouse-enter": "MOUSE_ENTER",
  "mouse-leave": "MOUSE_LEAVE",
  "mouse-down": "MOUSE_DOWN",
  "mouse-up": "MOUSE_UP",
};

const NAVIGATION: { [k: string]: Navigation } = {
  navigate: "NAVIGATE",
  overlay: "OVERLAY",
  swap: "SWAP",
  "swap-overlay": "SWAP",
  scroll: "SCROLL_TO",
  "scroll-to": "SCROLL_TO",
  "change-to": "CHANGE_TO",
};

const EASINGS: { [k: string]: string } = {
  linear: "LINEAR",
  "ease-in": "EASE_IN",
  "ease-out": "EASE_OUT",
  "ease-in-out": "EASE_IN_AND_OUT",
  "ease-in-back": "EASE_IN_BACK",
  "ease-out-back": "EASE_OUT_BACK",
  "ease-in-out-back": "EASE_IN_AND_OUT_BACK",
  gentle: "GENTLE",
  quick: "QUICK",
  bouncy: "BOUNCY",
  slow: "SLOW",
};

const DIRECTIONAL: { [k: string]: string } = {
  "move-in": "MOVE_IN",
  "move-out": "MOVE_OUT",
  push: "PUSH",
  slide: "SLIDE_IN",
  "slide-in": "SLIDE_IN",
  "slide-out": "SLIDE_OUT",
};

const key = function (v: any) {
  return String(v || "")
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
};

/** "smart" | "dissolve" | "slide-in" (+ direction) | "push-left" | "instant" → Figma transition. */
function transition(spec: any): Transition | null {
  let t = key(spec.transition || "instant");
  if (t === "instant" || t === "none") return null;
  let direction = key(spec.direction || "left");
  const m = /^(.*)-(left|right|top|bottom|up|down)$/.exec(t);
  if (m && DIRECTIONAL[m[1]]) {
    t = m[1];
    direction = m[2];
  }
  direction = direction === "up" ? "top" : direction === "down" ? "bottom" : direction;
  let ms = typeof spec.duration === "number" ? spec.duration : 300;
  if (ms <= 10) ms = ms * 1000; // seconds given
  const easing = { type: EASINGS[key(spec.easing || "ease-out")] || "EASE_OUT" } as Easing;
  const duration = ms / 1000;
  if (t === "dissolve" || t === "fade") return { type: "DISSOLVE", easing: easing, duration: duration };
  if (t === "smart" || t === "smart-animate") return { type: "SMART_ANIMATE", easing: easing, duration: duration };
  if (DIRECTIONAL[t]) {
    return {
      type: DIRECTIONAL[t],
      direction: direction.toUpperCase(),
      matchLayers: !!spec.matchLayers,
      easing: easing,
      duration: duration,
    } as DirectionalTransition;
  }
  throw codeError('Unknown transition "' + spec.transition + '" (instant, dissolve, smart, move-in, move-out, push, slide-in, slide-out)', "BAD_ARGS");
}

function trigger(spec: any): Trigger {
  const t = TRIGGERS[key(spec.trigger || "click")];
  if (!t) throw codeError('Unknown trigger "' + spec.trigger + '" (click, hover, press, drag, after, mouse-enter, mouse-leave)', "BAD_ARGS");
  if (t === "AFTER_TIMEOUT") return { type: t, timeout: (typeof spec.delay === "number" ? spec.delay : 800) / 1000 } as Trigger;
  if (t === "MOUSE_ENTER" || t === "MOUSE_LEAVE") return { type: t, delay: (spec.delay || 0) / 1000, deprecatedVersion: false } as Trigger;
  if (t === "MOUSE_DOWN" || t === "MOUSE_UP") return { type: t, delay: (spec.delay || 0) / 1000 } as Trigger;
  return { type: t } as Trigger;
}

/** {trigger, action, to, transition, duration, easing, direction, url} → Reaction. `resolve` maps `to` to a node id. */
export async function toReaction(spec: any, resolve: (ref: string) => Promise<string>): Promise<Reaction> {
  const action = key(spec.action || (spec.url ? "url" : spec.to ? "navigate" : "back"));
  let act: Action;
  if (action === "back") act = { type: "BACK" };
  else if (action === "close") act = { type: "CLOSE" };
  else if (action === "url" || action === "open-url") act = { type: "URL", url: String(spec.url) };
  else if (NAVIGATION[action]) {
    if (!spec.to) throw codeError('Action "' + action + '" needs `to` (a frame name or id)', "BAD_ARGS");
    act = { type: "NODE", destinationId: await resolve(String(spec.to)), navigation: NAVIGATION[action], transition: transition(spec), preserveScrollPosition: !!spec.preserveScroll };
  } else {
    throw codeError('Unknown action "' + spec.action + '" (navigate, overlay, swap, scroll-to, change-to, back, close, url)', "BAD_ARGS");
  }
  return { trigger: trigger(spec), actions: [act] };
}

/** Finds a destination by id, or by name among top-level frames then anywhere on the page. */
export async function resolveFrame(ref: string): Promise<string> {
  if (/^[\dI;:]+$/.test(ref)) return (await getNode(ref)).id;
  const top = figma.currentPage.children;
  for (let i = 0; i < top.length; i++) if (top[i].name === ref) return top[i].id;
  const any = figma.currentPage.findOne(function (n) {
    return n.name === ref;
  });
  if (!any) throw codeError('No frame named "' + ref + '" on this page', "NOT_FOUND");
  return any.id;
}

async function setReactions(node: any, reactions: Reaction[], replace: boolean) {
  if (typeof node.setReactionsAsync !== "function") throw codeError("A " + node.type + " node cannot have prototype interactions", "BAD_ARGS");
  const current: Reaction[] = replace ? [] : (node.reactions || []).slice();
  await node.setReactionsAsync(current.concat(reactions));
}

/** Applies build `reactions` once every layer of the build exists (destinations may be siblings). */
export async function applyBuildReactions(pending: { node: SceneNode; reactions: any; path: string }[], ids: { [name: string]: string }, warnings: string[]) {
  const resolve = function (ref: string) {
    return ids[ref] ? Promise.resolve(ids[ref]) : resolveFrame(ref);
  };
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const list: any[] = Array.isArray(item.reactions) ? item.reactions : [item.reactions];
    const out: Reaction[] = [];
    for (let k = 0; k < list.length; k++) {
      try {
        out.push(await toReaction(list[k] || {}, resolve));
      } catch (e) {
        warnings.push(item.path + ".reactions[" + k + "]: " + ((e as Error).message || e));
      }
    }
    try {
      if (out.length) await setReactions(item.node, out, false);
    } catch (e) {
      warnings.push(item.path + ".reactions: " + ((e as Error).message || e));
    }
  }
}

export async function prototype(p: any) {
  const links: any[] = Array.isArray(p.links) ? p.links : [];
  const flows: any[] = Array.isArray(p.flows) ? p.flows : [];
  const clear: string[] = Array.isArray(p.clear) ? p.clear : [];
  const out: any = {};

  for (let i = 0; i < clear.length; i++) await setReactions(await getNode(clear[i]), [], true);
  if (clear.length) out.cleared = clear.length;

  // Group links by source so each layer gets one setReactionsAsync call.
  const bySource: { [id: string]: Reaction[] } = {};
  const order: string[] = [];
  for (let i = 0; i < links.length; i++) {
    const l = links[i] || {};
    if (!l.from) throw codeError("links[" + i + "]: `from` is required (the layer that reacts)", "BAD_ARGS");
    const from = await resolveFrame(String(l.from));
    let r: Reaction;
    try {
      r = await toReaction(l, resolveFrame);
    } catch (e) {
      throw codeError("links[" + i + "]: " + ((e as Error).message || e), (e as any).code || "BAD_ARGS");
    }
    if (!bySource[from]) {
      bySource[from] = [];
      order.push(from);
    }
    bySource[from].push(r);
  }
  for (let i = 0; i < order.length; i++) await setReactions(await getNode(order[i]), bySource[order[i]], !!p.replace);
  if (links.length) out.linked = links.length;

  if (flows.length) {
    const page = figma.currentPage;
    const points = page.flowStartingPoints.slice();
    for (let i = 0; i < flows.length; i++) {
      const f = flows[i] || {};
      const id = await resolveFrame(String(f.nodeId || f.frame || f.start || ""));
      const node = await getNode(id);
      if (!node.parent || node.parent.type !== "PAGE") throw codeError('Flow start "' + node.name + '" must be a top-level frame', "BAD_ARGS");
      const name = String(f.name || node.name);
      let found = false;
      for (let k = 0; k < points.length; k++) {
        if (points[k].nodeId === id) {
          points[k] = { nodeId: id, name: name };
          found = true;
        }
      }
      if (!found) points.push({ nodeId: id, name: name });
    }
    page.flowStartingPoints = points;
    out.flows = points;
  }

  if (p.list || (!links.length && !flows.length && !clear.length)) out.interactions = await listReactions(p.nodeId);
  return out;
}

async function listReactions(nodeId?: string) {
  const root: any = nodeId ? await getNode(nodeId) : figma.currentPage;
  const nodes: any[] = (root.type === "PAGE" ? [] : [root]).concat(
    "findAll" in root
      ? root.findAll(function (n: any) {
          return n.reactions && n.reactions.length > 0;
        })
      : [],
  );
  const names: { [id: string]: string } = {};
  const out: any[] = [];
  for (let i = 0; i < nodes.length && out.length < 300; i++) {
    const n = nodes[i];
    const reactions: Reaction[] = n.reactions || [];
    for (let k = 0; k < reactions.length; k++) {
      const r: any = reactions[k];
      const actions: any[] = r.actions || (r.action ? [r.action] : []);
      for (let a = 0; a < actions.length; a++) {
        const act = actions[a];
        const item: any = { from: n.id, fromName: n.name, trigger: r.trigger ? r.trigger.type : null, action: act.type };
        if (act.type === "NODE") {
          item.navigation = act.navigation;
          item.to = act.destinationId;
          if (act.destinationId && names[act.destinationId] === undefined) {
            const dest = await figma.getNodeByIdAsync(act.destinationId);
            names[act.destinationId] = dest ? dest.name : "";
          }
          item.toName = names[act.destinationId] || undefined;
          if (act.transition) item.transition = act.transition.type + (act.transition.direction ? " " + act.transition.direction : "") + " " + Math.round(act.transition.duration * 1000) + "ms";
        }
        if (act.type === "URL") item.url = act.url;
        out.push(item);
      }
    }
  }
  return { flows: figma.currentPage.flowStartingPoints, links: out };
}

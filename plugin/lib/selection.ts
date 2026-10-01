// wait_for_selection: the agent asks the user to pick layers, the plugin UI shows a banner.
import { codeError, round } from "./util";

const MAX_WAIT_MS = 120000;

interface Waiter {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: any;
}

const waiters: { [id: string]: Waiter } = {};
let listening = false;

export function selectionSummary() {
  const sel = figma.currentPage.selection;
  return {
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    count: sel.length,
    selection: sel.slice(0, 100).map(function (n) {
      const b = n.absoluteBoundingBox;
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        bounds: b ? { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) } : null,
      };
    }),
  };
}

function onSelectionChange() {
  if (!figma.currentPage.selection.length) return;
  const ids = Object.keys(waiters);
  for (let i = 0; i < ids.length; i++) finish(ids[i], null);
}

function finish(id: string, error: Error | null, timedOut?: boolean) {
  const w = waiters[id];
  if (!w) return;
  delete waiters[id];
  clearTimeout(w.timer);
  figma.ui.postMessage({ t: "waitDone", id: id });
  if (!Object.keys(waiters).length && listening) {
    figma.off("selectionchange", onSelectionChange);
    listening = false;
  }
  if (error) w.reject(error);
  else {
    const out: any = selectionSummary();
    out.timedOut = !!timedOut;
    w.resolve(out);
  }
}

export function waitForSelection(p: any, timeoutMs: number, requestId: string): Promise<any> {
  const ms = Math.max(1000, Math.min(MAX_WAIT_MS, Number(p.timeoutMs) || timeoutMs || 60000));
  const message = String(p.message || "Select one or more layers");
  return new Promise(function (resolve, reject) {
    waiters[requestId] = {
      resolve: resolve,
      reject: reject,
      timer: setTimeout(function () {
        finish(requestId, null, true);
      }, ms),
    };
    if (!listening) {
      figma.on("selectionchange", onSelectionChange);
      listening = true;
    }
    figma.ui.postMessage({ t: "wait", id: requestId, message: message, until: Date.now() + ms });
    figma.notify("Your agent is waiting: " + message, { timeout: 4000 });
  });
}

/** Cancel button of the banner. */
export function cancelWait(id: string) {
  finish(id, codeError("The user cancelled the selection request", "CANCELLED"));
}

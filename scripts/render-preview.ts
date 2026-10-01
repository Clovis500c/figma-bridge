// Renders docs/plugin.png: the plugin UI in light (waiting) and dark (live, with activity), at 3× for a sharp README image.
//   bun run scripts/render-preview.ts
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { launchBrowser } from "../src/web/browser";

const root = join(import.meta.dir, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const ui = readFileSync(join(root, "plugin", "ui.html"), "utf8");

// Demo state injected into each iframe (the real UI code renders it).
const DEMO = `
  setState('connected'); const now = performance.now();
  const data = [
    ['get_design_system','Styles, variables and components',1,140,null],
    ['build','Pricing section · 32 layers',1,410,'12:400'],
    ['audit','Node 12:400',1,62,null],
    ['run_script','for (const n of cards) n.layoutMode = "VERTICAL"',1,3400,null],
    ['screenshot','Node 12:400 · 2×',1,96,'12:400'],
    ['roblox_tree','Shop panel',1,520,'12:410'],
  ];
  data.forEach((x, i) => { entries.unshift({ id: 'e' + i, method: x[0], sum: x[1], start: now, at: Date.now() - (data.length - i) * 50000, status: x[2] ? 'ok' : 'err', ms: x[3], nodeId: x[4], error: '' }); stats.count++; stats.totalMs += x[3]; });
  entries.unshift({ id: 'r', method: 'build', sum: 'Settings screen · 18 layers', start: now, at: Date.now(), status: 'run' });
  running.set('r', entries[0]); render();`;

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent}
  .stage{display:inline-flex;gap:28px;padding:32px;background:#0f0f11;border-radius:24px}
  iframe{border:0;border-radius:12px;background:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.08),0 24px 48px -12px rgba(0,0,0,.6)}
</style></head><body><div class="stage" id="stage">
  <iframe id="a" src="/ui" width="340" height="600"></iframe>
  <iframe id="b" src="/ui" width="340" height="600"></iframe>
</div><script>
  const init = { t: 'init', version: ${JSON.stringify(version)}, session: { id: 'a1b2c3d4e5f6', fileName: 'Acme Design System', page: 'Marketing site' }, settings: { channel: 'default', compact: false } };
  window.ready = Promise.all(['a', 'b'].map((id) => new Promise((done) => {
    const f = document.getElementById(id);
    f.onload = () => {
      const w = f.contentWindow;
      w.document.documentElement.className = id === 'a' ? 'figma-light' : 'figma-dark';
      w.postMessage({ pluginMessage: init }, '*');
      setTimeout(() => {
        w.eval("clearTimeout(retryTimer); if (ws) { ws.onclose = null; ws.close(); ws = null; }");
        w.eval(id === 'a' ? "setState('offline'); retryAt = Date.now() + 3000;" : ${JSON.stringify(DEMO)});
        setTimeout(done, 400);
      }, 300);
    };
  })));
</script></body></html>`;

const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  // The preview must not reach a real bridge: point the UI at a closed port.
  res.end(req.url === "/ui" ? ui.replace("ws://localhost:3055", "ws://localhost:1") : page);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as { port: number }).port;

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ deviceScaleFactor: 3, viewport: { width: 900, height: 760 } });
  const tab = await context.newPage();
  await tab.goto(`http://127.0.0.1:${port}/`);
  await tab.evaluate(() => (window as unknown as { ready: Promise<unknown> }).ready);
  const out = join(root, "docs", "plugin.png");
  await tab.locator("#stage").screenshot({ path: out, omitBackground: true, animations: "disabled" });
  console.log(`Wrote ${out}`);
} finally {
  await browser.close();
  server.close();
}

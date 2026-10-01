// import_web: renders a page in the user's Chrome or Edge with playwright-core (an optional
// dependency loaded on first use, so the server starts fast and nothing is downloaded).
import { pathToFileURL } from "node:url";
import { snapshot, type Snapshot } from "./dom";

export class WebImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface PageSource {
  url?: string;
  html?: string;
  path?: string;
}

export interface Rendered {
  viewport: number;
  snap: Snapshot;
  /** Full-page screenshot (PNG), to compare the import with. */
  screenshot?: Uint8Array;
}

export interface RenderOptions {
  viewports: number[];
  selector?: string;
  maxNodes: number;
  maxHeight: number;
  waitMs: number;
  /** Called while the page is still open: download images, picture what has no URL. */
  withPage: (r: Rendered, tools: PageTools) => Promise<void>;
}

export interface PageTools {
  fetch(url: string): Promise<Uint8Array>;
  picture(box: { x: number; y: number; w: number; h: number }): Promise<Uint8Array>;
}

type Playwright = typeof import("playwright-core");
type Browser = import("playwright-core").Browser;

async function loadPlaywright(): Promise<Playwright> {
  try {
    return await import("playwright-core");
  } catch {
    throw new WebImportError(
      "import_web needs the optional package playwright-core, which is not installed. Reinstall without --no-optional, " +
        "or run `npm install -g playwright-core` (it uses your installed Chrome or Edge; no browser is downloaded).",
      "MISSING_DEPENDENCY",
    );
  }
}

/** FIGMA_BRIDGE_BROWSER (a Chromium-based executable), else Chrome, Edge, then Playwright's own Chromium. */
export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await loadPlaywright();
  const tries: { label: string; opts: Parameters<typeof chromium.launch>[0] }[] = [];
  if (process.env.FIGMA_BRIDGE_BROWSER) tries.push({ label: process.env.FIGMA_BRIDGE_BROWSER, opts: { executablePath: process.env.FIGMA_BRIDGE_BROWSER } });
  tries.push({ label: "Chrome", opts: { channel: "chrome" } }, { label: "Edge", opts: { channel: "msedge" } }, { label: "Playwright Chromium", opts: {} });
  const errors: string[] = [];
  for (const t of tries) {
    try {
      return await chromium.launch({ ...t.opts, headless: true });
    } catch (e) {
      errors.push(`${t.label}: ${String((e as Error).message).split("\n")[0]}`);
    }
  }
  throw new WebImportError(
    `No browser found to render the page. Install Google Chrome or Microsoft Edge, or set FIGMA_BRIDGE_BROWSER to a Chromium-based browser. (${errors.join("; ")})`,
    "NO_BROWSER",
  );
}

export async function render(source: PageSource, opts: RenderOptions): Promise<Rendered[]> {
  const given = [source.url, source.html, source.path].filter((v) => v !== undefined).length;
  if (given !== 1) throw new WebImportError("Give exactly one of url, html or path.", "BAD_ARGS");
  const url = source.url ?? (source.path ? pathToFileURL(source.path).href : undefined);
  if (url && !/^(https?|file):/i.test(url)) throw new WebImportError(`Unsupported URL: ${url}`, "BAD_ARGS");
  const browser = await launchBrowser();
  const out: Rendered[] = [];
  try {
    for (const width of opts.viewports) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
      try {
        const page = await context.newPage();
        if (url) await page.goto(url, { waitUntil: "load", timeout: 45_000 });
        else await page.setContent(source.html!, { waitUntil: "load", timeout: 45_000 });
        await settle(page, opts.waitMs);
        const snap = await page.evaluate(snapshot, { selector: opts.selector, maxNodes: opts.maxNodes, maxHeight: opts.maxHeight });
        let screenshot: Uint8Array | undefined;
        try {
          const clip = { x: 0, y: 0, width: snap.width, height: Math.min(snap.height, 16_000) };
          screenshot = opts.selector ? await page.locator(opts.selector).first().screenshot() : await page.screenshot({ fullPage: true, clip });
        } catch {}
        const r: Rendered = { viewport: width, snap, screenshot };
        await opts.withPage(r, {
          fetch: async (u) => {
            const res = await context.request.get(u, { timeout: 20_000 });
            if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
            return new Uint8Array(await res.body());
          },
          picture: async (b) =>
            new Uint8Array(await page.screenshot({ fullPage: true, clip: { x: b.x, y: b.y, width: Math.max(1, b.w), height: Math.max(1, b.h) }, omitBackground: true })),
        });
        out.push(r);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}

/** Waits for fonts and lazy content: scrolls through the page once, then back to the top. */
async function settle(page: import("playwright-core").Page, waitMs: number) {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await page.evaluate(async () => {
    for (const img of Array.from(document.images)) img.loading = "eager";
    const step = window.innerHeight;
    const end = Math.min(document.documentElement.scrollHeight, 30_000);
    for (let y = 0; y < end; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await document.fonts.ready;
  });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await page.evaluate(() => Promise.all(Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => ((i.onload = r), (i.onerror = r), setTimeout(r, 4000))))));
  if (waitMs) await page.waitForTimeout(waitMs);
}

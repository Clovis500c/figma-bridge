// import_web: website or HTML → one build spec per viewport, with its images resolved.
import { render, type PageSource } from "./browser";
import { convert, type Spec } from "./convert";
import { FontIndex, type FigmaFamily } from "./fonts";

export interface ImportOptions extends PageSource {
  viewports?: number[];
  selector?: string;
  name?: string;
  maxHeight?: number;
  waitMs?: number;
}

export interface ImportedViewport {
  viewport: number;
  title: string;
  spec: Spec;
  /** imageKey → image bytes (PNG, JPG, GIF or WEBP). */
  images: Record<string, Uint8Array>;
  screenshot?: Uint8Array;
  width: number;
  height: number;
  stats: Record<string, number>;
}

export interface ImportResult {
  viewports: ImportedViewport[];
  substitutions: Record<string, string>;
  warnings: string[];
}

export interface ImportDeps {
  fonts: FigmaFamily[];
  /** data:, file: and local paths (the page's own requests handle http). */
  readLocal: (src: string) => Promise<Uint8Array>;
  /** Format of image bytes Figma accepts, or null. */
  imageFormat: (bytes: Uint8Array) => string | null;
}

const BUILD_LIMIT = 2800;

const isSvg = (bytes: Uint8Array) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(bytes.slice(0, 1024)));

export async function importWeb(opts: ImportOptions, deps: ImportDeps): Promise<ImportResult> {
  const fonts = new FontIndex(deps.fonts);
  const viewports = (opts.viewports?.length ? opts.viewports : [1440, 390]).map((v) => Math.round(v));
  const warnings: string[] = [];
  const substitutions: Record<string, string> = {};
  const out: ImportedViewport[] = [];

  await render(opts, {
    viewports,
    selector: opts.selector,
    maxNodes: BUILD_LIMIT * 3,
    maxHeight: opts.maxHeight ?? 12_000,
    waitMs: opts.waitMs ?? 0,
    withPage: async (r, page) => {
      const c = convert(r.snap, { fonts, maxNodes: BUILD_LIMIT, name: opts.name ? `${opts.name} · ${r.viewport}` : undefined });
      Object.assign(substitutions, c.substitutions);
      for (const w of c.warnings) if (!warnings.includes(w)) warnings.push(w);
      const images: Record<string, Uint8Array> = {};
      const svgs: Record<string, string> = {};
      const failed = new Set<string>();
      await Promise.all(
        Object.entries(c.assets).map(async ([key, a]) => {
          let bytes: Uint8Array | null = null;
          if (a.url) {
            try {
              bytes = /^https?:/i.test(a.url) ? await page.fetch(a.url) : await deps.readLocal(a.url);
            } catch (e) {
              warnings.push(`Image ${a.url.slice(0, 80)}: ${(e as Error).message}`);
            }
          }
          if (bytes && isSvg(bytes) && a.layer) {
            svgs[key] = new TextDecoder().decode(bytes);
            return;
          }
          if (bytes && deps.imageFormat(bytes)) {
            images[key] = bytes;
            return;
          }
          // No usable file (canvas, video, AVIF, SVG background…): picture it from the page instead.
          if (a.layer) {
            try {
              images[key] = await page.picture(a.box, a.ref);
              return;
            } catch {}
          }
          failed.add(key);
        }),
      );
      patch(c.spec, svgs, failed);
      if (failed.size) warnings.push(`${failed.size} background image(s) could not be imported (unsupported format or download failed).`);
      out.push({ viewport: r.viewport, title: r.snap.title, spec: c.spec, images, screenshot: r.screenshot, width: r.snap.width, height: r.snap.height, stats: c.stats });
    },
  });
  return { viewports: out, substitutions, warnings };
}

/** SVG files become vector layers; paints whose image failed are dropped. */
function patch(spec: Spec, svgs: Record<string, string>, failed: Set<string>) {
  if (spec.type === "image" && svgs[spec.imageKey]) {
    spec.type = "svg";
    spec.svg = svgs[spec.imageKey];
    delete spec.imageKey;
    delete spec.fit;
  }
  if (spec.type === "image" && failed.has(spec.imageKey)) {
    spec.type = "rect";
    spec.fill = "#E5E7EB";
    delete spec.imageKey;
  }
  if (Array.isArray(spec.fill)) {
    spec.fill = spec.fill.filter((p: any) => !(p && failed.has(p.imageKey)));
    if (!spec.fill.length) delete spec.fill;
  } else if (spec.fill && typeof spec.fill === "object" && failed.has(spec.fill.imageKey)) delete spec.fill;
  for (const c of spec.children ?? []) patch(c, svgs, failed);
}

// export_roblox: a Figma frame → .rbxmx model + Luau builder script + PNG assets (uploaded or not).
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { imageInfo } from "../image";
import { type AssetRef, imageHashes, mapToRoblox, pictureRequests, type RNode, type RobloxOptions } from "./map";
import { substituteAssets, toLuau, toRbxmx } from "./output";
import { RobloxUploader, UPLOAD_HELP } from "./upload";

export interface ExportRobloxArgs extends Partial<RobloxOptions> {
  nodeId?: string;
  outDir?: string;
  upload?: boolean;
  /** Luau expression for the parent of the UI (default: StarterGui). */
  parent?: string;
}

export interface ExportRobloxDeps {
  request: <T>(method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<T>;
  outDir: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

export interface RobloxAsset {
  placeholder: string;
  assetId?: string;
  file: string;
  nodeId: string;
  layer: string;
  kind: "picture" | "image";
  mode?: string;
  cached?: boolean;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "ui";

export async function exportRoblox(args: ExportRobloxArgs, deps: ExportRobloxDeps) {
  const env = deps.env ?? process.env;
  const opts: RobloxOptions = {
    mode: args.mode ?? "scale",
    targetResolution: args.targetResolution ?? [1920, 1080],
    rasterize: args.rasterize ?? "auto",
    asRootFrame: args.asRootFrame,
    textScaled: args.textScaled,
    fonts: args.fonts,
    scale: 2,
  };
  const t = await deps.request<{ tree: RNode; images: Record<string, string>; nodes: number; truncated: boolean; fileName: string }>("roblox_tree", { nodeId: args.nodeId }, 120_000);
  const warnings: string[] = [];
  if (t.truncated) warnings.push(`Stopped after ${t.nodes} layers: export a smaller frame for the rest.`);

  // Pictures of what Roblox can't draw, taken by the plugin at 2×, 20 per call.
  const wanted = pictureRequests(t.tree, opts);
  const pictures = new Map<string, { b64: string; offset: { x: number; y: number }; size: { w: number; h: number } }>();
  for (let i = 0; i < wanted.length; i += 20) {
    const r = await deps.request<{ images: { id: string; mode: string; b64?: string; error?: string; offset: { x: number; y: number }; size: { w: number; h: number } }[] }>(
      "roblox_images",
      { items: wanted.slice(i, i + 20).map((w) => ({ ...w, scale: opts.scale })) },
      120_000,
    );
    for (const img of r.images) {
      if (img.b64) pictures.set(`${img.id}:${img.mode}`, { b64: img.b64, offset: img.offset, size: img.size });
      else warnings.push(`Picture of ${img.id} failed: ${img.error}`);
    }
  }

  // Every asset gets a placeholder id until it is uploaded.
  const assets: RobloxAsset[] = [];
  const files = new Map<string, Uint8Array>();
  const refs = new Map<string, AssetRef>();
  const names = new Map<string, string>();
  const layerNames = (n: RNode) => {
    names.set(n.id, n.name);
    for (const c of n.children ?? []) layerNames(c);
  };
  layerNames(t.tree);
  const add = (key: string, bytes: Uint8Array, a: Omit<RobloxAsset, "placeholder" | "file">, ext: string, ref: Omit<AssetRef, "url">) => {
    const placeholder = `rbxassetid://PENDING_${assets.length + 1}`;
    const file = `${String(assets.length + 1).padStart(2, "0")}-${safe(a.layer)}${a.mode && a.mode !== "full" ? `-${a.mode}` : ""}.${ext}`;
    assets.push({ placeholder, file, ...a });
    files.set(file, bytes);
    refs.set(key, { url: placeholder, ...ref });
  };
  for (const w of wanted) {
    const p = pictures.get(`${w.id}:${w.mode}`);
    if (!p) continue;
    add(`${w.id}:${w.mode}`, new Uint8Array(Buffer.from(p.b64, "base64")), { nodeId: w.id, layer: names.get(w.id) ?? w.id, kind: "picture", mode: w.mode }, "png", { offset: p.offset, size: p.size });
  }
  for (const hash of imageHashes(t.tree)) {
    const b64 = t.images[hash];
    if (!b64) continue;
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    const info = imageInfo(bytes);
    if (info && info.format !== "png" && info.format !== "jpeg") warnings.push(`An image is ${info.format.toUpperCase()}: Roblox takes PNG, JPG, BMP or TGA, convert it before uploading.`);
    const owner = findImageOwner(t.tree, hash);
    add(`image:${hash}`, bytes, { nodeId: owner?.id ?? "", layer: owner?.name ?? "image", kind: "image" }, info?.format === "jpeg" ? "jpg" : info?.format ?? "png", {});
  }

  const mapped = mapToRoblox(t.tree, opts, (key) => refs.get(key));
  warnings.push(...mapped.warnings);
  let rbxmx = toRbxmx(mapped.root);
  let luau = toLuau(mapped.root, { parent: args.parent, source: `${t.tree.name}" in "${t.fileName}` });

  // Upload with Open Cloud when asked and configured; otherwise the agent uploads them with its Roblox tools.
  let uploaded = false;
  if (args.upload) {
    if (!env.ROBLOX_API_KEY || !env.ROBLOX_CREATOR_ID) warnings.push(`upload skipped: ROBLOX_API_KEY and ROBLOX_CREATOR_ID are not set. ${UPLOAD_HELP}`);
    else if (assets.length) {
      const uploader = new RobloxUploader({
        apiKey: env.ROBLOX_API_KEY,
        creatorId: env.ROBLOX_CREATOR_ID,
        cacheFile: join(env.FIGMA_BRIDGE_HOME ?? join(homedir(), ".figma-bridge"), "roblox-assets.json"),
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      });
      const ids: Record<string, string> = {};
      for (const a of assets) {
        const r = await uploader.upload(files.get(a.file)!, `${a.layer}${a.mode && a.mode !== "full" ? ` ${a.mode}` : ""}`);
        a.assetId = r.assetId;
        a.cached = r.cached;
        ids[a.placeholder] = r.assetId;
      }
      rbxmx = substituteAssets(rbxmx, ids);
      luau = substituteAssets(luau, ids);
      uploaded = true;
    }
  }

  const dir = args.outDir ?? join(deps.outDir, `roblox-${safe(t.tree.name)}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const base = safe(mapped.root.name);
  writeFileSync(join(dir, `${base}.rbxmx`), rbxmx);
  writeFileSync(join(dir, `${base}.luau`), luau);
  for (const [file, bytes] of files) writeFileSync(join(dir, file), bytes);
  writeFileSync(join(dir, "assets.json"), JSON.stringify(assets, null, 2));

  const pending = assets.filter((a) => !a.assetId);
  const next = pending.length
    ? `Upload the ${pending.length} picture(s) in ${dir} (assets[].file) with your Roblox Studio tools (e.g. upload_image), replace each placeholder (rbxassetid://PENDING_n) in the Luau with the returned id, run it with execute_luau, then check it with a Studio screenshot. Or set ROBLOX_API_KEY and ROBLOX_CREATOR_ID and call export_roblox with upload:true.`
    : "Run the Luau with execute_luau (it replaces a previous copy and returns the root), or insert the .rbxmx in Studio, then check it with a Studio screenshot.";
  return {
    result: {
      root: mapped.root.name,
      dir,
      rbxmx: join(dir, `${base}.rbxmx`),
      luau: join(dir, `${base}.luau`),
      assets: assets.map((a) => ({ ...a, file: join(dir, a.file) })),
      uploaded,
      instances: mapped.counts.instances,
      layers: t.nodes,
      options: { mode: opts.mode, targetResolution: opts.targetResolution, rasterize: opts.rasterize },
      ...(Object.keys(mapped.fontSubstitutions).length ? { fontSubstitutions: mapped.fontSubstitutions } : {}),
      ...(warnings.length ? { warnings: warnings.slice(0, 60) } : {}),
      next,
    },
    luau,
    rbxmx,
  };
}

function findImageOwner(n: RNode, hash: string): RNode | null {
  if ((n.fills ?? []).some((f) => f.imageHash === hash)) return n;
  for (const c of n.children ?? []) {
    const hit = findImageOwner(c, hash);
    if (hit) return hit;
  }
  return null;
}

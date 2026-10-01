// export_roblox upload: images to Roblox through the Open Cloud Assets API, cached by content hash so the
// same picture is never uploaded twice. Uploaded as "Image" assets: their ids work directly in ImageLabel.Image
// (a Decal upload would give a decal id, which Image can't use).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class RobloxUploadError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export const UPLOAD_HELP =
  "To upload pictures automatically, create an Open Cloud API key at create.roblox.com → Open Cloud → API Keys with the " +
  "Assets API (Read and Write) and your experience's creator, then set ROBLOX_API_KEY and ROBLOX_CREATOR_ID (your user id, " +
  'or "group:<id>") in the Figma Bridge env of your AI client, and call export_roblox with upload:true.';

/** "123", "user:123" or "group:456" → the creator object of the API. */
export function creatorFrom(id: string): { userId: string } | { groupId: string } {
  const m = /^(?:(user|group)[:/])?\s*(\d+)$/i.exec(id.trim());
  if (!m) throw new RobloxUploadError(`ROBLOX_CREATOR_ID must be a user id, "user:<id>" or "group:<id>", not "${id}".`, "BAD_CREATOR");
  return m[1]?.toLowerCase() === "group" ? { groupId: m[2]! } : { userId: m[2]! };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface UploadOptions {
  apiKey: string;
  creatorId: string;
  cacheFile: string;
  fetchImpl?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  base?: string;
}

export class RobloxUploader {
  private cache: Record<string, string> = {};
  private fetchImpl: Fetch;
  private sleep: (ms: number) => Promise<void>;
  private base: string;

  constructor(private opts: UploadOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.base = opts.base ?? process.env.ROBLOX_API_URL ?? "https://apis.roblox.com";
    try {
      this.cache = JSON.parse(readFileSync(opts.cacheFile, "utf8"));
    } catch {}
  }

  static hash(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex");
  }

  private async request(url: string, init: RequestInit): Promise<any> {
    let delay = 1000;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), "x-api-key": this.opts.apiKey }, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return res.json();
      const retryAfter = Number(res.headers.get("retry-after"));
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await this.sleep(retryAfter > 0 ? retryAfter * 1000 : delay);
        delay *= 2;
        continue;
      }
      let detail = "";
      try {
        const body = (await res.json()) as { message?: string; errors?: { message?: string }[] };
        detail = body.message ?? body.errors?.[0]?.message ?? "";
      } catch {}
      if (res.status === 401 || res.status === 403) throw new RobloxUploadError(`Roblox refused the API key (${res.status}${detail ? `: ${detail}` : ""}). It needs the Assets API with Read and Write, for this creator.`, "FORBIDDEN");
      throw new RobloxUploadError(`Roblox Open Cloud error ${res.status}${detail ? `: ${detail}` : ""}`, "UPLOAD_FAILED");
    }
  }

  /** Uploads a PNG (or returns the cached id) and waits for its asset id. */
  async upload(bytes: Uint8Array, name: string): Promise<{ assetId: string; cached: boolean }> {
    const hash = RobloxUploader.hash(bytes);
    if (this.cache[hash]) return { assetId: this.cache[hash]!, cached: true };
    const form = new FormData();
    form.append(
      "request",
      JSON.stringify({
        assetType: "Image",
        displayName: name.slice(0, 50) || "Figma Bridge image",
        description: "Uploaded by Figma Bridge (export_roblox)",
        creationContext: { creator: creatorFrom(this.opts.creatorId) },
      }),
    );
    form.append("fileContent", new Blob([new Uint8Array(bytes)], { type: "image/png" }), `${name.replace(/[^\w.-]+/g, "_") || "image"}.png`);
    let op = await this.request(`${this.base}/assets/v1/assets`, { method: "POST", body: form });
    // The upload is an operation: poll it until it is done.
    for (let i = 0; !op.done; i++) {
      if (i >= 20) throw new RobloxUploadError(`Roblox is still processing "${name}": try again in a minute.`, "UPLOAD_PENDING");
      await this.sleep(Math.min(500 * 2 ** i, 4000));
      const id = String(op.operationId ?? op.path ?? "").replace(/^operations\//, "");
      if (!id) throw new RobloxUploadError("Roblox returned no operation to wait for.", "UPLOAD_FAILED");
      op = await this.request(`${this.base}/assets/v1/operations/${id}`, { method: "GET" });
    }
    const assetId = String(op.response?.assetId ?? "");
    if (!assetId) throw new RobloxUploadError(`Upload of "${name}" finished without an asset id${op.error?.message ? `: ${op.error.message}` : ""}.`, "UPLOAD_FAILED");
    this.cache[hash] = assetId;
    mkdirSync(dirname(this.opts.cacheFile), { recursive: true });
    writeFileSync(this.opts.cacheFile, JSON.stringify(this.cache, null, 2));
    return { assetId, cached: false };
  }
}

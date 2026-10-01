// Optional Figma REST features (comments, versions), enabled by FIGMA_TOKEN. The plugin has no
// network access, so these calls go from the server to api.figma.com, with rate-limit handling.

export const TOKEN_HELP =
  "These features use Figma's REST API and need a personal access token. In Figma: Settings → Security → " +
  "Personal access tokens → Generate (scopes: file_content:read, file_comments:write, file_versions:read). " +
  'Then add it to the Figma Bridge entry of your AI client config: "env": {"FIGMA_TOKEN": "figd_…"}, and restart the client.';

export class RestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** File key from a Figma URL (design, file, board, slides, proto) or a bare key. */
export function fileKeyFrom(input: string): string | null {
  const m = /figma\.com\/(?:file|design|board|slides|proto|deck)\/([A-Za-z0-9]{10,})/.exec(input);
  if (m) return m[1]!;
  return /^[A-Za-z0-9]{10,}$/.test(input.trim()) ? input.trim() : null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class FigmaRest {
  constructor(
    private token: string,
    private fetchImpl: Fetch = fetch,
    private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    private base = process.env.FIGMA_API_URL || "https://api.figma.com",
  ) {}

  /** JSON request with retries: 429 waits for Retry-After, 5xx and network errors back off; 3 retries. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let delay = 1000;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.base + path, {
          method,
          headers: { "X-Figma-Token": this.token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        if (attempt >= 3) throw new RestError(`Figma API unreachable: ${(e as Error).message}`, "NETWORK");
        await this.sleep(delay);
        delay *= 2;
        continue;
      }
      if (res.ok) return (res.status === 204 ? {} : await res.json()) as T;
      const retryAfter = Number(res.headers.get("retry-after"));
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await this.sleep(res.status === 429 && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : delay);
        delay *= 2;
        continue;
      }
      let detail = "";
      try {
        const j = (await res.json()) as { err?: string; message?: string };
        detail = j.err ?? j.message ?? "";
      } catch {}
      if (res.status === 403) throw new RestError(`Figma API refused the request (403${detail ? `: ${detail}` : ""}). Check that FIGMA_TOKEN is valid, has the needed scopes and can open this file.`, "FORBIDDEN", 403);
      if (res.status === 404) throw new RestError(`Not found (404${detail ? `: ${detail}` : ""}): check the file key or id.`, "NOT_FOUND", 404);
      if (res.status === 429) throw new RestError("Figma API rate limit reached: try again in a minute.", "RATE_LIMITED", 429);
      throw new RestError(`Figma API error ${res.status}${detail ? `: ${detail}` : ""}`, "REST_ERROR", res.status);
    }
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  async comments(key: string): Promise<RestComment[]> {
    const r = await this.call<{ comments: RestComment[] }>("GET", `/v1/files/${key}/comments?as_md=true`);
    return r.comments ?? [];
  }

  postComment(key: string, message: string, opts: { nodeId?: string; offset?: { x: number; y: number }; replyTo?: string } = {}) {
    const body: Record<string, unknown> = { message };
    if (opts.replyTo) body.comment_id = opts.replyTo;
    else if (opts.nodeId) body.client_meta = { node_id: opts.nodeId, node_offset: opts.offset ?? { x: 0, y: 0 } };
    return this.call<RestComment>("POST", `/v1/files/${key}/comments`, body);
  }

  deleteComment(key: string, id: string) {
    return this.call<unknown>("DELETE", `/v1/files/${key}/comments/${id}`);
  }

  // ─── Versions ─────────────────────────────────────────────────────────────

  async versions(key: string, limit = 30): Promise<RestVersion[]> {
    const out: RestVersion[] = [];
    let before: string | undefined;
    while (out.length < limit) {
      const r = await this.call<{ versions: RestVersion[]; pagination?: { prev_page?: string } }>(
        "GET",
        `/v1/files/${key}/versions?page_size=${Math.min(50, limit)}${before ? `&before=${before}` : ""}`,
      );
      out.push(...(r.versions ?? []));
      const next = r.pagination?.prev_page ? new URL(r.pagination.prev_page).searchParams.get("before") : null;
      if (!next || !r.versions?.length) break;
      before = next;
    }
    return out.slice(0, limit);
  }

  /** Node trees of a file, now or at a version. */
  async nodes(key: string, ids: string[], version?: string): Promise<Record<string, RestNode>> {
    const q = `ids=${encodeURIComponent(ids.join(","))}${version ? `&version=${encodeURIComponent(version)}` : ""}`;
    const r = await this.call<{ nodes: Record<string, { document: RestNode } | null> }>("GET", `/v1/files/${key}/nodes?${q}`);
    const out: Record<string, RestNode> = {};
    for (const [id, n] of Object.entries(r.nodes ?? {})) if (n?.document) out[id] = n.document;
    return out;
  }

  /** The document's pages (ids and names), now or at a version. */
  async pages(key: string, version?: string): Promise<RestNode[]> {
    const r = await this.call<{ document: RestNode }>("GET", `/v1/files/${key}?depth=1${version ? `&version=${encodeURIComponent(version)}` : ""}`);
    return r.document?.children ?? [];
  }
}

export interface RestComment {
  id: string;
  message: string;
  created_at: string;
  resolved_at?: string | null;
  parent_id?: string;
  order_id?: string | null;
  user?: { handle?: string; id?: string };
  client_meta?: { node_id?: string; node_offset?: { x: number; y: number }; x?: number; y?: number } | null;
}

export interface RestVersion {
  id: string;
  created_at: string;
  label?: string | null;
  description?: string | null;
  user?: { handle?: string };
}

export interface RestNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  characters?: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  fills?: { type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number } }[];
  children?: RestNode[];
}

/** Top-level comments with their replies, oldest first. */
export function threadComments(list: RestComment[], includeResolved: boolean) {
  const replies = new Map<string, RestComment[]>();
  for (const c of list) if (c.parent_id) replies.set(c.parent_id, [...(replies.get(c.parent_id) ?? []), c]);
  const brief = (c: RestComment) => ({ id: c.id, author: c.user?.handle, message: c.message, createdAt: c.created_at });
  return list
    .filter((c) => !c.parent_id && (includeResolved || !c.resolved_at))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((c) => ({
      ...brief(c),
      ...(c.order_id ? { number: Number(c.order_id) } : {}),
      ...(c.resolved_at ? { resolvedAt: c.resolved_at } : {}),
      ...(c.client_meta?.node_id ? { nodeId: c.client_meta.node_id } : {}),
      replies: (replies.get(c.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(brief),
    }));
}

// ─── Structural diff ──────────────────────────────────────────────────────────

export interface LayerChange {
  path: string;
  type: string;
  id: string;
  changes?: string[];
}

const hex = (c: { r: number; g: number; b: number; a: number }) =>
  "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase() + (c.a < 0.999 ? Math.round(c.a * 255).toString(16).padStart(2, "0").toUpperCase() : "");
const fillsOf = (n: RestNode) => (n.fills ?? []).filter((f) => f.visible !== false).map((f) => (f.type === "SOLID" && f.color ? hex(f.color) : f.type.toLowerCase())).join(",");

/** Layers by name path ("Card/Title", "Card/Title #2" for duplicates), skipping the root's own name. */
function flatten(root: RestNode, prefix: string, out: Map<string, RestNode>) {
  const seen = new Map<string, number>();
  for (const c of root.children ?? []) {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    const path = `${prefix}${c.name}${n > 1 ? ` #${n}` : ""}`;
    out.set(path, c);
    flatten(c, `${path}/`, out);
  }
}

/** Added, removed and changed layers between two versions of the same subtree, matched by name path. */
export function diffTrees(before: RestNode, after: RestNode, max = 200) {
  const a = new Map<string, RestNode>();
  const b = new Map<string, RestNode>();
  flatten(before, "", a);
  flatten(after, "", b);
  const added: LayerChange[] = [];
  const removed: LayerChange[] = [];
  const changed: LayerChange[] = [];
  for (const [path, n] of b) if (!a.has(path)) added.push({ path, type: n.type, id: n.id });
  for (const [path, n] of a) if (!b.has(path)) removed.push({ path, type: n.type, id: n.id });
  for (const [path, now] of b) {
    const old = a.get(path);
    if (!old) continue;
    const c: string[] = [];
    if (old.type !== now.type) c.push(`type ${old.type} → ${now.type}`);
    if ((old.visible ?? true) !== (now.visible ?? true)) c.push(now.visible === false ? "hidden" : "shown");
    if ((old.characters ?? "") !== (now.characters ?? "")) c.push(`text "${(old.characters ?? "").slice(0, 60)}" → "${(now.characters ?? "").slice(0, 60)}"`);
    const ob = old.absoluteBoundingBox;
    const nb = now.absoluteBoundingBox;
    if (ob && nb) {
      if (Math.abs(ob.width - nb.width) > 0.5 || Math.abs(ob.height - nb.height) > 0.5) c.push(`size ${Math.round(ob.width)}×${Math.round(ob.height)} → ${Math.round(nb.width)}×${Math.round(nb.height)}`);
      if (Math.abs(ob.x - nb.x) > 0.5 || Math.abs(ob.y - nb.y) > 0.5) c.push(`moved ${Math.round(nb.x - ob.x)}, ${Math.round(nb.y - ob.y)}`);
    }
    if (fillsOf(old) !== fillsOf(now)) c.push(`fill ${fillsOf(old) || "none"} → ${fillsOf(now) || "none"}`);
    if (c.length) changed.push({ path, type: now.type, id: now.id, changes: c });
  }
  // A moved parent moves its children: only report the topmost move.
  const movedOnly = (x: LayerChange) => x.changes!.length === 1 && x.changes![0]!.startsWith("moved");
  const movedPaths = new Set(changed.filter(movedOnly).map((x) => x.path));
  const cleaned = changed.filter((x) => !(movedOnly(x) && [...movedPaths].some((p) => p !== x.path && x.path.startsWith(`${p}/`))));
  const top = (list: LayerChange[]) => list.filter((x) => !list.some((y) => y !== x && x.path.startsWith(`${y.path}/`)));
  const addedTop = top(added);
  const removedTop = top(removed);
  return {
    summary: { added: addedTop.length, removed: removedTop.length, changed: cleaned.length, layersBefore: a.size, layersAfter: b.size },
    added: addedTop.slice(0, max),
    removed: removedTop.slice(0, max),
    changed: cleaned.slice(0, max),
    truncated: addedTop.length > max || removedTop.length > max || cleaned.length > max,
  };
}

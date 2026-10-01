import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffTrees, FigmaRest, fileKeyFrom, type RestNode, threadComments } from "../src/rest";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("REST client", () => {
  test("file keys from links", () => {
    expect(fileKeyFrom("https://www.figma.com/design/AbCdEf1234567890/My-file?node-id=1-2")).toBe("AbCdEf1234567890");
    expect(fileKeyFrom("https://www.figma.com/board/ZZZZZZZZZZZZ/Board")).toBe("ZZZZZZZZZZZZ");
    expect(fileKeyFrom("AbCdEf1234567890")).toBe("AbCdEf1234567890");
    expect(fileKeyFrom("not a link")).toBeNull();
  });

  test("429 waits for Retry-After, 5xx backs off, then succeeds", async () => {
    const replies = [json(429, {}, { "retry-after": "7" }), json(502, {}), json(200, { comments: [] })];
    const waits: number[] = [];
    const seen: RequestInit[] = [];
    const rest = new FigmaRest("tok", async (_u, init) => (seen.push(init!), replies.shift()!), async (ms) => void waits.push(ms));
    expect(await rest.comments("KEY")).toEqual([]);
    expect(waits).toEqual([7000, 2000]);
    expect((seen[0]!.headers as Record<string, string>)["X-Figma-Token"]).toBe("tok");
  });

  test("errors are explained", async () => {
    const rest = (r: Response) => new FigmaRest("tok", async () => r, async () => {});
    await expect(rest(json(403, { err: "Invalid token" })).comments("K")).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Invalid token") });
    await expect(rest(json(404, {})).versions("K")).rejects.toMatchObject({ code: "NOT_FOUND" });
    let calls = 0;
    const always429 = new FigmaRest("tok", async () => (calls++, json(429, {})), async () => {});
    await expect(always429.comments("K")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(calls).toBe(4);
  });

  test("post builds pinned comments and replies", async () => {
    const bodies: any[] = [];
    const rest = new FigmaRest("tok", async (_u, init) => (bodies.push(JSON.parse(String(init!.body))), json(200, { id: "c9" })), async () => {});
    await rest.postComment("K", "Fix contrast", { nodeId: "1:2", offset: { x: 4, y: 8 } });
    await rest.postComment("K", "Done", { replyTo: "c1" });
    expect(bodies).toEqual([{ message: "Fix contrast", client_meta: { node_id: "1:2", node_offset: { x: 4, y: 8 } } }, { message: "Done", comment_id: "c1" }]);
  });

  test("versions follow pagination", async () => {
    const pages = [
      json(200, { versions: [{ id: "3", created_at: "c" }, { id: "2", created_at: "b" }], pagination: { prev_page: "https://api.figma.com/v1/files/K/versions?before=2" } }),
      json(200, { versions: [{ id: "1", created_at: "a" }], pagination: {} }),
    ];
    const urls: string[] = [];
    const rest = new FigmaRest("tok", async (u) => (urls.push(u), pages.shift()!), async () => {});
    expect((await rest.versions("K", 10)).map((v) => v.id)).toEqual(["3", "2", "1"]);
    expect(urls[1]).toContain("before=2");
  });

  test("threads group replies and hide resolved ones", () => {
    const list = [
      { id: "1", message: "Spacing?", created_at: "2026-01-01", client_meta: { node_id: "4:5", node_offset: { x: 0, y: 0 } }, user: { handle: "Ada" }, order_id: "1" },
      { id: "2", message: "Fixed", created_at: "2026-01-02", parent_id: "1", user: { handle: "Bot" } },
      { id: "3", message: "Old", created_at: "2025-12-01", resolved_at: "2025-12-02" },
    ];
    expect(threadComments(list, false)).toEqual([
      { id: "1", author: "Ada", message: "Spacing?", createdAt: "2026-01-01", number: 1, nodeId: "4:5", replies: [{ id: "2", author: "Bot", message: "Fixed", createdAt: "2026-01-02" }] },
    ]);
    expect(threadComments(list, true).map((t) => t.id)).toEqual(["3", "1"]);
  });
});

describe("structural diff", () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const before: RestNode = {
    id: "0:1", name: "Page", type: "CANVAS",
    children: [
      { id: "1:1", name: "Card", type: "FRAME", absoluteBoundingBox: box(0, 0, 300, 200), fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], children: [
        { id: "1:2", name: "Title", type: "TEXT", characters: "Pro", absoluteBoundingBox: box(16, 16, 40, 20) },
        { id: "1:3", name: "Old badge", type: "FRAME", children: [{ id: "1:4", name: "Label", type: "TEXT", characters: "New" }] },
      ] },
      { id: "1:5", name: "Card", type: "FRAME", absoluteBoundingBox: box(400, 0, 300, 200) },
    ],
  };
  const after: RestNode = {
    id: "0:1", name: "Page", type: "CANVAS",
    children: [
      { id: "1:1", name: "Card", type: "FRAME", absoluteBoundingBox: box(0, 0, 320, 200), fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }], children: [
        { id: "1:2", name: "Title", type: "TEXT", characters: "Pro plan", absoluteBoundingBox: box(16, 16, 80, 20) },
        { id: "2:1", name: "Price", type: "FRAME", children: [{ id: "2:2", name: "Amount", type: "TEXT", characters: "$9" }] },
      ] },
      { id: "1:5", name: "Card", type: "FRAME", absoluteBoundingBox: box(400, 40, 300, 200), visible: false },
    ],
  };
  test("added, removed and changed layers by name path, top level only", () => {
    const d = diffTrees(before, after);
    expect(d.added).toEqual([{ path: "Card/Price", type: "FRAME", id: "2:1" }]);
    expect(d.removed).toEqual([{ path: "Card/Old badge", type: "FRAME", id: "1:3" }]);
    expect(d.changed).toEqual([
      { path: "Card", type: "FRAME", id: "1:1", changes: ["size 300×200 → 320×200", "fill #FFFFFF → #000000"] },
      { path: "Card/Title", type: "TEXT", id: "1:2", changes: ['text "Pro" → "Pro plan"', "size 40×20 → 80×20"] },
      { path: "Card #2", type: "FRAME", id: "1:5", changes: ["hidden", "moved 0, 40"] },
    ]);
    expect(d.summary).toMatchObject({ added: 1, removed: 1, changed: 3 });
  });
});

describe("tools over MCP", () => {
  test("without FIGMA_TOKEN the tools explain how to set one; with it they call the API", async () => {
    const calls: string[] = [];
    const api = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url!.startsWith("/v1/files/FILEKEY12345/comments")) res.end(JSON.stringify({ comments: [{ id: "1", message: "Hi", created_at: "2026-01-01", user: { handle: "Ada" } }] }));
      else if (req.url!.startsWith("/v1/files/FILEKEY12345/versions")) res.end(JSON.stringify({ versions: [{ id: "77", created_at: "2026-01-01", label: "v1", user: { handle: "Ada" } }] }));
      else res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    const port = (api.address() as { port: number }).port;
    const run = async (env: Record<string, string>, fn: (c: Client) => Promise<void>) => {
      const client = new Client({ name: "rest-test", version: "1" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ["run", join(import.meta.dir, "..", "src", "server.ts")],
          stderr: "ignore",
          env: { ...process.env, FIGMA_BRIDGE_PORT: String(45000 + Math.floor(Math.random() * 5000)), FIGMA_BRIDGE_OUT: mkdtempSync(join(tmpdir(), "fb-rest-")), FIGMA_TOKEN: "", ...env } as Record<string, string>,
        }),
      );
      try {
        await fn(client);
      } finally {
        await client.close();
      }
    };
    const text = (r: any) => JSON.parse(r.content[0].text);
    try {
      await run({}, async (c) => {
        const r: any = await c.callTool({ name: "comments", arguments: { fileUrl: "https://www.figma.com/design/FILEKEY12345/x" } });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatchObject({ code: "NO_TOKEN", error: expect.stringContaining("Personal access tokens") });
      });
      await run({ FIGMA_TOKEN: "figd_test", FIGMA_API_URL: `http://127.0.0.1:${port}` }, async (c) => {
        const list: any = await c.callTool({ name: "comments", arguments: { fileUrl: "https://www.figma.com/design/FILEKEY12345/x" } });
        expect(text(list)).toMatchObject({ fileKey: "FILEKEY12345", open: 1, threads: [{ id: "1", author: "Ada", message: "Hi" }] });
        const versions: any = await c.callTool({ name: "versions", arguments: { fileUrl: "FILEKEY12345" } });
        expect(text(versions).versions).toEqual([{ id: "77", createdAt: "2026-01-01", label: "v1", author: "Ada" }]);
        const missing: any = await c.callTool({ name: "versions", arguments: { action: "diff", fileUrl: "FILEKEY12345" } });
        expect(text(missing).code).toBe("BAD_ARGS");
      });
      expect(calls).toEqual(["GET /v1/files/FILEKEY12345/comments?as_md=true", "GET /v1/files/FILEKEY12345/versions?page_size=30"]);
    } finally {
      api.close();
    }
  }, 30_000);
});

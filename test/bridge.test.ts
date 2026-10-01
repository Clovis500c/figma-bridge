import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { Bridge, BridgeError, callTarget, Framer, type Msg } from "../src/bridge";

const noop = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(20);
  }
}

// Browser-style WebSocket like the real plugin UI; Bun's lets tests set the Origin header.
function browserSocket(port: number, origin?: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`, (origin ? { headers: { Origin: origin } } : {}) as any);
}

/** A Figma plugin stand-in: answers every request with {from, method, params}. */
class FakePlugin {
  ws: WebSocket;
  welcome?: Msg;
  closeCode?: number;
  private framer = new Framer();
  onRequest: (m: Msg) => void = (m) => this.send({ t: "res", id: m.id, ok: true, result: this.reply(m) });
  reply: (m: Msg) => unknown = (m) => ({ from: this.id, method: m.method, params: m.params });

  constructor(
    port: number,
    readonly id: string,
    readonly fileName: string,
    origin?: string,
  ) {
    this.ws = browserSocket(port, origin);
    this.ws.onopen = () => this.send({ t: "hello", role: "plugin", channel: "default", version: "9.9.9", session: { id, fileName, page: "Page 1", editorType: /board/i.test(fileName) ? "figjam" : "figma" } });
    this.ws.onmessage = (ev) => {
      const m = this.framer.decode(String(ev.data));
      if (!m) return;
      if (m.t === "welcome") this.welcome = m;
      if (m.t === "req") this.onRequest(m);
    };
    this.ws.onclose = (ev) => (this.closeCode = ev.code);
  }

  send(m: Msg) {
    for (const f of Framer.encode(m)) this.ws.send(f);
  }

  ready() {
    return until(() => !!this.welcome);
  }

  async closed(): Promise<number> {
    await until(() => this.closeCode !== undefined);
    return this.closeCode!;
  }
}

describe("Framer", () => {
  test("small messages are a single frame", () => {
    const frames = Framer.encode({ t: "req", id: "1", params: { a: 1 } });
    expect(frames).toHaveLength(1);
    expect(new Framer().decode(frames[0]!)).toEqual({ t: "req", id: "1", params: { a: 1 } });
  });

  test("large messages are chunked and reassembled in any order", () => {
    const big = { t: "res", id: "x", result: "é".repeat(2_500_000) + "end" };
    const frames = Framer.encode(big);
    expect(frames.length).toBe(3);
    for (const f of frames) expect(f.length).toBeLessThan((1 << 20) + 200);
    const framer = new Framer();
    const shuffled = [frames[2]!, frames[0]!, frames[1]!];
    expect(framer.decode(shuffled[0]!)).toBeNull();
    expect(framer.decode(shuffled[1]!)).toBeNull();
    expect(framer.decode(shuffled[2]!)).toEqual(big);
  });

  test("duplicate chunks are ignored", () => {
    const frames = Framer.encode({ t: "res", data: "a".repeat(1_500_000) });
    const framer = new Framer();
    expect(framer.decode(frames[0]!)).toBeNull();
    expect(framer.decode(frames[0]!)).toBeNull();
    expect(framer.decode(frames[1]!)).toMatchObject({ t: "res" });
  });

  test("rejects chunk headers announcing a huge message", () => {
    const evil = JSON.stringify({ t: "chunk", cid: "c", i: 0, n: 100_000, d: "x" });
    expect(() => new Framer().decode(evil)).toThrow(BridgeError);
  });
});

describe("hub", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function setup() {
    const port = await freePort();
    const hub = new Bridge({ port, channel: "default", version: "1.5.0", log: noop, waitForPluginMs: 2000 });
    hub.start();
    cleanup.push(() => hub.stop());
    await until(() => hub.mode === "hub");
    const agent = new Bridge({ port, channel: "default", log: noop, waitForPluginMs: 2000 });
    agent.start();
    cleanup.push(() => agent.stop());
    await until(() => agent.mode === "client");
    const plugin = (id: string, name: string, origin?: string) => {
      const p = new FakePlugin(port, id, name, origin);
      cleanup.push(() => p.ws.close());
      return p;
    };
    return { port, hub, agent, plugin };
  }

  test("routes requests from both agents to the plugin", async () => {
    const { hub, agent, plugin } = await setup();
    const p = plugin("s1", "File A");
    await p.ready();
    expect(p.welcome).toMatchObject({ bridge: "figma-bridge", version: "1.5.0", role: "plugin" });
    expect(await hub.request<unknown>("ping", { n: 1 })).toEqual({ from: "s1", method: "ping", params: { n: 1 } });
    expect(await agent.request<unknown>("ping", { n: 2 })).toEqual({ from: "s1", method: "ping", params: { n: 2 } });
    const sessions = await agent.sessions();
    expect(sessions.map((s) => [s.id, s.fileName, s.version])).toEqual([["s1", "File A", "9.9.9"]]);
  });

  test("large results cross the hub in chunks", async () => {
    const { agent, plugin } = await setup();
    const p = plugin("s1", "File A");
    p.reply = () => ({ blob: "z".repeat(3_000_000) });
    await p.ready();
    const r = await agent.request<{ blob: string }>("screenshot");
    expect(r.blob.length).toBe(3_000_000);
  });

  test("several files: ambiguous until a session is selected", async () => {
    const { hub, agent, plugin } = await setup();
    const a = plugin("s1", "Marketing site");
    const b = plugin("s2", "Mobile app");
    await Promise.all([a.ready(), b.ready()]);
    await expect(agent.request("ping")).rejects.toMatchObject({ code: "AMBIGUOUS" });
    await agent.select("mobile");
    expect(await agent.request<{ from: string }>("ping")).toMatchObject({ from: "s2" });
    await hub.select("s1");
    expect(await hub.request<{ from: string }>("ping")).toMatchObject({ from: "s1" });
    await expect(agent.select("nothing like it")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("{file} targets one file per call, in parallel, without changing the selection", async () => {
    const { agent, plugin } = await setup();
    const a = plugin("s1", "Marketing site");
    const b = plugin("s2", "Team board");
    // Each plugin answers after 300 ms: two calls at once must not take 600 ms.
    for (const p of [a, b]) p.onRequest = (m) => setTimeout(() => p.send({ t: "res", id: m.id, ok: true, result: p.reply(m) }), 300);
    await Promise.all([a.ready(), b.ready()]);
    const t0 = Date.now();
    const [ra, rb] = await Promise.all([
      callTarget.run({ file: "marketing" }, () => agent.request<{ from: string }>("ping")),
      callTarget.run({ file: "s2" }, () => agent.request<{ from: string }>("ping")),
    ]);
    expect([ra.from, rb.from]).toEqual(["s1", "s2"]);
    expect(Date.now() - t0).toBeLessThan(550);
    expect(agent.selection).toEqual({});
    await expect(callTarget.run({ file: "nope" }, () => agent.request("ping"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await agent.sessions()).map((s) => [s.fileName, s.editorType])).toEqual([["Marketing site", "figma"], ["Team board", "figjam"]]);
  });

  test("errors from the plugin keep their code and details", async () => {
    const { agent, plugin } = await setup();
    const p = plugin("s1", "File A");
    p.onRequest = (m) => p.send({ t: "res", id: m.id, ok: false, code: "SCRIPT_ERROR", error: "boom", line: 3 });
    await p.ready();
    await expect(agent.request("run_script")).rejects.toMatchObject({ code: "SCRIPT_ERROR", message: "boom", details: { line: 3 } });
  });

  test("a plugin that disconnects mid-command fails it with PLUGIN_GONE", async () => {
    const { agent, plugin } = await setup();
    const p = plugin("s1", "File A");
    p.onRequest = () => setTimeout(() => p.ws.close(), 50);
    await p.ready();
    await expect(agent.request("build")).rejects.toMatchObject({ code: "PLUGIN_GONE" });
  });

  test("without a plugin, requests fail with NO_SESSION after waiting", async () => {
    const { agent } = await setup();
    const t0 = Date.now();
    await expect(agent.request("ping", {}, 5000, 400)).rejects.toMatchObject({ code: "NO_SESSION" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
  });

  test("browser pages cannot connect as plugin or agent", async () => {
    const { port, plugin } = await setup();
    const evil = plugin("x", "Evil", "https://evil.example");
    expect(await evil.closed()).toBe(1008);
    const agentFromBrowser = browserSocket(port, "https://www.figma.com");
    agentFromBrowser.onopen = () => agentFromBrowser.send(JSON.stringify({ t: "hello", role: "agent", channel: "default" }));
    const code = await new Promise<number>((r) => (agentFromBrowser.onclose = (ev) => r(ev.code)));
    expect(code).toBe(1008);
    const figma = plugin("ok", "Allowed", "https://www.figma.com");
    await figma.ready();
  });

  test("the other agent takes over the port when the hub process stops", async () => {
    const { port, hub, agent, plugin } = await setup();
    const p = plugin("s1", "File A");
    await p.ready();
    await hub.stop();
    await until(() => agent.mode === "hub");
    // The real plugin UI reconnects on its own; the fake one reconnects here.
    const again = plugin("s1", "File A");
    await again.ready();
    expect(await agent.request<{ from: string }>("ping")).toMatchObject({ from: "s1" });
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    expect(health).toMatchObject({ bridge: "figma-bridge", sessions: [{ id: "s1" }] });
  });
});

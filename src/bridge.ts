import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

/**
 * Local WebSocket bridge between MCP agents and Figma plugin sessions.
 *
 * The first MCP server process to start binds the port and becomes the hub.
 * Any other MCP process (a second Claude Code window, the self-test…) joins it
 * as an "agent" client, and takes over the port if the hub process exits.
 */

export const BRIDGE_NAME = "figma-bridge";
export const PROTOCOL_VERSION = 1;

const CHUNK_CHARS = 1 << 20; // 1 MiB of JSON text per frame
const MAX_MESSAGE_CHARS = 256 << 20;
const PARTIAL_TTL_MS = 60_000;
const INFLIGHT_TTL_MS = 180_000;
const HANDSHAKE_MS = 2_500;
const PING_MS = 20_000;
const IDLE_MS = 120_000;

export type Msg = { t: string; [key: string]: any };

export interface SessionInfo {
  id: string;
  fileName: string;
  page: string;
  channel: string;
  version?: string;
  /** figma, figjam, slides or dev. */
  editorType?: string;
  /** For the REST features; only private and development plugins receive it. */
  fileKey?: string;
  pageId?: string;
  connectedAt: number;
}

/** Per tool call: the file it targets ({file} argument), without changing the selected session. */
export const callTarget = new AsyncLocalStorage<{ file?: string }>();

export interface Selection {
  id?: string;
  fileName?: string;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const mb = (chars: number) => `${(chars / (1 << 20)).toFixed(1)} MB`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True if anything accepts TCP connections on the port (IPv4 or IPv6 loopback). */
async function portInUse(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const sock = connect({ host, port });
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(v);
      };
      const timer = setTimeout(() => done(false), 500);
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
    });
  const [v4, v6] = await Promise.all([probe("127.0.0.1"), probe("::1")]);
  return v4 || v6;
}

export const NO_PLUGIN_HELP =
  "No Figma file is connected. Ask the user to open the Figma desktop app and run " +
  "Plugins → Development → Figma Bridge (Ctrl+Alt+P re-runs the last plugin).";

/** Splits oversized messages into chunk frames and reassembles them. */
export class Framer {
  private partials = new Map<string, { parts: string[]; got: number; at: number }>();

  static encode(msg: Msg): string[] {
    const text = JSON.stringify(msg);
    if (text.length <= CHUNK_CHARS) return [text];
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new BridgeError(`Message too large (${mb(text.length)}, max ${mb(MAX_MESSAGE_CHARS)})`, "TOO_LARGE");
    }
    const cid = randomUUID();
    const n = Math.ceil(text.length / CHUNK_CHARS);
    const frames: string[] = [];
    for (let i = 0; i < n; i++) {
      frames.push(JSON.stringify({ t: "chunk", cid, i, n, d: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) }));
    }
    return frames;
  }

  /** Returns the full message, or null while chunks are still missing. */
  decode(raw: string): Msg | null {
    const msg = JSON.parse(raw) as Msg;
    if (msg.t !== "chunk") return msg;
    const now = Date.now();
    for (const [cid, p] of this.partials) if (now - p.at > PARTIAL_TTL_MS) this.partials.delete(cid);
    if (msg.n * CHUNK_CHARS > MAX_MESSAGE_CHARS + CHUNK_CHARS) throw new BridgeError("Chunked message too large", "TOO_LARGE");
    let p = this.partials.get(msg.cid);
    if (!p) this.partials.set(msg.cid, (p = { parts: new Array(msg.n), got: 0, at: now }));
    if (p.parts[msg.i] === undefined) {
      p.parts[msg.i] = msg.d;
      p.got++;
    }
    p.at = now;
    if (p.got < msg.n) return null;
    this.partials.delete(msg.cid);
    return JSON.parse(p.parts.join(""));
  }
}

// ─── Hub ────────────────────────────────────────────────────────────────────

interface PeerData {
  origin: string | null;
  framer: Framer;
  role?: "plugin" | "agent";
  channel?: string;
  session?: SessionInfo;
  seen: number;
  /** Snippet library version this plugin already holds: run_script stops carrying the sources. */
  libHash?: string;
}

interface Peer {
  ws: WebSocket;
  data: PeerData;
  send(text: string): void;
  close(code: number, reason: string): void;
}

type Reply = (msg: Msg) => void;

function sendFrames(ws: { send(data: string): unknown }, msg: Msg) {
  for (const frame of Framer.encode(msg)) ws.send(frame);
}

/**
 * run_script carries the whole snippet library (MBs once snippets hold base64 assets), and Figma clones it into
 * its own thread with every message. A plugin keeps the last library it loaded, so once it holds a hash the
 * sources are dropped. Plugins of any version ignore the sources when the hash is unchanged.
 */
export function withoutKnownLibrary(plugin: { data: { libHash?: string } }, msg: Msg): unknown {
  const params = msg.params;
  if (msg.method !== "run_script" || !params || typeof params.libHash !== "string") return params;
  if (plugin.data.libHash === params.libHash) {
    const { lib: _sources, ...rest } = params;
    return rest;
  }
  if (params.lib) plugin.data.libHash = params.libHash;
  return params;
}

// Browsers always send Origin; Figma plugin iframes are sandboxed ("null").
// Agents must be non-browser processes so a web page can never drive Figma.
function pluginOriginAllowed(origin: string | null) {
  return origin === null || origin === "null" || /^https:\/\/([a-z0-9-]+\.)*figma\.com$/i.test(origin);
}

export class Hub {
  private plugins = new Map<string, Peer>();
  private peers = new Set<Peer>();
  private inflight = new Map<string, { reply: Reply; plugin: string; owner: object; at: number }>();
  private sweeper: ReturnType<typeof setInterval>;

  private constructor(
    readonly port: number,
    private log: (line: string) => void,
    readonly version: string,
    private server: Server,
    private wss: WebSocketServer,
  ) {
    server.on("request", (req, res) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ bridge: BRIDGE_NAME, protocol: PROTOCOL_VERSION, version: this.version, sessions: this.sessions() }));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${BRIDGE_NAME} is running. Open the Figma plugin to connect.`);
    });
    server.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => this.onOpen(ws, req.headers.origin ?? null));
    });
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, f] of this.inflight) if (now - f.at > INFLIGHT_TTL_MS) this.inflight.delete(id);
      // Plugins and agents ping every 20 s: a silent socket is a dead one.
      for (const peer of this.peers) if (now - peer.data.seen > IDLE_MS) peer.ws.terminate();
    }, 30_000);
  }

  /** Binds 127.0.0.1:port; rejects with code EADDRINUSE when it is taken. */
  static start(port: number, log: (line: string) => void, version = ""): Promise<Hub> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      const wss = new WebSocketServer({ noServer: true, maxPayload: 8 << 20, perMessageDeflate: false });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (e) => log(`hub: ${e.message}`));
        resolve(new Hub(port, log, version, server, wss));
      });
    });
  }

  private onOpen(ws: WebSocket, origin: string | null) {
    const peer: Peer = {
      ws,
      data: { origin, framer: new Framer(), seen: Date.now() },
      send: (text) => ws.readyState === WebSocket.OPEN && ws.send(text),
      close: (code, reason) => ws.close(code, reason),
    };
    this.peers.add(peer);
    ws.on("message", (raw) => {
      peer.data.seen = Date.now();
      this.onFrame(peer, raw.toString());
    });
    ws.on("close", () => {
      this.peers.delete(peer);
      this.onClose(peer);
    });
    ws.on("error", () => {});
  }

  stop(): Promise<void> {
    clearInterval(this.sweeper);
    for (const peer of this.peers) peer.ws.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  sessions(channel?: string): SessionInfo[] {
    const list: SessionInfo[] = [];
    for (const peer of this.plugins.values()) {
      if (peer.data.session && (!channel || peer.data.channel === channel)) list.push(peer.data.session);
    }
    return list.sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /** Entry point for requests from agents (in-process or over WebSocket). */
  handleRequest(msg: Msg, reply: Reply, owner: object, channel: string) {
    const fail = (error: string, code: string) => reply({ t: "res", id: msg.id, ok: false, error, code });
    if (msg.method === "$sessions") {
      reply({ t: "res", id: msg.id, ok: true, result: this.sessions(channel) });
      return;
    }
    let plugin: Peer;
    try {
      plugin = this.resolve(channel, msg.sel);
    } catch (e) {
      const err = e as BridgeError;
      fail(err.message, err.code);
      return;
    }
    const sid = plugin.data.session!.id;
    this.inflight.set(msg.id, { reply, plugin: sid, owner, at: Date.now() });
    try {
      sendFrames(plugin, { t: "req", id: msg.id, method: msg.method, params: withoutKnownLibrary(plugin, msg), timeoutMs: msg.timeoutMs });
    } catch (e) {
      this.inflight.delete(msg.id);
      fail((e as Error).message, (e as BridgeError).code ?? "SEND_FAILED");
    }
  }

  private resolve(channel: string, sel: Selection = {}): Peer {
    const list = [...this.plugins.values()].filter((ws) => ws.data.channel === channel);
    if (!list.length) throw new BridgeError(NO_PLUGIN_HELP, "NO_SESSION");
    const names = list.map((ws) => `"${ws.data.session!.fileName}"`).join(", ");
    if (sel.id) {
      const hit = list.find((ws) => ws.data.session!.id === sel.id);
      if (hit) return hit;
    }
    if (sel.fileName) {
      const wanted = sel.fileName.toLowerCase();
      const hits = list.filter((ws) => ws.data.session!.fileName.toLowerCase() === wanted);
      if (hits.length) return hits[hits.length - 1]!;
      throw new BridgeError(`Selected file "${sel.fileName}" is no longer connected. Connected: ${names}. Use select_session.`, "NOT_CONNECTED");
    }
    if (list.length === 1) return list[0]!;
    throw new BridgeError(`Several Figma files are connected (${names}). Call select_session first.`, "AMBIGUOUS");
  }

  private onFrame(ws: Peer, raw: string) {
    let msg: Msg | null;
    try {
      msg = ws.data.framer.decode(raw);
    } catch (e) {
      this.log(`hub: dropped malformed frame (${(e as Error).message})`);
      return;
    }
    if (!msg) return;
    if (msg.t === "ping") return void ws.send('{"t":"pong"}');
    if (msg.t === "hello") return this.onHello(ws, msg);

    if (ws.data.role === "plugin") {
      if (msg.t === "res") {
        // The plugin lost the library (or never got it): send the sources with the next script.
        if (!msg.ok && msg.code === "NEED_LIB") ws.data.libHash = undefined;
        const f = this.inflight.get(msg.id);
        if (f) {
          this.inflight.delete(msg.id);
          f.reply(msg);
        }
      } else if (msg.t === "info" && ws.data.session) {
        if (typeof msg.fileName === "string") ws.data.session.fileName = msg.fileName;
        if (typeof msg.page === "string") ws.data.session.page = msg.page;
        if (typeof msg.editorType === "string") ws.data.session.editorType = msg.editorType;
        if (typeof msg.pageId === "string") ws.data.session.pageId = msg.pageId;
      }
    } else if (ws.data.role === "agent") {
      if (msg.t === "req") this.handleRequest(msg, (m) => sendFrames(ws, m), ws, ws.data.channel!);
    } else {
      ws.close(1008, "hello expected");
    }
  }

  private onHello(ws: Peer, msg: Msg) {
    const channel = String(msg.channel || "default");
    if (msg.role === "agent") {
      if (ws.data.origin !== null) return void ws.close(1008, "agents must not be browsers");
      ws.data.role = "agent";
      ws.data.channel = channel;
    } else if (msg.role === "plugin") {
      if (!pluginOriginAllowed(ws.data.origin)) {
        this.log(`hub: rejected plugin from origin ${ws.data.origin}`);
        return void ws.close(1008, "origin not allowed");
      }
      const s = msg.session ?? {};
      const session: SessionInfo = {
        id: String(s.id || randomUUID()),
        fileName: String(s.fileName || "Untitled"),
        page: String(s.page || ""),
        channel,
        version: msg.version,
        editorType: typeof s.editorType === "string" ? s.editorType : undefined,
        fileKey: typeof s.fileKey === "string" && s.fileKey ? s.fileKey : undefined,
        pageId: typeof s.pageId === "string" ? s.pageId : undefined,
        connectedAt: Date.now(),
      };
      const previous = this.plugins.get(session.id);
      if (previous && previous !== ws) {
        previous.data.role = undefined; // stale socket: its close must not fail new work
        previous.close(1000, "replaced");
      }
      ws.data.role = "plugin";
      ws.data.channel = channel;
      ws.data.session = session;
      this.plugins.set(session.id, ws);
      this.log(`Figma connected: "${session.fileName}" (channel ${channel})`);
    } else {
      return void ws.close(1008, "unknown role");
    }
    sendFrames(ws, { t: "welcome", bridge: BRIDGE_NAME, protocol: PROTOCOL_VERSION, version: this.version, role: ws.data.role });
  }

  private onClose(ws: Peer) {
    if (ws.data.role === "plugin" && ws.data.session) {
      const sid = ws.data.session.id;
      if (this.plugins.get(sid) === ws) this.plugins.delete(sid);
      this.log(`Figma disconnected: "${ws.data.session.fileName}"`);
      for (const [id, f] of this.inflight) {
        if (f.plugin !== sid) continue;
        this.inflight.delete(id);
        f.reply({ t: "res", id, ok: false, code: "PLUGIN_GONE", error: "The Figma plugin disconnected while running this command. Check the file state before retrying." });
      }
    } else if (ws.data.role === "agent") {
      for (const [id, f] of this.inflight) if (f.owner === ws) this.inflight.delete(id);
    }
  }
}

// ─── Agent-side bridge used by the MCP server ───────────────────────────────

export interface BridgeOptions {
  port: number;
  channel: string;
  /** Server version, sent to plugins so they can warn about a mismatch. */
  version?: string;
  log: (line: string) => void;
  /** How long a request waits for a Figma plugin to connect before failing. */
  waitForPluginMs?: number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Bridge {
  mode: "starting" | "hub" | "client" | "offline" = "starting";
  lastError?: string;
  selection: Selection = {};

  private hub?: Hub;
  private ws?: WebSocket;
  private framer = new Framer();
  private pending = new Map<string, Pending>();
  private readyWaiters: (() => void)[] = [];
  private stopped = false;

  constructor(private opts: BridgeOptions) {}

  start() {
    void this.loop();
  }

  /** Releases the port or leaves the hub (another process can then take over). */
  async stop() {
    this.stopped = true;
    this.mode = "offline";
    this.ws?.close();
    await this.hub?.stop();
    this.hub = undefined;
  }

  get port() {
    return this.opts.port;
  }

  get channel() {
    return this.opts.channel;
  }

  /** Stays hub or client forever; becomes hub if the hosting process goes away. */
  private async loop() {
    let delay = 200;
    while (!this.stopped) {
      // Probe first: on Windows another program can listen on the same port
      // (0.0.0.0 or ::1 vs our 127.0.0.1), so EADDRINUSE alone is not enough.
      if (!(await portInUse(this.opts.port)) && (await this.tryHost())) return;
      if (this.stopped) return;
      const lost = await this.tryJoin();
      if (lost) {
        await lost;
        delay = 200;
        continue; // hub vanished: try to take the port right away
      }
      this.mode = "offline";
      await sleep(delay);
      delay = Math.min(delay * 2, 3000);
    }
  }

  private async tryHost(): Promise<boolean> {
    try {
      this.hub = await Hub.start(this.opts.port, this.opts.log, this.opts.version);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code !== "EADDRINUSE" && !/in use/i.test(String(err.message))) {
        this.lastError = `Cannot open port ${this.opts.port}: ${err.message}`;
      }
      return false;
    }
    if (this.stopped) {
      await this.hub.stop();
      return true;
    }
    this.mode = "hub";
    this.lastError = undefined;
    this.opts.log(`Bridge hub listening on ws://localhost:${this.opts.port} (channel ${this.opts.channel})`);
    this.flushReady();
    return true;
  }

  /** Resolves to a "connection lost" promise when joined, or null on failure. */
  private tryJoin(): Promise<Promise<void> | null> {
    return new Promise((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}`);
      let joined = false;
      let settled = false;
      const finish = (v: Promise<void> | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshake);
        done(v);
      };
      const handshake = setTimeout(() => {
        this.lastError =
          `Port ${this.opts.port} is used by another program that is not Figma Bridge ` +
          `(for example the old TalkToFigma socket "bun run src/socket.ts"). Close it; the bridge retries automatically.`;
        ws.close();
        finish(null);
      }, HANDSHAKE_MS);

      let lostResolve!: () => void;
      const lost = new Promise<void>((r) => (lostResolve = r));
      let pinger: ReturnType<typeof setInterval> | undefined;

      ws.onopen = () => sendFrames(ws, { t: "hello", role: "agent", channel: this.opts.channel });
      ws.onmessage = (ev) => {
        let msg: Msg | null;
        try {
          msg = this.framer.decode(String(ev.data));
        } catch {
          return;
        }
        if (!msg) return;
        if (!joined) {
          if (msg.t !== "welcome" || msg.bridge !== BRIDGE_NAME) return; // wait for handshake timeout
          joined = true;
          this.ws = ws;
          this.mode = "client";
          this.lastError = undefined;
          this.opts.log(`Joined existing bridge hub on port ${this.opts.port}`);
          pinger = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'), PING_MS);
          this.flushReady();
          finish(lost);
          return;
        }
        if (msg.t === "res") this.onResponse(msg);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        clearInterval(pinger);
        if (!joined) return finish(null);
        this.ws = undefined;
        this.mode = "offline";
        if (!this.stopped) this.opts.log("Bridge hub went away; reconnecting");
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new BridgeError("The bridge hub restarted while this command was running. Check the file state before retrying.", "HUB_LOST"));
        }
        lostResolve();
      };
    });
  }

  private flushReady() {
    for (const w of this.readyWaiters.splice(0)) w();
  }

  private whenReady(ms: number) {
    if (this.mode === "hub" || this.mode === "client") return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Sends a request to the selected Figma session; waits briefly for a plugin to connect. */
  async request<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
    waitMs = this.opts.waitForPluginMs ?? 10_000,
  ): Promise<T> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (!(await this.whenReady(Math.max(0, deadline - Date.now())))) {
        throw new BridgeError(this.lastError ?? `The bridge could not open or join port ${this.opts.port}.`, "OFFLINE");
      }
      try {
        return await this.send<T>(method, params, timeoutMs, await this.selectionFor(method));
      } catch (e) {
        // Only retry when the command was never delivered to Figma.
        const retryable = e instanceof BridgeError && (e.code === "NO_SESSION" || e.code === "OFFLINE");
        if (!retryable || Date.now() > deadline) throw e;
        await sleep(300);
      }
    }
  }

  /** The session a request goes to: the call's own {file}, else the selected session. */
  private async selectionFor(method: string): Promise<Selection> {
    const file = method === "$sessions" ? undefined : callTarget.getStore()?.file;
    if (!file) return this.selection;
    const s = await this.find(file);
    return { id: s.id, fileName: s.fileName };
  }

  private send<T>(method: string, params: Record<string, unknown>, timeoutMs: number, sel: Selection): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const msg: Msg = { t: "req", id, method, params, sel, timeoutMs };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`${method} got no answer after ${Math.round(timeoutMs / 1000)} s. Figma may be frozen by a long synchronous script.`, "TIMEOUT"));
      }, timeoutMs + 5_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        if (this.mode === "hub" && this.hub) this.hub.handleRequest(msg, (m) => this.onResponse(m), this, this.opts.channel);
        else if (this.mode === "client" && this.ws) sendFrames(this.ws, msg);
        else throw new BridgeError(this.lastError ?? "Bridge offline", "OFFLINE");
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  private onResponse(msg: Msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) return p.resolve(msg.result);
    const { t, id, ok, error, code, ...details } = msg;
    p.reject(new BridgeError(String(error ?? "Unknown error"), String(code ?? "PLUGIN_ERROR"), details));
  }

  sessions(): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>("$sessions", {}, 5_000, 1_500);
  }

  async select(name: string): Promise<SessionInfo> {
    const hit = await this.find(name);
    this.selection = { id: hit.id, fileName: hit.fileName };
    return hit;
  }

  /** The session this call goes to ({file}, the selection, or the only one), or null. */
  async current(): Promise<SessionInfo | null> {
    const file = callTarget.getStore()?.file;
    if (file) return this.find(file);
    const list = await this.sessions().catch(() => [] as SessionInfo[]);
    return list.find((s) => s.id === this.selection.id) ?? (list.length === 1 ? list[0]! : null);
  }

  /** A connected file by session id, exact name or unique partial name. */
  async find(name: string): Promise<SessionInfo> {
    const list = await this.sessions();
    const q = name.trim().toLowerCase();
    const hit =
      list.find((s) => s.id === name) ??
      list.find((s) => s.fileName.toLowerCase() === q) ??
      (list.filter((s) => s.fileName.toLowerCase().includes(q)).length === 1
        ? list.find((s) => s.fileName.toLowerCase().includes(q))
        : undefined);
    if (!hit) {
      const names = list.map((s) => `"${s.fileName}"`).join(", ") || "none";
      throw new BridgeError(`No unique connected file matches "${name}". Connected: ${names}.`, "NOT_FOUND");
    }
    return hit;
  }
}

// BridgeServer: the OmniCandi end of the plugin bridge (see protocol.ts for the rules).

import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  BRIDGE_PROTOCOL, BridgeError, MAX_FRAME_BYTES, MAX_RESULT_DATA_BYTES, clientFrame, clientProof, negotiate, proofEquals, serverProof,
  type ClientResult, type RejectCode, type ServerFrame,
} from './protocol';

export interface BridgeOptions {
  /** Where the current pipe name is announced for plugins (JSON). */
  endpointFile: string;
  /** Folder holding one `<pluginId>.json` per installed plugin: { secret }. A plugin without one cannot authenticate. */
  pairingDir: string;
  /** What each plugin may register. Null: unknown plugin (refused). */
  allowedCapabilities: (pluginId: string) => string[] | null;
  protocol?: { min: number; max: number };
  heartbeatMs?: number;
  authTimeoutMs?: number;
  /** Test hook: fixed pipe name. */
  pipeName?: string;
}

export interface SessionInfo {
  sessionId: string;
  pluginId: string;
  pluginVersion: string;
  appName: string;
  appVersion: string | null;
  edition: string | null;
  pid: number | null;
  protocol: number;
  /** Capabilities the plugin registered AND the installed manifest allows. */
  capabilities: string[];
  /** Capabilities the plugin asked for that the manifest does not allow (ignored, shown in Advanced). */
  refused: string[];
  registered: boolean;
  connectedAt: string;
}

export interface CallOptions { timeoutMs?: number; signal?: AbortSignal; onProgress?: (stage: string, fraction?: number) => void }
export interface CallResult { message: string; data?: Record<string, unknown>; evidence: string[]; verified: boolean }

interface Pending {
  resolve(r: CallResult): void;
  reject(e: Error): void;
  onProgress?: CallOptions['onProgress'];
  timer: NodeJS.Timeout;
  cancelTimer?: NodeJS.Timeout;
  health?: boolean;
}

class Session {
  info: SessionInfo;
  pending = new Map<string, Pending>();
  lastSeen = Date.now();
  registered = new Set<string>();
  ping = 0;
  heartbeat?: NodeJS.Timeout;
  constructor(readonly socket: net.Socket, info: SessionInfo) { this.info = info; }
}

export class BridgeServer extends EventEmitter {
  private server: net.Server | null = null;
  private sessions = new Map<string, Session>();
  private connections = new Set<net.Socket>();
  endpoint: string | null = null;

  constructor(private readonly o: BridgeOptions) { super(); }

  get running(): boolean { return !!this.server; }

  async start(): Promise<string> {
    if (this.server && this.endpoint) return this.endpoint;
    const name = this.o.pipeName ?? randomBytes(10).toString('hex');
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\createcraft-bridge-${name}` : path.join(os.tmpdir(), `createcraft-bridge-${name}.sock`);
    const server = net.createServer((s) => this.onConnection(s));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.off('error', reject); resolve(); }); });
    server.on('error', () => undefined);
    this.server = server;
    this.endpoint = endpoint;
    await fs.mkdir(path.dirname(this.o.endpointFile), { recursive: true });
    const tmp = `${this.o.endpointFile}.${randomBytes(3).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ pipe: endpoint, pid: process.pid, protocol: this.o.protocol ?? BRIDGE_PROTOCOL, startedAt: new Date().toISOString() }));
    await fs.rename(tmp, this.o.endpointFile);
    return endpoint;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.endpoint = null;
    for (const sess of [...this.sessions.values()]) this.closeSession(sess, 'OmniCandi is shutting down.');
    for (const c of this.connections) c.destroy();
    this.connections.clear();
    if (s) await new Promise<void>((r) => s.close(() => r()));
    await fs.rm(this.o.endpointFile, { force: true }).catch(() => undefined);
  }

  // ---- sessions ----

  session(pluginId: string): SessionInfo | null { return this.sessions.get(pluginId)?.info ?? null; }
  sessionList(): SessionInfo[] { return [...this.sessions.values()].map((s) => s.info); }

  /** Resolves with the plugin's session as soon as it has connected AND registered; null after `ms`. */
  waitForSession(pluginId: string, ms: number, signal?: AbortSignal): Promise<SessionInfo | null> {
    const now = this.sessions.get(pluginId);
    if (now?.info.registered) return Promise.resolve(now.info);
    return new Promise((resolve) => {
      const done = (v: SessionInfo | null) => { clearTimeout(t); this.off('session-ready', onReady); signal?.removeEventListener('abort', onAbort); resolve(v); };
      const onReady = (i: SessionInfo) => { if (i.pluginId === pluginId) done(i); };
      const onAbort = () => done(null);
      const t = setTimeout(() => done(null), ms);
      this.on('session-ready', onReady);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Ends a plugin's session (uninstall, disable). */
  disconnect(pluginId: string, reason = 'The add-in was turned off.'): void {
    const s = this.sessions.get(pluginId);
    if (s) this.closeSession(s, reason);
  }

  // ---- commands ----

  /** A real round trip through the plugin: it answers from inside the program's API context. */
  async health(pluginId: string, timeoutMs = 10_000): Promise<CallResult> {
    return this.send(pluginId, null, {}, { timeoutMs });
  }

  async call(pluginId: string, name: string, params: Record<string, string | number | boolean>, opts: CallOptions = {}): Promise<CallResult> {
    const s = this.sessions.get(pluginId);
    if (!s?.info.registered) throw new BridgeError('not-connected', 'The add-in is not connected. Open the program so its add-in can connect.');
    if (!s.registered.has(name)) throw new BridgeError('unsupported', `The add-in in ${s.info.appName} has not made "${name}" available${s.info.edition ? ` (${s.info.edition})` : ''}.`);
    if (Buffer.byteLength(JSON.stringify(params)) > 256 * 1024) throw new BridgeError('invalid-result', 'The command settings are too large.');
    return this.send(pluginId, name, params, opts);
  }

  private send(pluginId: string, name: string | null, params: Record<string, string | number | boolean>, opts: CallOptions): Promise<CallResult> {
    const s = this.sessions.get(pluginId);
    if (!s?.info.registered) return Promise.reject(new BridgeError('not-connected', 'The add-in is not connected. Open the program so its add-in can connect.'));
    const id = randomUUID();
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30_000, 500), 6 * 60 * 60 * 1000);
    return new Promise<CallResult>((resolve, reject) => {
      const cleanup = () => { clearTimeout(p.timer); if (p.cancelTimer) clearTimeout(p.cancelTimer); s.pending.delete(id); opts.signal?.removeEventListener('abort', onAbort); };
      const p: Pending = {
        resolve: (r) => { cleanup(); resolve(r); }, reject: (e) => { cleanup(); reject(e); }, onProgress: opts.onProgress, health: name === null,
        timer: setTimeout(() => { this.writeFrame(s, { t: 'cancel', id }); p.reject(new BridgeError('timeout', `The add-in did not answer within ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs),
      };
      const onAbort = () => {
        this.writeFrame(s, { t: 'cancel', id });
        // The plugin should stop and answer "cancelled"; if it does not, give up waiting after a short grace period.
        p.cancelTimer = setTimeout(() => p.reject(new BridgeError('cancelled', 'The operation was cancelled.')), 3000);
      };
      s.pending.set(id, p);
      if (opts.signal?.aborted) { onAbort(); return; }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.writeFrame(s, name === null ? { t: 'health', id } : { t: 'command', id, name, params, timeoutMs });
    });
  }

  // ---- connections ----

  private frame(s: net.Socket, f: ServerFrame): void { try { s.write(`${JSON.stringify(f)}\n`); } catch { /* closed */ } }
  private writeFrame(s: Session, f: ServerFrame): void { this.frame(s.socket, f); }

  private onConnection(socket: net.Socket): void {
    this.connections.add(socket);
    socket.setEncoding('utf8');
    const snonce = randomBytes(16).toString('hex');
    const offered = this.o.protocol ?? BRIDGE_PROTOCOL;
    let buf = '';
    let sess: Session | null = null;
    let authed = false;
    let chain: Promise<void> = Promise.resolve();
    const reject = (code: RejectCode, message: string) => { this.frame(socket, { t: 'reject', code, message }); socket.end(); };
    const authTimer = setTimeout(() => { if (!authed) reject('too-slow', 'No valid hello arrived in time.'); }, this.o.authTimeoutMs ?? 5000);
    this.frame(socket, { t: 'hello', product: 'createcraft', protocol: offered, nonce: snonce });

    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_FRAME_BYTES * 2) { socket.destroy(); return; }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        if (line.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
        // Frames of one connection are handled strictly in order (authentication awaits a file read).
        chain = chain.then(() => this.onLine(line, socket, snonce, offered, () => sess, (s) => { sess = s; authed = true; clearTimeout(authTimer); }, reject)).catch(() => { socket.destroy(); });
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(authTimer);
      this.connections.delete(socket);
      if (sess && this.sessions.get(sess.info.pluginId) === sess) this.closeSession(sess, 'The connection to the add-in was lost.', true);
    });
  }

  private async onLine(
    line: string, socket: net.Socket, snonce: string, offered: { min: number; max: number },
    getSess: () => Session | null, setSess: (s: Session) => void, reject: (c: RejectCode, m: string) => void,
  ): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { reject('malformed', 'Not valid JSON.'); return; }
    const parsed = clientFrame.safeParse(raw);
    const sess = getSess();
    if (!parsed.success) { if (sess) this.closeSession(sess, 'The add-in sent a frame OmniCandi does not accept.', true); else reject('malformed', 'Unexpected frame.'); return; }
    const f = parsed.data;
    if (!sess) {
      if (f.t !== 'hello') { reject('malformed', 'Expected hello.'); return; }
      // One uniform answer for "unknown plugin" and "wrong proof": nothing to probe.
      const fail = () => reject('auth-failed', 'Authentication failed.');
      const secret = await this.secretOf(f.pluginId);
      if (!secret || this.o.allowedCapabilities(f.pluginId) === null) { fail(); return; }
      if (!proofEquals(clientProof(secret, snonce, f.nonce, f.pluginId, f.protocol), f.proof)) { fail(); return; }
      const proto = negotiate(offered, f.protocol);
      if (proto === null) { reject('protocol-mismatch', `OmniCandi speaks bridge protocol ${offered.min}-${offered.max}; the add-in speaks ${f.protocol.min}-${f.protocol.max}. Update the add-in.`); return; }
      const old = this.sessions.get(f.pluginId);
      if (old) this.closeSession(old, 'A newer connection from the same add-in replaced this one.', false, 'replaced');
      const hb = this.o.heartbeatMs ?? 5000;
      const s = new Session(socket, {
        sessionId: randomUUID(), pluginId: f.pluginId, pluginVersion: f.pluginVersion, appName: f.app.name, appVersion: f.app.version, edition: f.app.edition ?? null,
        pid: f.app.pid ?? null, protocol: proto, capabilities: [], refused: [], registered: false, connectedAt: new Date().toISOString(),
      });
      this.sessions.set(f.pluginId, s);
      setSess(s);
      this.frame(socket, { t: 'welcome', protocol: proto, proof: serverProof(secret, snonce, f.nonce, f.pluginId, proto), sessionId: s.info.sessionId, heartbeatMs: hb });
      s.heartbeat = setInterval(() => {
        if (Date.now() - s.lastSeen > hb * 3) { this.closeSession(s, 'The add-in stopped answering.', true); return; }
        this.writeFrame(s, { t: 'ping', n: ++s.ping });
      }, hb);
      s.heartbeat.unref();
      return;
    }
    sess.lastSeen = Date.now();
    switch (f.t) {
      case 'hello': this.closeSession(sess, 'Unexpected second hello.', true); return;
      case 'pong': return;
      case 'register': {
        const allowed = new Set(this.o.allowedCapabilities(sess.info.pluginId) ?? []);
        const ok = [...new Set(f.capabilities)].filter((c) => allowed.has(c));
        sess.registered = new Set(ok);
        sess.info = { ...sess.info, capabilities: ok, refused: [...new Set(f.capabilities)].filter((c) => !allowed.has(c)), registered: true };
        this.emit('session-ready', sess.info);
        this.emit('session-change', sess.info);
        return;
      }
      case 'progress': sess.pending.get(f.id)?.onProgress?.(f.stage, f.fraction); return;
      case 'result': {
        const p = sess.pending.get(f.id);
        if (!p) return;
        this.settle(p, f);
        return;
      }
    }
  }

  private settle(p: Pending, f: ClientResult): void {
    if (!f.ok) {
      const k = f.error?.kind ?? 'app-error';
      p.reject(new BridgeError(k === 'cancelled' ? 'cancelled' : 'plugin-error', f.error?.message ?? f.message ?? 'The add-in reported an error.', k));
      return;
    }
    if (f.data && Buffer.byteLength(JSON.stringify(f.data)) > MAX_RESULT_DATA_BYTES) { p.reject(new BridgeError('invalid-result', 'The add-in returned more data than allowed.')); return; }
    p.resolve({ message: f.message ?? 'Done.', data: f.data, evidence: f.evidence ?? [], verified: f.verified === true });
  }

  private closeSession(s: Session, why: string, lost = false, code: RejectCode | null = null): void {
    if (this.sessions.get(s.info.pluginId) === s) this.sessions.delete(s.info.pluginId);
    if (s.heartbeat) clearInterval(s.heartbeat);
    for (const p of [...s.pending.values()]) p.reject(new BridgeError(lost ? 'connection-lost' : 'not-connected', lost ? 'The connection to the add-in was lost while the command ran. It may or may not have finished: check before repeating it.' : why));
    s.pending.clear();
    if (code) this.frame(s.socket, { t: 'reject', code, message: why }); else this.frame(s.socket, { t: 'bye', reason: why });
    s.socket.end();
    setTimeout(() => s.socket.destroy(), 500).unref();
    this.emit('session-closed', s.info, why);
    this.emit('session-change', { ...s.info, registered: false });
  }

  private async secretOf(pluginId: string): Promise<string | null> {
    try {
      const j = JSON.parse(await fs.readFile(path.join(this.o.pairingDir, `${pluginId}.json`), 'utf8')) as { secret?: string };
      return typeof j.secret === 'string' && /^[0-9a-f]{64}$/.test(j.secret) ? j.secret : null;
    } catch { return null; }
  }
}

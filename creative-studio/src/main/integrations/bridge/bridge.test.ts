// The plugin bridge over a REAL named pipe: authentication, version negotiation, capability registration, typed commands,
// progress, timeouts, cancellation, connection loss and recovery, and refusal of unauthenticated or malformed peers.

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BridgeError, clientProof } from './protocol';
import { BridgeServer } from './server';

const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { connectPlugin } = require_('../../../plugin-sdk/ccbridge-client.js') as { connectPlugin: (o: any) => { state: string; onState(l: (s: string, d?: string) => void): void; close(): void } };

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-bridge-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

const PLUGIN = 'test.plugin';
async function rig(o: { caps?: string[]; heartbeatMs?: number; protocol?: { min: number; max: number } } = {}) {
  const dir = await fs.mkdtemp(path.join(tmp, 'b-'));
  const secret = randomBytes(32).toString('hex');
  const pairingDir = path.join(dir, 'pairing');
  await fs.mkdir(pairingDir, { recursive: true });
  await fs.writeFile(path.join(pairingDir, `${PLUGIN}.json`), JSON.stringify({ secret }));
  const endpointFile = path.join(dir, 'endpoint.json');
  const server = new BridgeServer({ endpointFile, pairingDir, allowedCapabilities: (id) => (id === PLUGIN ? o.caps ?? ['echo', 'slow', 'hang', 'boom'] : null), heartbeatMs: o.heartbeatMs, protocol: o.protocol });
  await server.start();
  cleanup.push(() => server.stop());
  const configFile = path.join(dir, 'cc-bridge.json');
  await fs.writeFile(configFile, JSON.stringify({ pluginId: PLUGIN, secret, endpointFile }));
  return { dir, secret, server, endpointFile, configFile, pairingDir };
}

const executor = (fn: () => Promise<unknown>) => Promise.resolve().then(fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const handlers = {
  echo: async (p: Record<string, unknown>) => ({ message: `echo ${String(p.text)}`, data: { text: p.text }, evidence: ['echoed'], verified: true }),
  slow: async (_p: unknown, ctx: { signal: AbortSignal; progress(s: string, f?: number): void }) => {
    for (let i = 1; i <= 50; i++) {
      await new Promise<void>((res, rej) => { const t = setTimeout(res, 40); ctx.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('stopped')); }, { once: true }); });
      ctx.progress(`step ${i}`, i / 50);
    }
    return { message: 'finished' };
  },
  hang: () => new Promise(() => undefined),
  boom: async () => { throw Object.assign(new Error('the host refused'), { kind: 'app-error' }); },
};

function plugin(r: Awaited<ReturnType<typeof rig>>, extra: Record<string, unknown> = {}) {
  const c = connectPlugin({ configFile: r.configFile, app: { name: 'TestApp', version: '9.1', edition: 'Pro', pid: 4242 }, pluginVersion: '1.2.3', handlers, executor, ...extra });
  cleanup.push(() => c.close());
  return c;
}

describe('authentication and negotiation', () => {
  it('connects, authenticates both ways, and registers only what the manifest allows', async () => {
    const r = await rig({ caps: ['echo', 'slow'] });
    plugin(r, { capabilities: ['echo', 'slow', 'boom'] });
    const s = await r.server.waitForSession(PLUGIN, 5000);
    expect(s).toBeTruthy();
    expect(s!.appName).toBe('TestApp');
    expect(s!.appVersion).toBe('9.1');
    expect(s!.edition).toBe('Pro');
    expect(s!.pluginVersion).toBe('1.2.3');
    expect(s!.protocol).toBe(1);
    expect(s!.capabilities.sort()).toEqual(['echo', 'slow']);
    expect(s!.refused).toEqual(['boom']);
  });

  it('refuses a plugin with the wrong secret, and one it does not know, with the same answer', async () => {
    const r = await rig();
    await fs.writeFile(r.configFile, JSON.stringify({ pluginId: PLUGIN, secret: randomBytes(32).toString('hex'), endpointFile: r.endpointFile }));
    const bad = plugin(r);
    const seen: string[] = [];
    bad.onState((st, d) => seen.push(`${st}:${d ?? ''}`));
    await sleep(600);
    expect(r.server.session(PLUGIN)).toBeNull();
    expect(seen.join()).toMatch(/rejected:auth-failed: Authentication failed\./);
    const dir2 = await fs.mkdtemp(path.join(tmp, 'u-'));
    const cfg2 = path.join(dir2, 'cc-bridge.json');
    await fs.writeFile(cfg2, JSON.stringify({ pluginId: 'other.plugin', secret: randomBytes(32).toString('hex'), endpointFile: r.endpointFile }));
    const unknown = connectPlugin({ configFile: cfg2, app: { name: 'X', version: '1' }, handlers, executor });
    cleanup.push(() => unknown.close());
    const seen2: string[] = [];
    unknown.onState((st, d) => seen2.push(`${st}:${d ?? ''}`));
    await sleep(600);
    expect(seen2.join()).toMatch(/rejected:auth-failed: Authentication failed\./);
  });

  it('a fake server that does not know the secret is detected by the plugin', async () => {
    const dir = await fs.mkdtemp(path.join(tmp, 'f-'));
    const endpointFile = path.join(dir, 'endpoint.json');
    const pipe = `\\\\.\\pipe\\fake-${randomBytes(6).toString('hex')}`;
    const fake = net.createServer((s) => {
      s.setEncoding('utf8');
      s.write(`${JSON.stringify({ t: 'hello', product: 'createcraft', protocol: { min: 1, max: 1 }, nonce: '0'.repeat(32) })}\n`);
      s.on('data', (d: string) => { if (d.includes('"hello"')) s.write(`${JSON.stringify({ t: 'welcome', protocol: 1, proof: 'a'.repeat(64), sessionId: 'x', heartbeatMs: 5000 })}\n`); });
      s.on('error', () => undefined);
    });
    await new Promise<void>((res) => fake.listen(pipe, res));
    cleanup.push(() => new Promise<void>((res) => fake.close(() => res())));
    await fs.writeFile(endpointFile, JSON.stringify({ pipe }));
    const cfg = path.join(dir, 'cc-bridge.json');
    await fs.writeFile(cfg, JSON.stringify({ pluginId: PLUGIN, secret: randomBytes(32).toString('hex'), endpointFile }));
    const c = connectPlugin({ configFile: cfg, app: { name: 'X', version: '1' }, handlers, executor });
    cleanup.push(() => c.close());
    const seen: string[] = [];
    c.onState((st, d) => seen.push(`${st}:${d ?? ''}`));
    await sleep(500);
    expect(seen.join()).toMatch(/rejected:the server did not prove/);
  });

  it('rejects a protocol it cannot speak, saying what to update', async () => {
    const r = await rig();
    const c = plugin(r, { protocol: { min: 2, max: 3 } });
    const seen: string[] = [];
    c.onState((st, d) => seen.push(`${st}:${d ?? ''}`));
    await sleep(500);
    expect(r.server.session(PLUGIN)).toBeNull();
    expect(seen.join()).toMatch(/protocol-mismatch.*speaks bridge protocol 1-1/);
  });

  it('negotiates the highest common version', async () => {
    const r = await rig({ protocol: { min: 1, max: 3 } });
    plugin(r, { protocol: { min: 2, max: 5 } });
    expect((await r.server.waitForSession(PLUGIN, 3000))!.protocol).toBe(3);
  });

  it('closes raw peers that skip authentication, send garbage, or send oversized frames', async () => {
    const r = await rig();
    const pipe = r.server.endpoint!;
    const talk = (send: string) => new Promise<string>((resolve) => {
      const s = net.connect(pipe);
      let got = '';
      s.setEncoding('utf8');
      s.on('data', (d: string) => { got += d; });
      s.on('connect', () => s.write(send));
      s.on('close', () => resolve(got));
      s.on('error', () => resolve(got));
      setTimeout(() => { s.destroy(); }, 1500);
    });
    const cmd = await talk(`${JSON.stringify({ t: 'result', id: 'x', ok: true })}\n`);
    expect(cmd).toMatch(/"t":"reject"/);
    const junk = await talk('this is not json\n');
    expect(junk).toMatch(/"code":"malformed"/);
    const big = await talk(`${'x'.repeat(2 * 1024 * 1024)}\n`);
    expect(big).not.toMatch(/welcome/);
    expect(r.server.sessionList()).toEqual([]);
  });

  it('closes a peer that never says hello', async () => {
    const r = await rig();
    const fast = new BridgeServer({ endpointFile: path.join(r.dir, 'e2.json'), pairingDir: r.pairingDir, allowedCapabilities: () => ['echo'], authTimeoutMs: 200 });
    await fast.start();
    cleanup.push(() => fast.stop());
    const out = await new Promise<string>((resolve) => { const s = net.connect(fast.endpoint!); let g = ''; s.setEncoding('utf8'); s.on('data', (d: string) => { g += d; }); s.on('close', () => resolve(g)); s.on('error', () => resolve(g)); });
    expect(out).toMatch(/too-slow/);
  });

  it('the proof binds the nonces: a replayed proof from another connection does not authenticate', async () => {
    const r = await rig();
    const proofFor = (sn: string, cn: string) => clientProof(r.secret, sn, cn, PLUGIN, { min: 1, max: 1 });
    const first = await new Promise<{ nonce: string; proof: string }>((resolve) => {
      const s = net.connect(r.server.endpoint!); s.setEncoding('utf8');
      s.on('data', (d: string) => { const f = JSON.parse(d.split('\n')[0]!) as { nonce: string }; resolve({ nonce: f.nonce, proof: proofFor(f.nonce, 'a'.repeat(32)) }); s.destroy(); });
    });
    const replay = await new Promise<string>((resolve) => {
      const s = net.connect(r.server.endpoint!); s.setEncoding('utf8'); let g = '';
      s.on('data', (d: string) => {
        g += d;
        if (d.includes('"hello"')) s.write(`${JSON.stringify({ t: 'hello', protocol: { min: 1, max: 1 }, pluginId: PLUGIN, pluginVersion: '1', nonce: 'a'.repeat(32), proof: first.proof, app: { name: 'X', version: null } })}\n`);
      });
      s.on('close', () => resolve(g)); s.on('error', () => resolve(g));
    });
    expect(replay).toMatch(/auth-failed/);
    expect(replay).not.toMatch(/welcome/);
  });
});

describe('commands', () => {
  it('runs a typed command and returns a structured result', async () => {
    const r = await rig();
    plugin(r);
    await r.server.waitForSession(PLUGIN, 5000);
    const res = await r.server.call(PLUGIN, 'echo', { text: 'hello "quoted" \\ ; & | $(calc)' });
    expect(res.message).toBe('echo hello "quoted" \\ ; & | $(calc)');
    expect(res.data).toEqual({ text: 'hello "quoted" \\ ; & | $(calc)' });
    expect(res.verified).toBe(true);
    expect(res.evidence).toEqual(['echoed']);
  });

  it('answers a health check from inside the executor', async () => {
    const r = await rig();
    plugin(r, { health: async () => ({ ok: true, detail: 'inside the program' }) });
    await r.server.waitForSession(PLUGIN, 5000);
    expect((await r.server.health(PLUGIN)).message).toBe('inside the program');
  });

  it('refuses a capability the plugin did not register and one it never declared', async () => {
    const r = await rig({ caps: ['echo'] });
    plugin(r, { capabilities: ['echo'] });
    await r.server.waitForSession(PLUGIN, 5000);
    await expect(r.server.call(PLUGIN, 'slow', {})).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(r.server.call('nobody', 'echo', {})).rejects.toMatchObject({ kind: 'not-connected' });
  });

  it('reports plugin errors with their kind', async () => {
    const r = await rig();
    plugin(r);
    await r.server.waitForSession(PLUGIN, 5000);
    await expect(r.server.call(PLUGIN, 'boom', {})).rejects.toMatchObject({ kind: 'plugin-error', pluginKind: 'app-error', message: 'the host refused' });
  });

  it('streams progress', async () => {
    const r = await rig();
    plugin(r);
    await r.server.waitForSession(PLUGIN, 5000);
    const seen: Array<[string, number | undefined]> = [];
    const ac = new AbortController();
    const p = r.server.call(PLUGIN, 'slow', {}, { signal: ac.signal, onProgress: (s, f) => { seen.push([s, f]); if (seen.length === 3) ac.abort(); } });
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[0]![0]).toBe('step 1');
    expect(seen[1]![1]).toBeCloseTo(0.04);
  });

  it('cancels a running command: the plugin is told and stops', async () => {
    const r = await rig();
    let stopped = false;
    plugin(r, { handlers: { ...handlers, slow: async (_p: unknown, ctx: { signal: AbortSignal }) => { await new Promise<void>((res) => ctx.signal.addEventListener('abort', () => { stopped = true; res(); }, { once: true })); throw new Error('stopped'); } } });
    await r.server.waitForSession(PLUGIN, 5000);
    const ac = new AbortController();
    const p = r.server.call(PLUGIN, 'slow', {}, { signal: ac.signal });
    await sleep(100);
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    expect(stopped).toBe(true);
  });

  it('times out a command that never answers and sends a cancel', async () => {
    const r = await rig();
    let cancelled = false;
    plugin(r, { handlers: { ...handlers, hang: (_p: unknown, ctx: { signal: AbortSignal }) => new Promise(() => { ctx.signal.addEventListener('abort', () => { cancelled = true; }); }) } });
    await r.server.waitForSession(PLUGIN, 5000);
    await expect(r.server.call(PLUGIN, 'hang', {}, { timeoutMs: 600 })).rejects.toMatchObject({ kind: 'timeout' });
    await sleep(100);
    expect(cancelled).toBe(true);
  });

  it('a command in flight when the connection drops fails as connection-lost, not as success', async () => {
    const r = await rig();
    const c = plugin(r);
    await r.server.waitForSession(PLUGIN, 5000);
    const p = r.server.call(PLUGIN, 'slow', {});
    await sleep(120);
    r.server['sessions'].get(PLUGIN)!.socket.destroy();
    await expect(p).rejects.toMatchObject({ kind: 'connection-lost' });
    expect(c).toBeTruthy();
  });

  it('the plugin reconnects by itself after a lost connection and works again', async () => {
    const r = await rig();
    plugin(r);
    const first = await r.server.waitForSession(PLUGIN, 5000);
    r.server['sessions'].get(PLUGIN)!.socket.destroy();
    await sleep(100);
    expect(r.server.session(PLUGIN)).toBeNull();
    const second = await r.server.waitForSession(PLUGIN, 8000);
    expect(second).toBeTruthy();
    expect(second!.sessionId).not.toBe(first!.sessionId);
    expect((await r.server.call(PLUGIN, 'echo', { text: 'again' })).message).toBe('echo again');
  });

  it('reconnects after OmniCandy itself restarts (new pipe name)', async () => {
    const r = await rig();
    plugin(r);
    await r.server.waitForSession(PLUGIN, 5000);
    await r.server.stop();
    expect(r.server.session(PLUGIN)).toBeNull();
    await r.server.start();
    const s = await r.server.waitForSession(PLUGIN, 10000);
    expect(s).toBeTruthy();
  });

  it('a newer connection from the same plugin replaces the older one', async () => {
    const r = await rig();
    plugin(r);
    const a = await r.server.waitForSession(PLUGIN, 5000);
    plugin(r);
    await sleep(500);
    const b = r.server.session(PLUGIN);
    expect(b).toBeTruthy();
    expect(b!.sessionId).not.toBe(a!.sessionId);
  });

  it('ends the session of a plugin that stops answering heartbeats', async () => {
    const r = await rig({ heartbeatMs: 100 });
    // A raw peer that authenticates correctly, registers, and then goes silent: no pongs.
    await new Promise<void>((resolve) => {
      const s = net.connect(r.server.endpoint!); s.setEncoding('utf8');
      s.on('data', (d: string) => {
        for (const line of d.split(String.fromCharCode(10)).filter(Boolean)) {
          const f = JSON.parse(line) as { t: string; nonce?: string };
          if (f.t === 'hello') s.write(JSON.stringify({ t: 'hello', protocol: { min: 1, max: 1 }, pluginId: PLUGIN, pluginVersion: '1', nonce: 'b'.repeat(32), proof: clientProof(r.secret, f.nonce!, 'b'.repeat(32), PLUGIN, { min: 1, max: 1 }), app: { name: 'Frozen', version: null } }) + String.fromCharCode(10));
          if (f.t === 'welcome') { s.write(JSON.stringify({ t: 'register', capabilities: ['echo'] }) + String.fromCharCode(10)); resolve(); }
        }
      });
      s.on('error', () => undefined);
      cleanup.push(() => { s.destroy(); });
    });
    expect((await r.server.waitForSession(PLUGIN, 3000))?.appName).toBe('Frozen');
    await sleep(900);
    expect(r.server.session(PLUGIN)).toBeNull();
  });

  it('rejects an oversized result instead of passing it on', async () => {
    const r = await rig();
    plugin(r, { handlers: { ...handlers, echo: async () => ({ message: 'big', data: { blob: 'x'.repeat(100_000) } }) } });
    await r.server.waitForSession(PLUGIN, 5000);
    await expect(r.server.call(PLUGIN, 'echo', {})).rejects.toMatchObject({ kind: 'invalid-result' });
  });

  it('BridgeError carries a stable kind', () => {
    expect(new BridgeError('timeout', 'x').kind).toBe('timeout');
  });
});

// Runs an installed adapter package in a CHILD PROCESS and exposes it as an ExternalAdapter.
//
// Isolation, stated precisely:
//  * Process isolation: package code never runs in CreateCraft's main process. A crash, a hang or a runaway
//    loop only ends the child; the manager reports it and the next call starts a fresh child.
//  * Node permission model (`--permission`): the child may READ only its own package folder and may not
//    write files, spawn processes, load native addons or start worker threads (the OS refuses, with
//    ERR_ACCESS_DENIED). Everything else it wants goes through host operations below, which check the
//    permissions the user actually approved for the command that is running.
//  * This is NOT an operating-system sandbox: the child still runs as the same Windows user and Node's
//    permission model does not restrict network access. That is why unsigned packages are asked about on
//    every run and why packages are always labelled experimental.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AdapterManifest, CommandSpec, DiscoveredApp, Permission, TrustLevel } from '@shared/integrations';
import { runProcess } from './process';
import { pluginHealth } from './bridge/bridgeAdapter';
import type { PluginLink } from './bridge/link';
import { AdapterError, type AdapterFactory, type AdapterOutcome, type ExecuteContext, type ExternalAdapter, type HealthResult, type ProbeResult } from './sdk';
import { safeEntryName } from './zip';

/** The child's bootstrap. Plain ES5-style JavaScript on purpose: it is passed with `-e`, so it needs no file. */
const RUNNER_SOURCE = String.raw`
'use strict';
var mod = null, appInfo = null, waiting = new Map(), seq = 0, active = null;
function send(m) { try { process.send(m); } catch (e) { process.exit(1); } }
function hostOp(op, args) {
  return new Promise(function (resolve, reject) {
    var id = ++seq;
    waiting.set(id, { resolve: resolve, reject: reject });
    send({ t: 'host', id: id, op: op, args: args });
  });
}
function b64(d) { return Buffer.isBuffer(d) ? d.toString('base64') : Buffer.from(String(d), 'utf8').toString('base64'); }
function makeCtx(ac) {
  return {
    app: appInfo,
    signal: ac.signal,
    progress: function (stage, fraction) { send({ t: 'progress', stage: String(stage).slice(0, 200), fraction: typeof fraction === 'number' ? fraction : null }); },
    runApp: function (args, o) { return hostOp('runApp', { args: args, timeoutMs: o && o.timeoutMs }); },
    workDir: function () { return hostOp('workDir', {}); },
    writeFile: function (name, data) { return hostOp('writeFile', { name: name, data: b64(data) }); },
    readFile: function (name) { return hostOp('readFile', { name: name }).then(function (s) { return Buffer.from(s, 'base64'); }); },
    plugin: {
      call: function (name, params) { return hostOp('pluginCall', { name: name, params: params || {} }); },
      capabilities: function () { return hostOp('pluginCaps', {}); }
    },
    error: function (kind, message) { var e = new Error(message); e.kind = kind; return e; }
  };
}
process.on('uncaughtException', function (e) { send({ t: 'fatal', message: String(e && e.stack || e) }); process.exit(1); });
process.on('unhandledRejection', function (e) { send({ t: 'fatal', message: String(e && e.stack || e) }); process.exit(1); });
process.on('message', function (m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'init') {
    try { mod = require(m.entry); appInfo = m.app; send({ t: 'ready', exports: Object.keys(mod || {}) }); }
    catch (e) { send({ t: 'initError', message: String(e && e.message || e) }); }
  } else if (m.t === 'hostResult') {
    var w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.ok) w.resolve(m.value); else w.reject(new Error(m.error));
  } else if (m.t === 'cancel') {
    if (active) active.abort();
  } else if (m.t === 'call') {
    var ac = new AbortController();
    active = ac;
    var fn = mod && mod[m.method];
    Promise.resolve().then(function () {
      if (typeof fn !== 'function') {
        if (m.method === 'disconnect') return null;
        throw new Error('the adapter does not implement ' + m.method);
      }
      var c = makeCtx(ac);
      return m.method === 'execute' ? fn(m.command, m.params, c) : fn(c);
    }).then(
      function (v) { send({ t: 'result', id: m.id, ok: true, value: v === undefined ? null : v }); },
      function (e) { send({ t: 'result', id: m.id, ok: false, error: { message: String(e && e.message || e).slice(0, 2000), kind: e && e.kind } }); }
    ).then(function () { if (active === ac) active = null; });
  }
});
`;

const ADAPTER_ERROR_KINDS = new Set(['app-error', 'unsupported', 'invalid-params', 'missing-app', 'verification-failed']);
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 3;
const MAX_FILE = 32 * 1024 * 1024;

export interface PackageFactoryOptions {
  manifest: AdapterManifest;
  /** Absolute path of the entry script inside the installed package. */
  entry: string;
  /** Installed package folder: the only place the child may read. */
  pkgDir: string;
  /** Per-adapter storage (not shared with other adapters). */
  dataDir: string;
  trust: TrustLevel;
  /** Permissions the user approved at install. */
  approved: Permission[];
  /** Process to run the script with (default: this process's executable, as Node). */
  execPath?: string;
  /** Called when the child dies unexpectedly (crash accounting is also kept here). */
  onCrash?: (count: number) => void;
  /** Hybrid integrations: the authenticated link to the plugin inside the program. */
  plugin?: PluginLink;
}

/** Crash counters are per installed adapter, shared by every child it ever starts. */
class CrashLog {
  private times: number[] = [];
  record(): number { const now = Date.now(); this.times = [...this.times.filter((t) => now - t < CRASH_WINDOW_MS), now]; return this.times.length; }
  recent(): number { const now = Date.now(); return this.times.filter((t) => now - t < CRASH_WINDOW_MS).length; }
  reset(): void { this.times = []; }
}

export function makePackageFactory(o: PackageFactoryOptions): AdapterFactory {
  const crashes = new CrashLog();
  const selfContained = !!o.manifest.selfContained;
  return {
    manifest: o.manifest,
    permissionCeiling: [...o.approved],
    deferProbe: o.trust === 'unsigned',
    alwaysAsk: o.trust === 'unsigned',
    anchorPath: selfContained ? o.entry : undefined,
    reset: () => crashes.reset(),
    create: () => new PackageAdapter(o, crashes),
  };
}

interface Pending { resolve(v: unknown): void; reject(e: Error): void; progress?: (stage: string, fraction?: number) => void }
interface Current { perms: Set<Permission>; workDir: string | null; app: DiscoveredApp; signal: AbortSignal; progress?: Pending['progress'] }

export class PackageAdapter implements ExternalAdapter {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private ready: Promise<void> | null = null;
  private app: DiscoveredApp | null = null;
  private cur: Current | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stderrTail = '';
  private disposed = false;

  constructor(private readonly o: PackageFactoryOptions, private readonly crashes: CrashLog) {}

  // ---- ExternalAdapter ----

  /** Every call to the child runs one at a time: host operations are checked against the call in flight. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async probe(app: DiscoveredApp): Promise<ProbeResult> {
    const r = await this.serial(() => this.call<{ version?: string | null; detail?: string } | null>('probe', {}, app, { perms: this.lifecyclePerms(), workDir: null }));
    return { version: typeof r?.version === 'string' ? r.version : null, detail: r?.detail };
  }

  async connect(app: DiscoveredApp): Promise<void> {
    if (this.crashes.recent() >= CRASH_LIMIT) throw new Error(`${this.o.manifest.name} stopped ${CRASH_LIMIT} times in a row and was turned off. Use Repair to try again.`);
    await this.serial(() => this.call('connect', {}, app, { perms: this.lifecyclePerms(), workDir: null }));
  }

  async healthCheck(): Promise<HealthResult> {
    if (!this.app) throw new Error('not connected');
    const app = this.app;
    const r = await this.serial(() => this.call<{ ok?: boolean; detail?: string; state?: HealthResult['state'] } | null>('healthCheck', {}, app, { perms: this.lifecyclePerms(), workDir: null }));
    const state = r?.state === 'not-running' || r?.state === 'api-unavailable' ? r.state : undefined;
    const own: HealthResult = { ok: !!r?.ok, detail: String(r?.detail ?? (r?.ok ? 'ok' : 'The adapter reported a problem.')).slice(0, 500), state };
    // Hybrid: the connector alone proves nothing. The add-in inside the program must answer a real check too.
    if (own.ok && this.o.plugin) {
      const p = await pluginHealth(this.o.plugin, this.o.manifest.name);
      return p.ok ? { ok: true, detail: `${own.detail} ${p.detail}`.slice(0, 500) } : p;
    }
    return own;
  }

  async execute(command: CommandSpec, params: Record<string, string | number | boolean>, ctx: ExecuteContext): Promise<AdapterOutcome> {
    return this.serial(async () => {
      if (ctx.signal.aborted) throw new AdapterError('app-error', 'The operation was cancelled.');
      const approved = new Set(this.o.approved);
      const perms = new Set(command.permissions.filter((p) => approved.has(p)));
      const v = await this.call<Record<string, unknown> | null>('execute', { command: command.id, params }, ctx.app, { perms, workDir: ctx.workDir, signal: ctx.signal, progress: ctx.progress });
      return this.toOutcome(v, ctx.workDir);
    });
  }

  async disconnect(): Promise<void> {
    const app = this.app;
    if (this.child && app) await this.serial(() => this.call('disconnect', {}, app, { perms: new Set(), workDir: null })).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const c = this.child;
    this.child = null;
    this.ready = null;
    if (c) { try { c.kill(); } catch { /* gone */ } }
    for (const p of this.pending.values()) p.reject(new Error('The adapter was shut down.'));
    this.pending.clear();
  }

  // ---- plumbing ----

  private lifecyclePerms(): Set<Permission> { return new Set((['read-info'] as Permission[]).filter((p) => this.o.approved.includes(p))); }

  private toOutcome(v: Record<string, unknown> | null, workDir: string): AdapterOutcome {
    if (!v || typeof v !== 'object') throw new AdapterError('app-error', 'The adapter returned nothing.');
    const outputs: string[] = [];
    for (const raw of Array.isArray(v.outputs) ? v.outputs : []) {
      if (typeof raw !== 'string') throw new AdapterError('verification-failed', 'The adapter listed an output that is not a file name.');
      const abs = path.resolve(workDir, raw);
      if (!abs.startsWith(workDir + path.sep)) throw new AdapterError('verification-failed', `The adapter claimed an output outside its work folder: ${raw}`);
      outputs.push(abs);
    }
    return {
      message: String(v.message ?? 'Done.').slice(0, 1000),
      outputs,
      data: v.data && typeof v.data === 'object' ? (v.data as Record<string, unknown>) : undefined,
      evidence: Array.isArray(v.evidence) ? v.evidence.filter((e): e is string => typeof e === 'string').slice(0, 20) : undefined,
      verified: v.verified === true,
    };
  }

  private async start(app: DiscoveredApp): Promise<void> {
    if (this.disposed) throw new Error('The adapter was shut down.');
    if (this.child && this.ready) return this.ready;
    this.app = app;
    const nodeFlags = ['--permission', `--allow-fs-read=${this.o.pkgDir}${path.sep}*`, '--max-old-space-size=256'];
    await fs.mkdir(this.o.dataDir, { recursive: true });
    const child = spawn(this.o.execPath ?? process.execPath, [...nodeFlags, '-e', RUNNER_SOURCE], {
      // Not the package folder: a child's working directory is locked on Windows and would block updates.
      cwd: this.o.dataDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // A minimal environment: no inherited API keys, tokens or proxies reach third-party code.
      env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot ?? '', windir: process.env.windir ?? '' },
    });
    this.child = child;
    this.stderrTail = '';
    child.stderr?.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
    child.stdout?.on('data', () => undefined);
    child.on('message', (m) => this.onMessage(m as Record<string, unknown>));
    child.on('error', (e) => this.onExit(child, `could not start: ${e.message}`));
    child.on('exit', (code, sig) => this.onExit(child, `exited unexpectedly (${sig ?? `code ${code}`})`));
    this.ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The adapter did not start within 10 seconds.')), 10_000);
      this.pending.set(0, { resolve: () => { clearTimeout(t); resolve(); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
    child.send({ t: 'init', entry: this.o.entry, app: { name: app.name, version: app.version, exePath: this.o.manifest.selfContained ? null : app.exePath } });
    return this.ready;
  }

  private onExit(child: ChildProcess, why: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    const expected = this.disposed;
    const tail = this.stderrTail.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
    const err = new Error(`${this.o.manifest.name} adapter process ${why}${tail ? `: ${tail}` : ''}`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    if (!expected) this.o.onCrash?.(this.crashes.record());
  }

  private onMessage(m: Record<string, unknown>): void {
    const t = m.t;
    if (t === 'ready') { this.pending.get(0)?.resolve(undefined); this.pending.delete(0); return; }
    if (t === 'initError' || t === 'fatal') {
      const e = new Error(`${this.o.manifest.name} adapter failed: ${String(m.message).slice(0, 400)}`);
      const p0 = this.pending.get(0);
      if (p0) { this.pending.delete(0); p0.reject(e); }
      return;
    }
    if (t === 'progress') {
      for (const [id, p] of this.pending) if (id !== 0 && p.progress) p.progress(String(m.stage ?? ''), typeof m.fraction === 'number' ? m.fraction : undefined);
      return;
    }
    if (t === 'result') {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      if (m.ok) p.resolve(m.value);
      else {
        const e = m.error as { message?: string; kind?: string } | undefined;
        const kind = e?.kind && ADAPTER_ERROR_KINDS.has(e.kind) ? (e.kind as ConstructorParameters<typeof AdapterError>[0]) : 'app-error';
        p.reject(new AdapterError(kind, String(e?.message ?? 'The adapter reported an error.')));
      }
      return;
    }
    if (t === 'host') void this.onHost(m as { id: number; op: string; args: Record<string, unknown> });
  }

  private async call<T>(method: string, extra: Record<string, unknown>, app: DiscoveredApp, scope: { perms: Set<Permission>; workDir: string | null; signal?: AbortSignal; progress?: Pending['progress'] }): Promise<T> {
    await this.start(app);
    const child = this.child;
    if (!child) throw new Error(`${this.o.manifest.name} adapter process is not running.`);
    const id = ++this.seq;
    this.cur = { perms: scope.perms, workDir: scope.workDir, app, signal: scope.signal ?? new AbortController().signal, progress: scope.progress };
    const abort = () => {
      try { child.send({ t: 'cancel' }); } catch { /* gone */ }
      // A well-behaved adapter stops by itself; otherwise the child is ended so it cannot keep working.
      setTimeout(() => { if (this.pending.has(id)) { try { child.kill(); } catch { /* gone */ } } }, 3000).unref();
    };
    scope.signal?.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress: scope.progress });
        child.send({ t: 'call', id, method, ...extra });
      });
    } finally {
      scope.signal?.removeEventListener('abort', abort);
      this.pending.delete(id);
      this.cur = null;
    }
  }

  /** Host operations the child may request. Each one re-checks the permission of the command in flight. */
  private async onHost(m: { id: number; op: string; args: Record<string, unknown> }): Promise<void> {
    const reply = (ok: boolean, value: unknown, error?: string) => { try { this.child?.send({ t: 'hostResult', id: m.id, ok, value, error }); } catch { /* gone */ } };
    const cur = this.cur;
    try {
      if (!cur) throw new Error('No command is running.');
      const has = (...p: Permission[]) => p.some((x) => cur.perms.has(x));
      if (m.op === 'runApp') {
        if (this.o.manifest.selfContained) throw new Error('This adapter has no application to run.');
        if (!has('execute-scripts', 'launch', 'read-info')) throw new Error('Running the application needs the "Run scripts inside the application", "Start the application" or "Read application information" permission, which this command does not have.');
        const args = m.args.args;
        if (!Array.isArray(args) || args.length > 64 || args.some((a) => typeof a !== 'string' || a.length > 8192 || a.includes('\0'))) throw new Error('Arguments must be up to 64 strings.');
        const asked = typeof m.args.timeoutMs === 'number' ? m.args.timeoutMs : 60_000;
        const r = await runProcess(cur.app.exePath, args as string[], {
          timeoutMs: Math.min(Math.max(asked, 1000), 10 * 60_000), label: this.o.manifest.name, signal: cur.signal,
          cwd: cur.workDir ?? this.o.dataDir,
          env: { SystemRoot: process.env.SystemRoot ?? '', windir: process.env.windir ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '', PATH: process.env.PATH ?? '' },
        });
        reply(true, { code: r.code, out: r.out.slice(-64_000), err: r.err.slice(-16_000) });
      } else if (m.op === 'workDir') {
        if (!cur.workDir) throw new Error('The work folder exists only while a command runs.');
        reply(true, cur.workDir);
      } else if (m.op === 'writeFile') {
        if (!cur.workDir) throw new Error('Files can only be written while a command runs.');
        if (!has('write-files')) throw new Error('Writing files needs the "Write or export files" permission, which this command does not have.');
        const dest = this.inWorkDir(cur.workDir, String(m.args.name));
        const data = Buffer.from(String(m.args.data ?? ''), 'base64');
        if (data.length > MAX_FILE) throw new Error('The file is too large.');
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, data);
        reply(true, { bytes: data.length });
      } else if (m.op === 'readFile') {
        if (!cur.workDir) throw new Error('Files can only be read while a command runs.');
        if (!has('read-project')) throw new Error('Reading files needs the "Read project data" permission, which this command does not have.');
        const src = this.inWorkDir(cur.workDir, String(m.args.name));
        const st = await fs.stat(src);
        if (!st.isFile() || st.size > MAX_FILE) throw new Error('That is not a readable file.');
        reply(true, (await fs.readFile(src)).toString('base64'));
      } else if (m.op === 'pluginCaps') {
        const link = this.o.plugin;
        if (!link) throw new Error('This integration has no add-in inside the program.');
        reply(true, link.session()?.capabilities ?? []);
      } else if (m.op === 'pluginCall') {
        const link = this.o.plugin;
        if (!link) throw new Error('This integration has no add-in inside the program.');
        const name = String(m.args.name ?? '');
        const need = link.declared.get(name);
        if (!need) throw new Error(`"${name}" is not one of the add-in's declared capabilities.`);
        const missing = need.filter((p) => !cur.perms.has(p));
        if (missing.length) throw new Error(`The add-in capability "${name}" needs permissions this command does not have: ${missing.join(', ')}.`);
        const params = m.args.params;
        if (!params || typeof params !== 'object' || Array.isArray(params) || Object.values(params).some((v) => !['string', 'number', 'boolean'].includes(typeof v))) throw new Error('Add-in settings must be text, numbers or true/false.');
        const r = await link.call(name, params as Record<string, string | number | boolean>, { signal: cur.signal, onProgress: (stage, fraction) => cur.progress?.(stage, fraction) });
        reply(true, r);
      } else throw new Error(`Unknown host operation "${m.op}".`);
    } catch (e) {
      reply(false, null, e instanceof Error ? e.message : String(e));
    }
  }

  private inWorkDir(workDir: string, rel: string): string {
    safeEntryName(rel);
    const abs = path.resolve(workDir, rel);
    if (!abs.startsWith(workDir + path.sep)) throw new Error('The path leaves the work folder.');
    return abs;
  }
}

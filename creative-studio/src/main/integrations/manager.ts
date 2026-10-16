// IntegrationManager: the one engine for external applications. Discovery, adapter lifecycle,
// permissions, parameter validation, timeouts, cancellation, output verification and an audit log.
// Adapters can fail or hang without taking CreateCraft down: every adapter call is guarded.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ADAPTER_SDK_VERSION, METHOD_PREFERENCE, versionSupported,
  type AdapterManifest, type ApprovalAnswer, type ApprovalRequest, type CommandErrorKind, type CommandResult, type CommandSpec,
  type DiscoveredApp, type ExternalAppInfo, type ExternalScan, type IntegrationStatus, type Permission, type ProgressEvent,
} from '@shared/integrations';
import { discoverApps, realDiscoveryEnv, type DiscoveryEnv } from './discovery';
import { AdapterError, validateManifest, type AdapterFactory, type ExternalAdapter } from './sdk';

export interface PermissionStore { load(): Promise<Record<string, Permission[]>>; save(grants: Record<string, Permission[]>): Promise<void> }

export interface ManagerDeps {
  /** Folder for an application's outputs and temporary files (inside the open project). */
  workDir: (adapterId: string) => Promise<string>;
  permissions: PermissionStore;
  /** Asks the user (native dialog). Anything but 'once' or 'always' counts as no. */
  approve: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  discovery?: DiscoveryEnv;
  userPaths?: () => Promise<string[]>;
  onProgress?: (e: ProgressEvent) => void;
}

interface Session { app: DiscoveredApp; adapter: ExternalAdapter; factory: AdapterFactory; version: string | null }
export interface AuditEntry { at: string; app: string; command: string; ok: boolean; kind?: CommandErrorKind; ms: number }

export type ScanResult = ExternalScan;

const DEFAULT_TIMEOUT = 120_000;

export class IntegrationManager {
  private factories = new Map<string, AdapterFactory>();
  private apps = new Map<string, DiscoveredApp>();
  private versions = new Map<string, string | null>();
  private broken = new Map<string, string>();
  /** Why a healthy-looking program could not be driven (not running / scripting unreachable). */
  private blocked = new Map<string, { status: 'not-running' | 'api-unavailable'; detail: string }>();
  private sessions = new Map<string, Session>();
  private ops = new Map<string, AbortController>();
  private grants: Record<string, Permission[]> | null = null;
  private audit: AuditEntry[] = [];

  constructor(private readonly d: ManagerDeps) {}

  // ---- registration (plugin loading) ----

  register(f: AdapterFactory): void {
    const problems = validateManifest(f.manifest, ADAPTER_SDK_VERSION);
    if (problems.length) throw new Error(`Adapter ${f.manifest.id} rejected: ${problems.join('; ')}`);
    if (this.factories.has(f.manifest.id)) throw new Error(`Adapter ${f.manifest.id} is already registered.`);
    this.factories.set(f.manifest.id, f);
  }

  manifests(): AdapterManifest[] { return [...this.factories.values()].map((f) => f.manifest); }
  log(): AuditEntry[] { return [...this.audit]; }

  private factoryFor(app: DiscoveredApp): AdapterFactory | null {
    const exe = path.basename(app.exePath).toLowerCase();
    return [...this.factories.values()].find((f) => f.manifest.exeNames.some((e) => e.toLowerCase() === exe)) ?? null;
  }

  // ---- discovery ----

  async scan(): Promise<ScanResult> {
    const targets = this.manifests().map((m) => ({ exeNames: m.exeNames, displayNames: m.displayNames }));
    const found = await discoverApps(targets, this.d.discovery ?? realDiscoveryEnv, await (this.d.userPaths?.() ?? Promise.resolve([])));
    this.apps = new Map(found.map((a) => [a.key, a]));
    for (const a of found) {
      const f = this.factoryFor(a);
      if (!f || this.versions.has(a.key)) continue;
      const probe = f.create();
      try {
        const r = await withTimeout(probe.probe(a), 20_000, 'version check');
        this.versions.set(a.key, r.version ?? a.version);
        this.broken.delete(a.key);
      } catch (e) {
        this.versions.set(a.key, a.version);
        this.broken.set(a.key, errMsg(e));
      } finally { await probe.dispose().catch(() => undefined); }
    }
    const matched = new Set(found.map((a) => this.factoryFor(a)?.manifest.id));
    return {
      apps: await Promise.all(found.map((a) => this.info(a))),
      missing: this.manifests().filter((m) => !matched.has(m.id)).map((m) => ({ adapterId: m.id, name: m.name, vendor: m.vendor, maturity: m.maturity })),
    };
  }

  /** Adds a user-chosen executable (portable copy) and rescans. */
  async list(): Promise<ExternalAppInfo[]> { return Promise.all([...this.apps.values()].map((a) => this.info(a))); }

  private async grantsFor(key: string): Promise<Permission[]> {
    this.grants ??= await this.d.permissions.load().catch(() => ({}));
    return this.grants[key] ?? [];
  }

  private async info(a: DiscoveredApp): Promise<ExternalAppInfo> {
    const f = this.factoryFor(a);
    const m = f?.manifest ?? null;
    const version = this.versions.get(a.key) ?? a.version;
    const base: ExternalAppInfo = {
      ...a, version, adapterId: m?.id ?? null, adapterName: m?.name ?? null, maturity: m?.maturity ?? null,
      methods: m ? [...m.methods].sort((x, y) => METHOD_PREFERENCE.indexOf(x) - METHOD_PREFERENCE.indexOf(y)) : [],
      status: 'detected', statusDetail: 'Found on this PC.', commands: m?.commands ?? [],
      granted: await this.grantsFor(a.key), permissionsNeeded: [...new Set((m?.commands ?? []).flatMap((c) => c.permissions))],
      notes: m?.notes ?? null,
    };
    const set = (status: IntegrationStatus, statusDetail: string) => ({ ...base, status, statusDetail });
    if (!m) return set('unsupported', 'No adapter for this program yet.');
    if (m.maturity === 'stub') return set('unsupported', 'Detected. Deep integration is planned but not built yet; no commands are offered.');
    const range = versionSupported(version, m.versions);
    if (range === 'too-old') return set('incompatible', `Version ${version} is older than the supported ${m.versions.min}.`);
    if (range === 'too-new') return set('incompatible', `Version ${version} is newer than the tested ${m.versions.max}.`);
    const blocked = this.blocked.get(a.key);
    if (blocked && !this.sessions.has(a.key)) return set(blocked.status, blocked.detail);
    const broken = this.broken.get(a.key);
    if (broken) return set('needs-repair', `Could not read the program: ${broken}`);
    if (this.sessions.has(a.key)) return set(m.maturity === 'experimental' ? 'limited' : 'connected', m.maturity === 'experimental' ? 'Connected, experimental adapter.' : 'Connected and healthy.');
    return set('available', range === 'unknown' ? 'Ready to connect (version could not be read).' : 'Ready to connect.');
  }

  // ---- lifecycle ----

  async connect(key: string): Promise<ExternalAppInfo> {
    const app = this.apps.get(key);
    if (!app) throw new Error('That application is not in the list. Rescan first.');
    const f = this.factoryFor(app);
    if (!f) throw new Error('No adapter for this application.');
    if (f.manifest.maturity === 'stub') throw new Error('This adapter is a placeholder and cannot connect yet.');
    const info = await this.info(app);
    if (info.status === 'incompatible') throw new Error(info.statusDetail);
    if (!this.sessions.has(key)) {
      const adapter = f.create();
      try {
        const probe = await withTimeout(adapter.probe(app), 20_000, 'version check');
        this.versions.set(key, probe.version ?? app.version);
        await withTimeout(adapter.connect(app), 30_000, 'connect');
        const h = await withTimeout(adapter.healthCheck(), 30_000, 'health check');
        if (!h.ok) {
          if (h.state) { this.blocked.set(key, { status: h.state, detail: h.detail }); throw new BlockedError(h.detail); }
          throw new Error(h.detail);
        }
        this.broken.delete(key);
        this.blocked.delete(key);
        this.sessions.set(key, { app, adapter, factory: f, version: probe.version });
      } catch (e) {
        // A blocked program is not "broken": keep the precise status, do not ask for repair.
        if (!(e instanceof BlockedError)) { this.broken.set(key, errMsg(e)); this.blocked.delete(key); }
        await adapter.dispose().catch(() => undefined);
        throw e;
      }
    }
    return this.info(app);
  }

  async disconnect(key: string): Promise<ExternalAppInfo | null> {
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    if (s) { await s.adapter.disconnect().catch(() => undefined); await s.adapter.dispose().catch(() => undefined); }
    const app = this.apps.get(key);
    return app ? this.info(app) : null;
  }

  /** Drops the session and the remembered failure, then connects again. */
  async repair(key: string): Promise<ExternalAppInfo> {
    await this.disconnect(key);
    this.broken.delete(key);
    this.blocked.delete(key);
    this.versions.delete(key);
    return this.connect(key);
  }

  async shutdown(): Promise<void> {
    for (const c of this.ops.values()) c.abort();
    await Promise.all([...this.sessions.keys()].map((k) => this.disconnect(k)));
  }

  async revoke(key: string): Promise<void> {
    this.grants ??= await this.d.permissions.load().catch(() => ({}));
    delete this.grants[key];
    await this.d.permissions.save(this.grants);
  }

  cancel(opId: string): boolean {
    const c = this.ops.get(opId);
    c?.abort();
    return !!c;
  }

  // ---- execution ----

  async execute(key: string, commandId: string, raw: Record<string, unknown> = {}): Promise<CommandResult> {
    const t0 = Date.now();
    const done = (r: Omit<CommandResult, 'durationMs'>, app?: string): CommandResult => {
      this.audit.push({ at: new Date().toISOString(), app: app ?? key, command: commandId, ok: r.ok, kind: r.error?.kind, ms: Date.now() - t0 });
      if (this.audit.length > 200) this.audit.shift();
      return { ...r, durationMs: Date.now() - t0 };
    };
    const fail = (kind: CommandErrorKind, message: string, app?: string) =>
      done({ ok: false, verified: false, message, evidence: [], outputs: [], error: { kind, message } }, app);

    const app = this.apps.get(key);
    if (!app) return fail('missing-app', 'That application is not installed or was not found. Rescan the applications.');
    if (!(await fs.stat(app.exePath).then(() => true, () => false))) return fail('missing-app', `${app.name} is no longer at ${app.exePath}. Rescan the applications.`, app.name);
    const f = this.factoryFor(app);
    if (!f) return fail('unsupported', `${app.name} has no integration adapter.`, app.name);
    const cmd = f.manifest.commands.find((c) => c.id === commandId);
    if (!cmd || !f.manifest.capabilities.includes('executeCommand')) {
      return fail('unsupported', `${f.manifest.name} does not support "${commandId}". Supported: ${f.manifest.commands.map((c) => c.id).join(', ') || 'none'}.`, app.name);
    }
    const params = validateParams(cmd, raw);
    if (typeof params === 'string') return fail('invalid-params', params, app.name);

    // Permissions: ask for what is not granted yet, and always for destructive commands.
    const granted = new Set(await this.grantsFor(key));
    const needed = cmd.permissions.filter((p) => !granted.has(p));
    if (needed.length || cmd.destructive) {
      const answer = await this.d.approve({ app: await this.info(app), command: cmd, params, needed, destructive: !!cmd.destructive }).catch(() => 'deny' as const);
      if (answer === 'deny') return fail('permission-denied', 'The user did not allow this. Do not ask again unless they bring it up.', app.name);
      if (answer === 'always' && !cmd.destructive) {
        for (const p of needed) granted.add(p);
        this.grants = { ...(this.grants ?? {}), [key]: [...granted] };
        await this.d.permissions.save(this.grants).catch(() => undefined);
      }
    }

    let session = this.sessions.get(key);
    if (!session) {
      try { await this.connect(key); session = this.sessions.get(key); } catch (e) { return fail('not-connected', `Could not connect to ${app.name}: ${errMsg(e)}`, app.name); }
    }
    if (!session) return fail('not-connected', `${app.name} is not connected.`, app.name);

    const opId = randomUUID();
    const ac = new AbortController();
    this.ops.set(opId, ac);
    const timeoutMs = cmd.timeoutMs ?? DEFAULT_TIMEOUT;
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    try {
      const workDir = await this.d.workDir(f.manifest.id);
      await fs.mkdir(workDir, { recursive: true });
      const out = await raceAbort(session.adapter.execute(cmd, params, {
        app, workDir, signal: ac.signal,
        progress: (stage, fraction) => this.d.onProgress?.({ opId, appKey: key, commandId, stage, fraction }),
      }), ac.signal);
      // The manager's own verification: every claimed output must exist and not be empty.
      const outputs: CommandResult['outputs'] = [];
      const evidence = [...(out.evidence ?? [])];
      for (const p of out.outputs) {
        const st = await fs.stat(p).catch(() => null);
        if (!st || !st.isFile() || st.size === 0) {
          return done({ ok: false, verified: false, message: `${f.manifest.name} reported success but ${path.basename(p)} was not created.`, evidence, outputs: [], error: { kind: 'verification-failed', message: `Missing or empty output: ${p}` } }, app.name);
        }
        outputs.push({ path: p, bytes: st.size, kind: path.extname(p).slice(1).toLowerCase() });
        evidence.push(`${path.basename(p)} exists (${st.size} bytes)`);
      }
      return done({ ok: true, verified: outputs.length > 0 || !!out.verified, message: out.message, evidence, outputs, data: out.data }, app.name);
    } catch (e) {
      if (ac.signal.aborted) {
        const timedOut = (ac.signal.reason as Error | undefined)?.message === 'timeout';
        return fail(timedOut ? 'timeout' : 'cancelled', timedOut ? `${app.name} did not finish within ${Math.round(timeoutMs / 1000)} s.` : 'The operation was cancelled.', app.name);
      }
      if (e instanceof AdapterError) return fail(e.kind, e.message, app.name);
      // An unexpected adapter failure ends the session so the next call starts clean.
      await this.disconnect(key);
      return fail('internal', `${f.manifest.name} adapter failed: ${errMsg(e)}`, app.name);
    } finally {
      clearTimeout(timer);
      this.ops.delete(opId);
    }
  }
}

class BlockedError extends Error {}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/** Returns coerced params, or a message when something is wrong. Unknown keys are rejected. */
export function validateParams(cmd: CommandSpec, raw: Record<string, unknown>): Record<string, string | number | boolean> | string {
  const out: Record<string, string | number | boolean> = {};
  for (const k of Object.keys(raw)) if (!(k in cmd.params)) return `Unknown setting "${k}" for ${cmd.id}. Allowed: ${Object.keys(cmd.params).join(', ') || 'none'}.`;
  for (const [k, spec] of Object.entries(cmd.params)) {
    let v = raw[k];
    if (v === undefined || v === null || v === '') {
      if (spec.required && spec.default === undefined) return `"${k}" is required for ${cmd.id}.`;
      if (spec.default !== undefined) out[k] = spec.default;
      continue;
    }
    if (spec.type === 'number') {
      v = typeof v === 'string' ? Number(v) : v;
      if (typeof v !== 'number' || !Number.isFinite(v)) return `"${k}" must be a number.`;
      if (spec.min !== undefined && v < spec.min) return `"${k}" must be at least ${spec.min}.`;
      if (spec.max !== undefined && v > spec.max) return `"${k}" must be at most ${spec.max}.`;
    } else if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') return `"${k}" must be true or false.`;
    } else if (typeof v !== 'string' || v.length > 512) return `"${k}" must be text (up to 512 characters).`;
    out[k] = v as string | number | boolean;
  }
  return out;
}

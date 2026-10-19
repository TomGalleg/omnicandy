// IntegrationManager: the one engine for external applications. Discovery, adapter lifecycle,
// permissions, parameter validation, timeouts, cancellation, output verification and an audit log.
// Adapters can fail or hang without taking OmniCandi down: every adapter call is guarded.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ADAPTER_SDK_VERSION, METHOD_PREFERENCE, PERMISSION_LABEL, versionSupported,
  type AdapterManifest, type ApprovalAnswer, type ApprovalRequest, type CommandErrorKind, type CommandResult, type CommandSpec,
  type DiscoveredApp, type ExternalAppInfo, type ExternalScan, type IntegrationStatus, type JobInfo, type Permission, type ProgressEvent,
} from '@shared/integrations';
import { discoverApps, REMEMBERED_SOURCES, realDiscoveryEnv, type DiscoveryEnv, type DiscoveryTarget } from './discovery';
import { AdapterError, validateManifest, type AdapterFactory, type ExternalAdapter } from './sdk';
import { currentOs, DEFAULT_PLATFORMS, OS_LABEL, supportsOs, type OsId } from '@shared/platform';

const listOs = (p: readonly OsId[] | undefined) => (p?.length ? p : DEFAULT_PLATFORMS).map((o) => OS_LABEL[o]).join(' and ');

export interface PermissionStore { load(): Promise<Record<string, Permission[]>>; save(grants: Record<string, Permission[]>): Promise<void> }

export interface ManagerDeps {
  /** Folder for an application's outputs and temporary files (inside the open project). */
  workDir: (adapterId: string) => Promise<string>;
  permissions: PermissionStore;
  /** Asks the user (native dialog). Anything but 'once' or 'always' counts as no. */
  approve: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  discovery?: DiscoveryEnv;
  /** Test hook: pretend to be another operating system. Default: the real one. */
  os?: OsId;
  userPaths?: () => Promise<string[]>;
  /** Programs to look for although no adapter for them is active yet (connectors that can be installed). */
  extraTargets?: () => Promise<DiscoveryTarget[]>;
  /** Program locations found through indirect signals (uninstall records, shortcuts), kept so they survive those records. */
  remembered?: { load: () => Promise<string[]>; save: (paths: string[]) => Promise<void> };
  /** Applications the user has connected, kept across restarts so they are connected again at startup. */
  connected?: { load: () => Promise<string[]>; save: (keys: string[]) => Promise<void> };
  onProgress?: (e: ProgressEvent) => void;
}

interface Session { app: DiscoveredApp; adapter: ExternalAdapter; factory: AdapterFactory; version: string | null }
export interface AuditEntry { at: string; app: string; command: string; ok: boolean; kind?: CommandErrorKind; ms: number }

export type ScanResult = ExternalScan;

const DEFAULT_TIMEOUT = 120_000;
const MAX_FINISHED_JOBS = 50;
const SELF_CONTAINED_PREFIX = 'package:';

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
  private builtin = new Set<AdapterFactory>();
  /** Placeholder (stub) adapters replaced by a real one; restored when it is removed. */
  private shadowed = new Map<string, AdapterFactory[]>();
  private jobMap = new Map<string, JobInfo>();

  private readonly os: OsId;
  constructor(private readonly d: ManagerDeps) { this.os = d.os ?? currentOs(); }

  // ---- registration (plugin loading) ----

  /**
   * Adds an adapter. A real adapter may replace a placeholder (stub) with the same id or the same program;
   * it can never replace another real adapter. `builtin` adapters cannot be unregistered.
   */
  register(f: AdapterFactory, opts: { builtin?: boolean } = {}): void {
    const problems = validateManifest(f.manifest, ADAPTER_SDK_VERSION);
    if (problems.length) throw new Error(`Adapter ${f.manifest.id} rejected: ${problems.join('; ')}`);
    const exes = new Set(f.manifest.exeNames.map((e) => e.toLowerCase()));
    const replaced: AdapterFactory[] = [];
    for (const other of this.factories.values()) {
      const sameId = other.manifest.id === f.manifest.id;
      const sameExe = other.manifest.exeNames.some((e) => exes.has(e.toLowerCase()));
      if (!sameId && !sameExe) continue;
      if (other.manifest.maturity === 'stub' && f.manifest.maturity !== 'stub') { replaced.push(other); continue; }
      throw new Error(sameId ? `Adapter ${f.manifest.id} is already registered.` : `Adapter ${f.manifest.id} drives the same program as ${other.manifest.id}, which already handles it.`);
    }
    // The replaced placeholder's entries ("Unsupported") must disappear at once, not at the next scan.
    for (const o of replaced) { this.dropApps(o); this.factories.delete(o.manifest.id); }
    if (replaced.length) this.shadowed.set(f.manifest.id, replaced);
    this.factories.set(f.manifest.id, f);
    if (opts.builtin) this.builtin.add(f);
  }

  /** Removes an installed (non built-in) adapter: ends its sessions and jobs and restores any placeholder it replaced. */
  async unregister(id: string): Promise<void> {
    if (this.isBuiltin(id)) throw new Error('Built-in adapters cannot be removed.');
    const f = this.factories.get(id);
    if (!f) return;
    for (const [jobId, j] of this.jobMap) {
      const app = this.apps.get(j.appKey);
      if (j.status === 'running' && app && this.factoryFor(app) === f) this.ops.get(jobId)?.abort();
    }
    for (const [key, s] of [...this.sessions]) if (s.factory === f) await this.disconnect(key);
    this.dropApps(f);
    this.factories.delete(id);
    for (const o of this.shadowed.get(id) ?? []) this.factories.set(o.manifest.id, o);
    this.shadowed.delete(id);
  }

  /** Forgets every discovered application that `f` handles (call before `f` leaves the registry). */
  private dropApps(f: AdapterFactory): void {
    for (const [key, a] of [...this.apps]) {
      if (this.factoryFor(a) === f) { this.apps.delete(key); this.versions.delete(key); this.broken.delete(key); this.blocked.delete(key); }
    }
  }

  isBuiltin(id: string): boolean { const f = this.factories.get(id); return !!f && this.builtin.has(f); }
  manifests(): AdapterManifest[] { return [...this.factories.values()].map((f) => f.manifest); }
  factory(id: string): AdapterFactory | null { return this.factories.get(id) ?? null; }
  log(): AuditEntry[] { return [...this.audit]; }

  private factoryFor(app: DiscoveredApp): AdapterFactory | null {
    if (app.key.startsWith(SELF_CONTAINED_PREFIX)) return this.factories.get(app.key.slice(SELF_CONTAINED_PREFIX.length)) ?? null;
    const exe = path.basename(app.exePath).toLowerCase();
    return [...this.factories.values()].find((f) => f.manifest.exeNames.some((e) => e.toLowerCase() === exe)) ?? null;
  }

  // ---- discovery ----

  async scan(): Promise<ScanResult> {
    const targets: DiscoveryTarget[] = this.manifests().filter((m) => !m.selfContained).map((m) => ({ exeNames: m.exeNames, displayNames: m.displayNames }));
    targets.push(...await (this.d.extraTargets?.() ?? Promise.resolve([])).catch(() => [] as DiscoveryTarget[]));
    const remembered = await (this.d.remembered?.load() ?? Promise.resolve([])).catch(() => [] as string[]);
    const discovered = await discoverApps(targets, this.d.discovery ?? realDiscoveryEnv, await (this.d.userPaths?.() ?? Promise.resolve([])), remembered);
    // Keep what indirect signals found, so the program is still recognised when its uninstall record or shortcut goes away.
    if (this.d.remembered) {
      const add = discovered.filter((a) => (REMEMBERED_SOURCES as readonly string[]).includes(a.source)).map((a) => a.exePath).filter((p) => !remembered.some((r) => r.toLowerCase() === p.toLowerCase()));
      if (add.length) await this.d.remembered.save([...remembered, ...add].slice(-100)).catch(() => undefined);
    }
    // Self-contained adapters have no program to find: they are listed directly.
    const own: DiscoveredApp[] = [...this.factories.values()].filter((f) => f.manifest.selfContained && f.anchorPath).map((f) => ({
      key: SELF_CONTAINED_PREFIX + f.manifest.id, name: f.manifest.name, publisher: f.manifest.vendor, version: f.manifest.version ?? null,
      exePath: f.anchorPath!, installType: 'installed' as const, source: 'user' as const,
    }));
    const found = [...discovered, ...own];
    this.apps = new Map(found.map((a) => [a.key, a]));
    for (const a of found) {
      const f = this.factoryFor(a);
      if (!f || this.versions.has(a.key)) continue;
      // Not meant for this operating system: its code is never run, not even to read a version.
      if (!supportsOs(f.manifest.platforms, this.os)) { this.versions.set(a.key, a.version); continue; }
      if (f.manifest.selfContained) { this.versions.set(a.key, f.manifest.version ?? null); continue; }
      // Unsigned packages do not run until the user presses Connect.
      if (f.deferProbe) { this.versions.set(a.key, a.version); continue; }
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
      missing: this.manifests().filter((m) => !m.selfContained && !matched.has(m.id)).map((m) => ({ adapterId: m.id, name: m.name, vendor: m.vendor, maturity: m.maturity })),
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
      adapterVersion: m?.version ?? null, origin: m?.source ?? (m ? 'built-in' : null), trust: m?.trust ?? (m ? 'built-in' : null),
      requirements: m?.requirements ?? [], selfContained: !!m?.selfContained,
    };
    const set = (status: IntegrationStatus, statusDetail: string) => ({ ...base, status, statusDetail });
    if (!m) return set('unsupported', 'No adapter for this program yet.');
    if (m.maturity === 'stub') return set('unsupported', 'Detected. Deep integration is planned but not built yet; no commands are offered.');
    if (!supportsOs(m.platforms, this.os)) return set('incompatible', `${m.name} is not available on ${OS_LABEL[this.os]}: its integration was only built and tested for ${listOs(m.platforms)}.`);
    const range = m.selfContained ? 'ok' : versionSupported(version, m.versions, m.versionRanges);
    const supported = m.versionRanges?.length ? m.versionRanges.map((r) => `${r.min ?? ''}-${r.max ?? ''}`).join(', ') : `${m.versions.min ?? ''}-${m.versions.max ?? ''}`;
    if (range === 'too-old') return set('incompatible', `Version ${version} is older than the supported ${supported}.`);
    if (range === 'too-new') return set('incompatible', `Version ${version} is newer than the supported ${supported}.`);
    const blocked = this.blocked.get(a.key);
    if (blocked && !this.sessions.has(a.key)) return set(blocked.status, blocked.detail);
    const broken = this.broken.get(a.key);
    if (broken) return set('needs-repair', `Could not read the program: ${broken}`);
    if (this.sessions.has(a.key)) return set(m.maturity === 'experimental' ? 'limited' : 'connected', m.maturity === 'experimental' ? 'Connected, experimental adapter.' : 'Connected and healthy.');
    return set('available', range === 'unknown' ? 'Ready to connect (version could not be read).' : 'Ready to connect.');
  }

  // ---- lifecycle ----

  /** Connects in progress, so a second request for the same program waits for the first instead of starting another adapter. */
  private connecting = new Map<string, Promise<ExternalAppInfo>>();

  connect(key: string): Promise<ExternalAppInfo> {
    const running = this.connecting.get(key);
    if (running) return running;
    const p = this.connectNow(key).finally(() => { if (this.connecting.get(key) === p) this.connecting.delete(key); });
    this.connecting.set(key, p);
    return p;
  }

  private async connectNow(key: string): Promise<ExternalAppInfo> {
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
        const probe = f.manifest.selfContained ? { version: f.manifest.version ?? null } : await withTimeout(adapter.probe(app), 20_000, 'version check');
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
        void this.remember(key, true);
      } catch (e) {
        // A blocked program is not "broken": keep the precise status, do not ask for repair.
        if (!(e instanceof BlockedError)) { this.broken.set(key, errMsg(e)); this.blocked.delete(key); }
        await adapter.dispose().catch(() => undefined);
        throw e;
      }
    }
    return this.info(app);
  }

  /**
   * Checks a connected application again with the adapter's own health check (a real, tiny run of the program) and
   * reports what it found. Used to confirm a connection before it is called a success; changes nothing.
   */
  async verify(key: string): Promise<{ ok: boolean; detail: string; version: string | null }> {
    const s = this.sessions.get(key);
    if (!s) return { ok: false, detail: 'Not connected.', version: null };
    try {
      const h = await withTimeout(s.adapter.healthCheck(), 30_000, 'health check');
      if (!h.ok && h.state) this.blocked.set(key, { status: h.state, detail: h.detail });
      return { ok: h.ok, detail: h.detail, version: this.versions.get(key) ?? s.version };
    } catch (e) {
      return { ok: false, detail: errMsg(e), version: this.versions.get(key) ?? s.version };
    }
  }

  /** Keeps the list of connected applications on disk (best effort; a failed write never breaks a connection). */
  private async remember(key: string, on: boolean): Promise<void> {
    if (!this.d.connected) return;
    try {
      const cur = await this.d.connected.load();
      const next = on ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter((k) => k !== key);
      if (next.length !== cur.length) await this.d.connected.save(next);
    } catch { /* not remembered */ }
  }

  /** Connects again every application that was connected when OmniCandi last ran. Failures are quiet: the app just shows as available. */
  async autoConnect(): Promise<void> {
    if (!this.d.connected) return;
    const keys = await this.d.connected.load().catch(() => [] as string[]);
    if (!keys.length) return;
    if (!this.apps.size) await this.scan().catch(() => undefined);
    for (const key of keys) if (this.apps.has(key) && !this.sessions.has(key)) await this.connect(key).catch(() => undefined);
  }

  /** `forget: false` closes the session but keeps the app in the remembered list (OmniCandi quitting, repairs). */
  async disconnect(key: string, opts: { forget?: boolean } = {}): Promise<ExternalAppInfo | null> {
    if (opts.forget !== false) await this.remember(key, false);
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    if (s) { await s.adapter.disconnect().catch(() => undefined); await s.adapter.dispose().catch(() => undefined); }
    const app = this.apps.get(key);
    return app ? this.info(app) : null;
  }

  /** Drops the session and the remembered failure, then connects again. */
  async repair(key: string): Promise<ExternalAppInfo> {
    await this.disconnect(key, { forget: false });
    const app = this.apps.get(key);
    if (app) this.factoryFor(app)?.reset?.();
    this.broken.delete(key);
    this.blocked.delete(key);
    this.versions.delete(key);
    return this.connect(key);
  }

  async shutdown(): Promise<void> {
    for (const c of this.ops.values()) c.abort();
    await Promise.all([...this.sessions.keys()].map((k) => this.disconnect(k, { forget: false })));
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

  // ---- jobs (long-running operations) ----

  jobs(): JobInfo[] { return [...this.jobMap.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)); }
  job(id: string): JobInfo | null { return this.jobMap.get(id) ?? null; }
  /** Cancels a running job. The job record keeps the final "cancelled" result. */
  cancelJob(id: string): boolean {
    const j = this.jobMap.get(id);
    return !!j && j.status === 'running' && this.cancel(id);
  }

  /**
   * Runs one command. With `background` (or a command marked longRunning) the user is asked and the adapter is
   * connected first, then a job handle is returned at once; the result arrives on the job.
   */
  async execute(key: string, commandId: string, raw: Record<string, unknown> = {}, opts: { background?: boolean } = {}): Promise<CommandResult> {
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
    if (!supportsOs(f.manifest.platforms, this.os)) return fail('unsupported', `${f.manifest.name} is not available on ${OS_LABEL[this.os]}; nothing was run.`, app.name);
    const cmd = f.manifest.commands.find((c) => c.id === commandId);
    if (!cmd || !f.manifest.capabilities.includes('executeCommand')) {
      return fail('unsupported', `${f.manifest.name} does not support "${commandId}". Supported: ${f.manifest.commands.map((c) => c.id).join(', ') || 'none'}.`, app.name);
    }
    if (!supportsOs(cmd.platforms ?? f.manifest.platforms, this.os)) return fail('unsupported', `"${commandId}" is not available on ${OS_LABEL[this.os]}; nothing was run.`, app.name);
    const live = f.availableCommands?.();
    if (live && !live.has(cmd.id)) return fail('unsupported', `The add-in inside ${app.name} has not made "${commandId}" available (this version or edition of the program may not support it). Available now: ${[...live].join(', ') || 'none'}.`, app.name);
    const params = validateParams(cmd, raw);
    if (typeof params === 'string') return fail('invalid-params', params, app.name);

    // An installed package can never exceed what the user approved when installing it, whatever its manifest says.
    if (f.permissionCeiling) {
      const over = cmd.permissions.filter((p) => !f.permissionCeiling!.includes(p));
      if (over.length) return fail('permission-denied', `${f.manifest.name} was not allowed to use: ${over.map((p) => PERMISSION_LABEL[p].toLowerCase()).join(', ')}. Update or reinstall the integration to review its permissions.`, app.name);
    }

    // Permissions: ask for what is not granted yet, always for destructive commands and for unsigned packages.
    const granted = new Set(await this.grantsFor(key));
    const needed = cmd.permissions.filter((p) => !granted.has(p));
    if (needed.length || cmd.destructive || f.alwaysAsk) {
      const answer = await this.d.approve({ app: await this.info(app), command: cmd, params, needed, destructive: !!cmd.destructive, untrusted: !!f.alwaysAsk }).catch(() => 'deny' as const);
      if (answer === 'deny') return fail('permission-denied', 'The user did not allow this. Do not ask again unless they bring it up.', app.name);
      if (answer === 'always' && !cmd.destructive && !f.alwaysAsk) {
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
    const background = opts.background ?? !!cmd.longRunning;
    const activeSession = session;
    const runIt = async (): Promise<CommandResult> => {
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    try {
      const workDir = await this.d.workDir(f.manifest.id);
      await fs.mkdir(workDir, { recursive: true });
      const out = await raceAbort(activeSession.adapter.execute(cmd, params, {
        app, workDir, signal: ac.signal,
        progress: (stage, fraction) => {
          const j = this.jobMap.get(opId);
          if (j) { j.stage = stage; if (fraction !== undefined) j.fraction = fraction; }
          this.d.onProgress?.({ opId, appKey: key, commandId, stage, fraction });
        },
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
      // The program stays in the remembered list, so it is connected again at the next start.
      await this.disconnect(key, { forget: false });
      return fail('internal', `${f.manifest.name} adapter failed: ${errMsg(e)}`, app.name);
    } finally {
      clearTimeout(timer);
      this.ops.delete(opId);
    }
    };

    if (!background) return runIt();
    const job: JobInfo = { id: opId, appKey: key, appName: app.name, commandId, status: 'running', stage: 'Starting', fraction: null, startedAt: new Date().toISOString(), finishedAt: null, result: null };
    this.jobMap.set(opId, job);
    void runIt().then((r) => {
      job.result = r;
      job.status = r.ok ? 'succeeded' : r.error?.kind === 'cancelled' ? 'cancelled' : 'failed';
      job.finishedAt = new Date().toISOString();
      job.fraction = r.ok ? 1 : job.fraction;
      const finished = [...this.jobMap.values()].filter((j) => j.status !== 'running').sort((a, b) => (a.finishedAt! < b.finishedAt! ? -1 : 1));
      for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) this.jobMap.delete(old.id);
    });
    return {
      ok: true, verified: false, evidence: [], outputs: [], durationMs: Date.now() - t0,
      message: `Started "${cmd.label}" in ${app.name} as job ${opId}. It runs in the background; check it with the job id.`,
      data: { jobId: opId, status: 'running' },
    };
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

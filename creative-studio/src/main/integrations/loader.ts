// Connects the package store to the integration manager: installed, verified and enabled packages are
// registered as adapters; disabling, updating or removing one unregisters it again. Built-in adapters
// are never touched.
//
// Universal Installation Manager: one entry point for the three integration types.
//   external  adapter process only                (PackageStore + restricted runner)
//   internal  plugin inside the program only      (PluginInstaller + plugin bridge)
//   hybrid    both, talking over the bridge       (all of the above, installed and removed together)
// A failure in either half undoes the other; nothing is called connected until a real round trip succeeded.

import path from 'node:path';
import { compareVersions, type InstalledAdapter, type PackageApproval, type PackageListing, type PackageReview, type PluginState } from '@shared/integrations';
import { BridgeServer } from './bridge/server';
import { makeBridgeFactory } from './bridge/bridgeAdapter';
import { makePluginLink, type PluginLink } from './bridge/link';
import { PluginInstaller, InstallError } from './install/pluginInstaller';
import { profileById, type InstallEnv } from './install/hostProfiles';
import { anyRunning } from './install/processes';
import type { IntegrationManager } from './manager';
import { integrationTypeOf, parsePackage, readPackageSource, toAdapterManifest, type PackageManifest } from './packageFormat';
import { makePackageFactory } from './packageRunner';
import { PackageError, PackageStore, type VerifiedInstall } from './packageStore';

export interface PackageExtras {
  installer?: PluginInstaller;
  bridge?: BridgeServer;
  /** Fingerprints of official release keys that ship inside the application (never a development key). */
  bundledPublishers?: () => string[];
  /** Folder / variable overrides (tests and the simulated application). */
  installEnv?: InstallEnv;
  /** Test hook: is the host program open? Defaults to a task-list check. */
  isRunning?: (names: string[]) => Promise<boolean>;
  elevator?: import('./install/pluginInstaller').Elevator;
}

const lower = (s: string) => s.toLowerCase();

export class AdapterPackages {
  readonly store: PackageStore;
  readonly installer: PluginInstaller;
  readonly bridge: BridgeServer;
  private crashDisabled = new Set<string>();
  /** Failures to load at startup or after an action, per adapter id (shown in Settings). */
  private loadErrors = new Map<string, string>();
  /** pluginId -> what its installed manifest lets it register. The bridge refuses everything else. */
  private pluginCaps = new Map<string, string[]>();
  private pluginOf = new Map<string, string>();
  private bridgeReady: Promise<unknown> | null = null;

  constructor(root: string, private readonly manager: IntegrationManager, private readonly execPath?: string, extras: PackageExtras = {}) {
    this.store = new PackageStore(root, { conflicts: (m) => this.conflicts(m), bundledPublishers: extras.bundledPublishers });
    const bridgeDir = path.join(root, 'bridge');
    const bridgeFiles = { endpointFile: path.join(bridgeDir, 'endpoint.json'), pairingDir: path.join(bridgeDir, 'pairing') };
    this.bridge = extras.bridge ?? new BridgeServer({ ...bridgeFiles, allowedCapabilities: (id) => this.pluginCaps.get(id) ?? null });
    this.installer = extras.installer ?? new PluginInstaller(root, {
      env: extras.installEnv ?? { vars: { ...process.env }, simHostRoot: path.join(root, 'simcad') },
      isRunning: extras.isRunning ?? anyRunning, hostSessionActive: (id) => !!this.bridge.session(id)?.registered, elevator: extras.elevator, bridge: bridgeFiles,
    });
    // The first successful connection after an install is what clears "restart the program".
    this.bridge.on('session-ready', (s: { pluginId: string }) => { const pkg = this.pluginOf.get(s.pluginId); if (pkg) void this.installer.clearRestart(pkg); });
  }

  /** The bridge's allow-list is this object's; a bridge built by the caller must use it too. */
  allowedCapabilities = (pluginId: string): string[] | null => this.pluginCaps.get(pluginId) ?? null;

  private ensureBridge(): Promise<unknown> {
    this.bridgeReady ??= this.bridge.start().catch((e) => { this.bridgeReady = null; throw e; });
    return this.bridgeReady;
  }

  /** Does registering this manifest clash with a real adapter other than the package's own earlier version? */
  private conflicts(m: PackageManifest): string[] {
    const out: string[] = [];
    const exes = new Set((m.application.exeNames ?? []).map((e) => e.toLowerCase()));
    for (const other of this.manager.manifests()) {
      if (other.maturity === 'stub') continue; // a real adapter may replace a placeholder
      if (other.id === m.id) {
        if (this.manager.isBuiltin(other.id)) out.push(`"${m.id}" is a built-in integration and cannot be replaced by a package.`);
        continue;
      }
      if (other.exeNames.some((e) => exes.has(e.toLowerCase()))) out.push(`It drives the same program as "${other.name}", which OmniCandi already integrates.`);
    }
    return out;
  }

  /** Registers every enabled package that still verifies. Called once at startup. */
  async load(): Promise<void> {
    // An install that was interrupted (crash, power loss) is undone before anything is registered.
    await this.installer.recover().catch(() => undefined);
    for (const rec of await this.store.records()) {
      if (!rec.enabled) continue;
      const v = await this.store.verify(rec.id);
      if (!v.install) { this.loadErrors.set(rec.id, v.detail); continue; }
      try { await this.register(v.install); this.loadErrors.delete(rec.id); } catch (e) { this.loadErrors.set(rec.id, e instanceof Error ? e.message : String(e)); }
    }
  }

  private async register(inst: VerifiedInstall): Promise<void> {
    const type = integrationTypeOf(inst.manifest);
    const trust = inst.record.trust === 'unsigned' ? 'unsigned' : 'trusted-publisher';
    const manifest = toAdapterManifest(inst.manifest, trust);
    const id = inst.manifest.id;
    const spec = inst.manifest.integration;
    let link: PluginLink | undefined;
    if (type !== 'external' && spec?.plugin && spec.communication) {
      const caps = spec.communication.capabilities.map((c) => ({ id: c.id, permissions: c.permissions as import('@shared/integrations').Permission[] }));
      this.pluginCaps.set(spec.plugin.id, caps.map((c) => c.id));
      this.pluginOf.set(spec.plugin.id, id);
      await this.ensureBridge();
      link = makePluginLink(this.bridge, spec.plugin.id, caps);
    }
    if (type === 'internal') {
      this.manager.register(makeBridgeFactory({ manifest, link: link!, anchorPath: path.join(inst.pkgDir, 'adapter.json'), approved: inst.record.approved, trust }));
      return;
    }
    this.manager.register(makePackageFactory({
      manifest, entry: inst.entry, pkgDir: inst.pkgDir, dataDir: inst.dataDir, trust,
      approved: inst.record.approved, execPath: this.execPath, plugin: link,
      onCrash: (n) => { if (n >= 3) this.crashDisabled.add(id); },
    }));
  }

  private async unregister(id: string): Promise<void> {
    const f = this.manager.factory(id);
    if (f && f.manifest.source === 'package') await this.manager.unregister(id);
    const pluginId = [...this.pluginOf].find(([, pkg]) => pkg === id)?.[0];
    if (pluginId) { this.bridge.disconnect(pluginId, 'The integration was changed or turned off.'); this.pluginCaps.delete(pluginId); this.pluginOf.delete(pluginId); }
  }

  // ---- review ----

  private async parsed(source: string) {
    const loaded = await readPackageSource(source);
    const p = parsePackage(loaded.files);
    return { files: loaded.files, ...p };
  }

  /** The version of the program a plugin would be installed for, if OmniCandi has found it. */
  private async hostVersion(m: PackageManifest): Promise<string | null> {
    const profile = profileById(m.integration?.host?.profile ?? '');
    if (!profile?.exeNames.length) return null;
    const apps = await this.manager.list().catch(() => []);
    let hits = apps.filter((a) => profile.exeNames.some((e) => lower(e) === lower(path.basename(a.exePath))));
    // Nothing listed yet (nobody has scanned in this session): look for the program now.
    if (!hits.length) {
      const scanned = await this.manager.scan().then((r) => r.apps, () => []);
      hits = scanned.filter((a) => profile.exeNames.some((e) => lower(e) === lower(path.basename(a.exePath))));
    }
    // The release year can be missing from the uninstall record; Autodesk installs live in "Revit 2027"-style folders.
    const versionOf = (a: (typeof hits)[number]) => a.version ?? /(?<!\d)(20\d\d)(?!\d)/.exec(a.exePath)?.[1] ?? null;
    // Several release years can be installed side by side: prefer the one this package supports.
    const ranges = m.integration?.host?.versions ?? [];
    const fits = (v: string | null) => !!v && (!ranges.length || ranges.some((r) => (!r.min || compareVersions(v, r.min) >= 0) && (!r.max || compareVersions(v, r.max) <= 0)));
    const hit = hits.find((a) => fits(versionOf(a))) ?? hits[0];
    return hit ? versionOf(hit) : null;
  }

  async review(source: string): Promise<PackageReview> {
    const rev = await this.store.review(source);
    if (!rev.id || rev.integrationType === 'external') return rev;
    try {
      const p = await this.parsed(source);
      if (!p.manifest) return rev;
      const plan = await this.installer.plan(p.manifest, p.files, { hostVersion: await this.hostVersion(p.manifest) });
      rev.integration = plan.view;
      if (plan.problems.length) { rev.problems.push(...plan.problems); rev.action = 'blocked'; }
      if (plan.view.simulated) rev.warnings.push('This integration drives a SIMULATED test application, not real software. It exists to prove the installer and the bridge.');
    } catch (e) { rev.problems.push(`Could not prepare the add-in install: ${e instanceof Error ? e.message : String(e)}`); rev.action = 'blocked'; }
    return rev;
  }

  // ---- install / update ----

  async install(source: string, approval: PackageApproval, opts: { signal?: AbortSignal; onProgress?: (s: string) => void } = {}): Promise<InstalledAdapter> {
    const rev = await this.review(source);
    if (rev.problems.length) throw new PackageError(`The package cannot be installed: ${rev.problems.join('; ')}`);
    const p = await this.parsed(source);
    const m = p.manifest;
    if (!m) throw new PackageError('The package cannot be installed: invalid manifest');
    const type = integrationTypeOf(m);
    const hasPlugin = type !== 'external' && !!m.integration?.plugin;
    const fileCopy = hasPlugin && m.integration!.plugin!.mechanism === 'file-copy';
    const hostVersion = await this.hostVersion(m);
    const prev = (await this.store.records()).find((r) => r.id === m.id) ?? null;

    if (hasPlugin) {
      const plan = await this.installer.plan(m, p.files, { hostVersion });
      if (plan.problems.length) throw new InstallError(plan.problems.join(' '), 'blocked');
      if (plan.blockers.length) throw new InstallError(plan.blockers.join(' '), 'blocked');
      if (!approval.installPlugin) throw new InstallError('You have not approved installing the add-in into the program. Nothing was changed.', 'blocked');
    }
    // 1. The in-program part first: it has its own undo, and the adapter half is only added once it is in place.
    if (fileCopy) {
      opts.onProgress?.('Installing the add-in');
      await this.installer.install(m, p.files, approval, { hostVersion, signal: opts.signal, onProgress: (x) => opts.onProgress?.(x.step) });
    } else if (hasPlugin) {
      await this.pairOnly(m);
    }
    // 2. The package itself (adapter code, trust, saved original for Repair).
    let inst: VerifiedInstall;
    try {
      await this.unregister(m.id);
      inst = await this.store.install(source, approval);
      this.crashDisabled.delete(m.id);
      this.loadErrors.delete(m.id);
      if (inst.record.enabled) await this.register(inst);
    } catch (e) {
      // Half an integration is worse than none: take the add-in back out (a fresh install) before reporting.
      if (hasPlugin && !prev) await this.installer.uninstall(m.id).catch(() => undefined);
      if (prev && (await this.store.verify(m.id)).install) { const v = (await this.store.verify(m.id)).install!; if (v.record.enabled) await this.register(v).catch(() => undefined); }
      throw e;
    }
    await this.rescan();
    return (await this.view(m.id))!;
  }

  /** Vendor-workflow plugins: OmniCandi cannot copy files, but it can still create the pairing secret the plugin reads. */
  private async pairOnly(m: PackageManifest): Promise<void> {
    const pl = m.integration!.plugin!;
    const fs = await import('node:fs/promises');
    const { randomBytes } = await import('node:crypto');
    const file = this.installer.pairingFile(pl.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (!(await fs.stat(file).catch(() => null))) await fs.writeFile(file, JSON.stringify({ pluginId: pl.id, packageId: m.id, secret: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() }));
  }

  /** Lists the applications again so a new, removed or repaired integration shows up (or goes away) at once. */
  private async rescan(): Promise<void> {
    try { await this.manager.scan(); } catch { /* the next manual scan will report the problem */ }
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledAdapter> {
    await this.store.setEnabled(id, enabled);
    await this.unregister(id);
    if (enabled) {
      const v = await this.store.verify(id);
      if (!v.install) throw new PackageError(v.detail);
      await this.register(v.install);
    }
    await this.rescan();
    return (await this.view(id))!;
  }

  async uninstall(id: string): Promise<{ removed: string[]; kept: string[] }> {
    await this.unregister(id);
    const report = await this.installer.uninstall(id).catch(() => ({ removed: [] as string[], kept: [] as string[] }));
    await this.store.uninstall(id);
    this.crashDisabled.delete(id);
    this.loadErrors.delete(id);
    await this.rescan();
    return report;
  }

  async repair(id: string): Promise<InstalledAdapter> {
    await this.unregister(id); // ends its process first: Windows cannot replace files a program runs from
    const v = await this.store.verify(id);
    const inst = v.install ?? await this.store.repair(id);
    // Put the add-in files back from the verified original, too.
    const m = inst.manifest;
    if (integrationTypeOf(m) !== 'external' && m.integration?.plugin?.mechanism === 'file-copy') {
      const src = path.join(this.store.root, 'adapters', id, `source-${inst.record.version}.ccadapter`);
      const p = await this.parsed(src).catch(() => this.parsed(inst.pkgDir));
      if (!p.manifest) throw new PackageError('The saved original is damaged. Uninstall and install again.');
      await this.installer.repair(p.manifest, p.files, { permissions: inst.record.approved, installPlugin: true, elevate: (await this.installer.ledger(id))?.elevated }, { hostVersion: await this.hostVersion(m) });
    }
    this.crashDisabled.delete(id);
    this.loadErrors.delete(id);
    if (inst.record.enabled) await this.register(inst);
    await this.rescan();
    return (await this.view(id))!;
  }

  private async view(id: string): Promise<InstalledAdapter | null> {
    const v = await this.store.view(id, { crashDisabled: this.crashDisabled.has(id) });
    if (!v) return null;
    let out = v;
    if (this.loadErrors.has(id) && v.state === 'ok') out = { ...v, state: 'incompatible', stateDetail: this.loadErrors.get(id)! };
    if (v.integrationType !== 'external') {
      const pv = await this.installer.verify(id);
      const pluginId = [...this.pluginOf].find(([, pkg]) => pkg === id)?.[0];
      const live = pluginId ? this.bridge.session(pluginId) : null;
      let state: PluginState = pv.state;
      let detail = pv.detail;
      if (live?.registered && (pv.state === 'installed' || pv.state === 'restart-needed')) { state = 'connected'; detail = `Connected to ${live.appName}${live.appVersion ? ` ${live.appVersion}` : ''}.`; }
      out = { ...out, pluginState: state, pluginDetail: detail };
    }
    return out;
  }

  async listing(): Promise<PackageListing> {
    const installed: InstalledAdapter[] = [];
    for (const r of await this.store.records()) { const v = await this.view(r.id); if (v) installed.push(v); }
    return { installed, inbox: await this.reviewInbox(), inboxDir: this.store.inboxDir, trustedPublishers: await this.store.trustedPublishers() };
  }

  private async reviewInbox(): Promise<PackageReview[]> {
    const raw = await this.store.inbox();
    const out: PackageReview[] = [];
    for (const r of raw) out.push(r.id && r.integrationType !== 'external' ? await this.review(r.path) : r);
    return out;
  }

  async shutdown(): Promise<void> { await this.bridge.stop().catch(() => undefined); }
}


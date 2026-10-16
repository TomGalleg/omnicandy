// Connects the package store to the integration manager: installed, verified and enabled packages are
// registered as adapters; disabling, updating or removing one unregisters it again. Built-in adapters
// are never touched.

import type { InstalledAdapter, PackageApproval, PackageListing, PackageReview } from '@shared/integrations';
import type { IntegrationManager } from './manager';
import { toAdapterManifest, type PackageManifest } from './packageFormat';
import { makePackageFactory } from './packageRunner';
import { PackageError, PackageStore, type VerifiedInstall } from './packageStore';

export class AdapterPackages {
  readonly store: PackageStore;
  private crashDisabled = new Set<string>();
  /** Failures to load at startup or after an action, per adapter id (shown in Settings). */
  private loadErrors = new Map<string, string>();

  constructor(root: string, private readonly manager: IntegrationManager, private readonly execPath?: string) {
    this.store = new PackageStore(root, { conflicts: (m) => this.conflicts(m) });
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
      if (other.exeNames.some((e) => exes.has(e.toLowerCase()))) out.push(`It drives the same program as "${other.name}", which CreateCraft already integrates.`);
    }
    return out;
  }

  /** Registers every enabled package that still verifies. Called once at startup. */
  async load(): Promise<void> {
    for (const rec of await this.store.records()) {
      if (!rec.enabled) continue;
      const v = await this.store.verify(rec.id);
      if (!v.install) { this.loadErrors.set(rec.id, v.detail); continue; }
      try { this.register(v.install); this.loadErrors.delete(rec.id); } catch (e) { this.loadErrors.set(rec.id, e instanceof Error ? e.message : String(e)); }
    }
  }

  private register(inst: VerifiedInstall): void {
    const manifest = toAdapterManifest(inst.manifest, inst.record.trust === 'unsigned' ? 'unsigned' : 'trusted-publisher');
    const id = inst.manifest.id;
    this.manager.register(makePackageFactory({
      manifest, entry: inst.entry, pkgDir: inst.pkgDir, dataDir: inst.dataDir, trust: inst.record.trust === 'unsigned' ? 'unsigned' : 'trusted-publisher',
      approved: inst.record.approved, execPath: this.execPath,
      onCrash: (n) => { if (n >= 3) this.crashDisabled.add(id); },
    }));
  }

  private async unregister(id: string): Promise<void> {
    const f = this.manager.factory(id);
    if (f && f.manifest.source === 'package') await this.manager.unregister(id);
  }

  review(path: string): Promise<PackageReview> { return this.store.review(path); }

  async install(path: string, approval: PackageApproval): Promise<InstalledAdapter> {
    const review = await this.store.review(path);
    if (review.id && !review.problems.length) await this.unregister(review.id);
    const inst = await this.store.install(path, approval);
    this.crashDisabled.delete(inst.manifest.id);
    this.loadErrors.delete(inst.manifest.id);
    if (inst.record.enabled) {
      try { this.register(inst); } catch (e) { this.loadErrors.set(inst.manifest.id, e instanceof Error ? e.message : String(e)); throw e; }
    }
    return (await this.view(inst.manifest.id))!;
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledAdapter> {
    await this.store.setEnabled(id, enabled);
    await this.unregister(id);
    if (enabled) {
      const v = await this.store.verify(id);
      if (!v.install) throw new PackageError(v.detail);
      this.register(v.install);
    }
    return (await this.view(id))!;
  }

  async uninstall(id: string): Promise<void> {
    await this.unregister(id);
    await this.store.uninstall(id);
    this.crashDisabled.delete(id);
    this.loadErrors.delete(id);
  }

  async repair(id: string): Promise<InstalledAdapter> {
    await this.unregister(id); // ends its process first: Windows cannot replace files a program runs from
    const v = await this.store.verify(id);
    const inst = v.install ?? await this.store.repair(id);
    this.crashDisabled.delete(id);
    this.loadErrors.delete(id);
    if (inst.record.enabled) this.register(inst);
    return (await this.view(id))!;
  }

  private async view(id: string): Promise<InstalledAdapter | null> {
    const v = await this.store.view(id, { crashDisabled: this.crashDisabled.has(id) });
    if (v && this.loadErrors.has(id) && v.state === 'ok') return { ...v, state: 'incompatible', stateDetail: this.loadErrors.get(id)! };
    return v;
  }

  async listing(): Promise<PackageListing> {
    const installed: InstalledAdapter[] = [];
    for (const r of await this.store.records()) { const v = await this.view(r.id); if (v) installed.push(v); }
    return { installed, inbox: await this.store.inbox(), inboxDir: this.store.inboxDir, trustedPublishers: await this.store.trustedPublishers() };
  }
}

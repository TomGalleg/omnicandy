// Installed adapter packages on disk: install, update, enable/disable, verify, repair, uninstall.
//
//   <root>/registry.json              what is installed, its trust, the permissions the user approved
//   <root>/adapters/<id>/<version>/   the unpacked package (the only folder its process may read)
//   <root>/adapters/<id>/source-<version>.ccadapter   the verified original, used by Repair
//   <root>/data/<id>/                 the adapter's own storage; nothing else is shared with it
//   <root>/inbox/                     drop packages here; they are LISTED, never loaded or run
//
// Nothing is loaded from disk unless it passed the same checks again (hashes, signature, SDK range) at
// startup, so editing an installed file by hand turns the adapter off instead of running modified code.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ADAPTER_SDK_VERSION, compareVersions,
  type InstalledAdapter, type InstalledState, type PackageApproval, type PackageReview, type Permission, type TrustLevel,
} from '@shared/integrations';
import {
  MANIFEST_FILE, SIGNATURE_FILE, entryOf, integrationTypeOf, parsePackage, readPackageSource, requestedPermissions, sha256,
  type PackageManifest,
} from './packageFormat';
import { writeZip } from './zip';

export interface InstalledRecord {
  id: string;
  version: string;
  publisherName: string;
  fingerprint: string | null;
  trust: Exclude<TrustLevel, 'built-in'>;
  enabled: boolean;
  approved: Permission[];
  installedAt: string;
  manifestSha256: string;
}

interface RegistryFile { version: 1; adapters: Record<string, InstalledRecord>; trusted: Record<string, { name: string; addedAt: string }> }

export interface StoreHooks {
  /** Problems with registering this manifest next to what OmniCandy already has (id or program taken). */
  conflicts(m: PackageManifest): string[];
  /** Publisher key fingerprints OmniCandy itself ships as trusted (official release keys). Never a development key. */
  bundledPublishers?: () => string[];
}

export class PackageError extends Error {}

export interface VerifiedInstall {
  record: InstalledRecord;
  manifest: PackageManifest;
  pkgDir: string;
  dataDir: string;
  entry: string;
}

export class PackageStore {
  private reg: RegistryFile | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly root: string, private readonly hooks: StoreHooks) {}

  get inboxDir(): string { return path.join(this.root, 'inbox'); }
  private adaptersDir(id?: string): string { return id ? path.join(this.root, 'adapters', id) : path.join(this.root, 'adapters'); }
  pkgDirOf(id: string, version: string): string { return path.join(this.adaptersDir(id), version); }
  dataDirOf(id: string): string { return path.join(this.root, 'data', id); }

  // ---- registry ----

  private async registry(): Promise<RegistryFile> {
    if (this.reg) return this.reg;
    try {
      const j = JSON.parse(await fs.readFile(path.join(this.root, 'registry.json'), 'utf8')) as Partial<RegistryFile>;
      this.reg = { version: 1, adapters: j.adapters ?? {}, trusted: j.trusted ?? {} };
    } catch { this.reg = { version: 1, adapters: {}, trusted: {} }; }
    return this.reg;
  }

  private async save(): Promise<void> {
    const reg = this.reg;
    if (!reg) return;
    this.writing = this.writing.then(async () => {
      await fs.mkdir(this.root, { recursive: true });
      const tmp = path.join(this.root, `registry.${randomBytes(4).toString('hex')}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(reg, null, 2), 'utf8');
      await fs.rename(tmp, path.join(this.root, 'registry.json'));
    });
    await this.writing;
  }

  async records(): Promise<InstalledRecord[]> { return Object.values((await this.registry()).adapters); }
  async trustedPublishers(): Promise<Array<{ fingerprint: string; name: string; addedAt: string }>> {
    return Object.entries((await this.registry()).trusted).map(([fingerprint, v]) => ({ fingerprint, ...v }));
  }

  // ---- review ----

  /** Reads and checks a package without installing or running anything. Never throws for a bad package: problems are listed. */
  async review(source: string): Promise<PackageReview> {
    const empty: PackageReview = {
      path: source, problems: [], warnings: [], id: null, name: null, version: null, description: null, license: null, homepage: null,
      publisherName: null, fingerprint: null, signature: 'unsigned', publisherTrusted: false, applicationName: null, exeNames: [], displayNames: [], selfContained: false,
      sdk: null, requirements: [], commands: [], permissions: [], installedVersion: null, action: 'blocked', fileCount: 0, bytes: 0,
      integrationType: 'external', integration: null,
    };
    let loaded;
    try { loaded = await readPackageSource(source); } catch (e) {
      return { ...empty, problems: [`Cannot read the package: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const parsed = parsePackage(loaded.files);
    const rev: PackageReview = { ...empty, fileCount: loaded.files.size, bytes: loaded.bytes, signature: parsed.signature.state, fingerprint: parsed.signature.fingerprint, problems: [...parsed.problems] };
    if (!parsed.manifest) return rev;
    const m = parsed.manifest;
    const reg = await this.registry();
    const installed = reg.adapters[m.id];
    Object.assign(rev, {
      id: m.id, name: m.name, version: m.version, description: m.description ?? null, license: m.license ?? null, homepage: m.homepage ?? null,
      publisherName: m.publisher.name, applicationName: m.application.name, exeNames: m.application.exeNames ?? [], displayNames: m.application.displayNames ?? [], selfContained: m.application.kind === 'self-contained',
      sdk: m.sdk,
      requirements: [
        ...(m.requirements ?? []),
        ...(m.runtime?.dependencies ?? []).map((d) => ({ kind: 'runtime' as const, text: `${d.name}${d.min ? ` ${d.min} or newer` : ''}${d.note ? `: ${d.note}` : ''}` })),
      ],
      commands: m.commands.map((c) => ({ id: c.id, label: c.label, description: c.description, permissions: c.permissions as Permission[], destructive: !!c.destructive, longRunning: !!c.longRunning })),
      permissions: requestedPermissions(m),
      installedVersion: installed?.version ?? null,
      integrationType: integrationTypeOf(m),
    });
    if (parsed.signature.state === 'invalid') rev.problems.push(`Signature check failed: ${parsed.signature.detail}`);
    rev.publisherTrusted = !!(parsed.signature.state === 'valid' && parsed.signature.fingerprint && (reg.trusted[parsed.signature.fingerprint] || (this.hooks.bundledPublishers?.() ?? []).includes(parsed.signature.fingerprint)));
    if (parsed.signature.state === 'unsigned') rev.warnings.push('This package is not signed, so OmniCandy cannot tell who made it or whether it was changed. It will ask you before every command it runs.');
    else if (parsed.signature.state === 'valid' && !rev.publisherTrusted) rev.warnings.push(`This publisher is new to you. Only continue if you trust "${m.publisher.name}" (key ${parsed.signature.fingerprint}).`);
    rev.problems.push(...this.hooks.conflicts(m));
    if (installed) {
      const sameIdentity = (installed.fingerprint ?? null) === (parsed.signature.state === 'valid' ? parsed.signature.fingerprint : null);
      if (!sameIdentity) rev.problems.push(`${m.id} is already installed from a different publisher or signing key. Uninstall it first if you really want to replace it.`);
      else {
        const c = compareVersions(m.version, installed.version);
        if (c < 0) rev.problems.push(`Version ${installed.version} is already installed; installing the older ${m.version} is not allowed.`);
        rev.action = c > 0 ? 'update' : 'reinstall';
      }
    } else rev.action = 'install';
    if (rev.problems.length) rev.action = 'blocked';
    return rev;
  }

  // ---- install ----

  async install(source: string, approval: PackageApproval): Promise<VerifiedInstall> {
    // Everything is re-read and re-checked here: the renderer's earlier review is not trusted.
    const loaded = await readPackageSource(source).catch((e) => { throw new PackageError(`Cannot read the package: ${e instanceof Error ? e.message : String(e)}`); });
    const rev = await this.review(source);
    const parsed = parsePackage(loaded.files);
    if (rev.problems.length || !parsed.manifest) throw new PackageError(`The package cannot be installed: ${rev.problems.join('; ') || 'invalid manifest'}`);
    const m = parsed.manifest;
    const sig = parsed.signature;
    if (sig.state === 'unsigned' && !approval.allowUnsigned) throw new PackageError('This package is unsigned. Installing it needs your explicit confirmation.');
    if (sig.state === 'valid' && !rev.publisherTrusted && !approval.trustPublisher) throw new PackageError(`The publisher "${m.publisher.name}" is not trusted yet. Installing needs your explicit confirmation.`);
    const requested = new Set(requestedPermissions(m));
    for (const p of approval.permissions) if (!requested.has(p)) throw new PackageError(`"${p}" was not requested by the package and cannot be granted.`);
    const approved = [...new Set(approval.permissions)].sort() as Permission[];

    const reg = await this.registry();
    const prev = reg.adapters[m.id] ?? null;
    const finalDir = this.pkgDirOf(m.id, m.version);
    const stage = path.join(this.adaptersDir(m.id), `.stage-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(stage, { recursive: true });
    try {
      for (const [name, data] of loaded.files) {
        const dest = path.resolve(stage, ...name.split('/'));
        if (!dest.startsWith(stage + path.sep)) throw new PackageError(`unsafe path "${name}"`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, data, { flag: 'wx' });
      }
      // Keep the verified original for Repair, outside the folder the adapter can read.
      await fs.writeFile(path.join(this.adaptersDir(m.id), `source-${m.version}.ccadapter`), writeZip(loaded.files));
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.rename(stage, finalDir);
    } catch (e) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw e instanceof PackageError ? e : new PackageError(`Could not write the package: ${e instanceof Error ? e.message : String(e)}`);
    }
    await fs.mkdir(this.dataDirOf(m.id), { recursive: true });

    const trust: InstalledRecord['trust'] = sig.state === 'valid' ? 'trusted-publisher' : 'unsigned';
    if (sig.state === 'valid' && sig.fingerprint && approval.trustPublisher) reg.trusted[sig.fingerprint] = { name: m.publisher.name, addedAt: new Date().toISOString() };
    const record: InstalledRecord = {
      id: m.id, version: m.version, publisherName: m.publisher.name, fingerprint: sig.state === 'valid' ? sig.fingerprint : null,
      trust, enabled: prev?.enabled ?? true, approved, installedAt: new Date().toISOString(), manifestSha256: sha256(parsed.manifestBytes),
    };
    reg.adapters[m.id] = record;
    await this.save();
    // The previous version's files are removed only after the new one is registered.
    if (prev && prev.version !== m.version) {
      await fs.rm(this.pkgDirOf(m.id, prev.version), { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(path.join(this.adaptersDir(m.id), `source-${prev.version}.ccadapter`), { force: true }).catch(() => undefined);
    }
    return { record, manifest: m, pkgDir: finalDir, dataDir: this.dataDirOf(m.id), entry: entryOf(m) ? path.join(finalDir, ...entryOf(m)!.split('/')) : '' };
  }

  // ---- state ----

  /** Re-checks an installed package from disk (hashes, signature, identity, SDK). */
  async verify(id: string): Promise<{ state: InstalledState; detail: string; install: VerifiedInstall | null }> {
    const rec = (await this.registry()).adapters[id];
    if (!rec) return { state: 'missing-files', detail: 'Not installed.', install: null };
    const pkgDir = this.pkgDirOf(id, rec.version);
    let files;
    try { files = (await readPackageSource(pkgDir)).files; } catch { return { state: 'missing-files', detail: 'The installed files are missing. Repair or reinstall the package.', install: null }; }
    const parsed = parsePackage(files);
    if (!parsed.manifest) return { state: 'tampered', detail: parsed.problems.join('; '), install: null };
    if (sha256(parsed.manifestBytes) !== rec.manifestSha256) return { state: 'tampered', detail: 'The manifest is not the one that was approved at install.', install: null };
    const integrity = parsed.problems.filter((p) => !p.startsWith('needs adapter SDK'));
    if (integrity.length) return { state: 'tampered', detail: `Files changed since install: ${integrity.slice(0, 3).join('; ')}`, install: null };
    if (parsed.problems.some((p) => p.startsWith('needs adapter SDK'))) return { state: 'incompatible', detail: parsed.problems.find((p) => p.startsWith('needs adapter SDK'))!, install: null };
    if (rec.trust === 'trusted-publisher' && (parsed.signature.state !== 'valid' || parsed.signature.fingerprint !== rec.fingerprint)) {
      return { state: 'tampered', detail: 'The signature no longer matches the publisher approved at install.', install: null };
    }
    const m = parsed.manifest;
    const install: VerifiedInstall = { record: rec, manifest: m, pkgDir, dataDir: this.dataDirOf(id), entry: entryOf(m) ? path.join(pkgDir, ...entryOf(m)!.split('/')) : '' };
    return { state: rec.enabled ? 'ok' : 'disabled', detail: rec.enabled ? 'Verified.' : 'Turned off.', install };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const rec = (await this.registry()).adapters[id];
    if (!rec) throw new PackageError('That integration is not installed.');
    rec.enabled = enabled;
    await this.save();
  }

  async uninstall(id: string, keepData = false): Promise<void> {
    const reg = await this.registry();
    if (!reg.adapters[id]) throw new PackageError('That integration is not installed.');
    delete reg.adapters[id];
    await this.save();
    // The adapter's process may still be exiting (Windows keeps its folder locked for a moment): retry instead of failing the removal.
    await fs.rm(this.adaptersDir(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    if (!keepData) await fs.rm(this.dataDirOf(id), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }

  /** Puts back the verified original when installed files were changed or lost. */
  async repair(id: string): Promise<VerifiedInstall> {
    const reg = await this.registry();
    const rec = reg.adapters[id];
    if (!rec) throw new PackageError('That integration is not installed.');
    const archive = path.join(this.adaptersDir(id), `source-${rec.version}.ccadapter`);
    const parsed = await readPackageSource(archive).then((l) => parsePackage(l.files)).catch(() => null);
    if (!parsed || !parsed.manifest || parsed.problems.some((p) => !p.startsWith('needs adapter SDK')) || sha256(parsed.manifestBytes) !== rec.manifestSha256) {
      throw new PackageError('The saved original is missing or damaged. Uninstall the integration and install the package again.');
    }
    const loaded = await readPackageSource(archive);
    const pkgDir = this.pkgDirOf(id, rec.version);
    const stage = path.join(this.adaptersDir(id), `.repair-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(stage, { recursive: true });
    try {
      for (const [name, data] of loaded.files) {
        const dest = path.resolve(stage, ...name.split('/'));
        if (!dest.startsWith(stage + path.sep)) throw new PackageError(`unsafe path "${name}"`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, data, { flag: 'wx' });
      }
      await fs.rm(pkgDir, { recursive: true, force: true });
      await fs.rename(stage, pkgDir);
    } catch (e) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    const v = await this.verify(id);
    if (!v.install) throw new PackageError(`Repair did not restore a valid package: ${v.detail}`);
    return v.install;
  }

  // ---- views ----

  async view(id: string, extra?: { crashDisabled?: boolean }): Promise<InstalledAdapter | null> {
    const rec = (await this.registry()).adapters[id];
    if (!rec) return null;
    const v = await this.verify(id);
    const m = v.install?.manifest ?? null;
    const state: InstalledState = extra?.crashDisabled && v.state === 'ok' ? 'crash-disabled' : v.state;
    return {
      id, name: m?.name ?? id, version: rec.version, description: m?.description ?? null, license: m?.license ?? null,
      publisherName: rec.publisherName, fingerprint: rec.fingerprint, trust: rec.trust, enabled: rec.enabled, state,
      stateDetail: state === 'crash-disabled' ? 'It stopped unexpectedly several times in a row, so it was turned off. Use Repair to try again.' : v.detail,
      applicationName: m?.application.name ?? id, selfContained: m?.application.kind === 'self-contained',
      sdkCompatible: v.state !== 'incompatible', requirements: [
        ...(m?.requirements ?? []),
        ...(m?.runtime?.dependencies ?? []).map((d) => ({ kind: 'runtime' as const, text: `${d.name}${d.min ? ` ${d.min} or newer` : ''}${d.note ? `: ${d.note}` : ''}` })),
      ],
      approvedPermissions: rec.approved, requestedPermissions: m ? requestedPermissions(m) : [], commandCount: m?.commands.length ?? 0,
      installedAt: rec.installedAt, restricted: true,
      integrationType: m ? integrationTypeOf(m) : 'external', pluginState: 'none', pluginDetail: '',
    };
  }

  /** Inbox: packages dropped in the designated folder, reviewed but never loaded. */
  async inbox(): Promise<PackageReview[]> {
    await fs.mkdir(this.inboxDir, { recursive: true });
    const out: PackageReview[] = [];
    for (const e of (await fs.readdir(this.inboxDir, { withFileTypes: true })).slice(0, 50)) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory() || (e.isFile() && /\.ccadapter$/i.test(e.name))) out.push(await this.review(path.join(this.inboxDir, e.name)));
    }
    return out;
  }
}

export { ADAPTER_SDK_VERSION, MANIFEST_FILE, SIGNATURE_FILE };

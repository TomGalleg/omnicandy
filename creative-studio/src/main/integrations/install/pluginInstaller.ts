// PluginInstaller: puts the in-program part of an internal or hybrid integration where the program loads it, and takes
// it away again, without ever running anything the package supplies.
//
//   * The only operation is "write a verified file into an approved folder". No scripts, no commands, no registry.
//   * Folders, scopes, file types and size limits come from hostProfiles.ts (OmniCandy's own table). The manifest can
//     name a destination id; it cannot add one, point at a path, or widen the limits. Re-checked at install time.
//   * Every change is journalled before it happens (ledger.json). A failure, a cancel or a crash rolls back to exactly
//     the earlier state; uninstall removes only files whose hash still matches what was installed.
//   * The program is never closed or started by this code. A folder that needs administrator rights is written only after
//     the user approved elevation AND an elevator is available; otherwise the install stops with a clear message.
//   * Nothing here marks an integration as connected. That needs a verified round trip through the plugin bridge.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { InstallStepView, IntegrationReview, PackageApproval, PluginState } from '@shared/integrations';
import { integrationTypeOf, sha256, type PackageManifest } from '../packageFormat';
import { profileById, resolveDestination, type DestinationDef, type HostProfile, type InstallEnv } from './hostProfiles';

export const BRIDGE_CONFIG_FILE = 'cc-bridge.json';

export class InstallError extends Error {
  constructor(message: string, readonly kind: 'blocked' | 'cancelled' | 'failed' | 'needs-elevation' = 'failed') { super(message); }
}

/** Writes into a protected folder on behalf of the user after they approved the elevation prompt. */
export interface Elevator {
  write(files: Array<{ abs: string; data: Buffer }>): Promise<void>;
  remove(paths: string[]): Promise<void>;
}

export interface InstallerOptions {
  env: InstallEnv;
  /** Is any of these processes running? Defaults to "no" (tests and non-Windows). */
  isRunning?: (processNames: string[]) => Promise<boolean>;
  elevator?: Elevator;
  /** A plugin of this id is connected right now, which proves its program is open (works for programs the task list cannot name). */
  hostSessionActive?: (pluginId: string) => boolean;
  /** Where the bridge server announces itself, and where the per-plugin secrets are kept (both private to the user). */
  bridge: { endpointFile: string; pairingDir: string };
}

export interface PlannedFile { from: string | null; to: string; abs: string; bytes: number; generated: boolean }

export interface PluginPlan {
  /** Permanent problems with the package or the installer's rules; the install can never succeed as it is. */
  problems: string[];
  profile: HostProfile | null;
  destination: DestinationDef | null;
  destRoot: string | null;
  files: PlannedFile[];
  blockers: string[];
  view: IntegrationReview;
}

interface LedgerFile { rel: string; abs: string; sha256: string; bytes: number; backup: string | null; created: boolean }
export interface PluginLedger {
  packageId: string;
  pluginId: string;
  version: string;
  profile: string;
  destination: string;
  destRoot: string;
  state: 'installing' | 'installed';
  files: LedgerFile[];
  createdDirs: string[];
  restartPending: boolean;
  installedAt: string;
  elevated: boolean;
}

export interface InstallProgress { step: string; done: number; total: number }

const lower = (p: string) => p.toLowerCase();
const inside = (root: string, abs: string) => lower(abs).startsWith(lower(root + path.sep));

export class PluginInstaller {
  constructor(readonly root: string, readonly o: InstallerOptions) {}

  private dir(id: string): string { return path.join(this.root, 'plugins', id); }
  private ledgerFile(id: string): string { return path.join(this.dir(id), 'ledger.json'); }
  private backupDir(id: string): string { return path.join(this.dir(id), 'backup'); }
  pairingFile(pluginId: string): string { return path.join(this.o.bridge.pairingDir, `${pluginId}.json`); }

  // ---- plan ----

  async plan(m: PackageManifest, files: Map<string, Buffer>, ctx: { hostVersion?: string | null } = {}): Promise<PluginPlan> {
    const type = integrationTypeOf(m);
    const i = m.integration;
    const blockers: string[] = [];
    const problems: string[] = [];
    const view: IntegrationReview = {
      type, hostName: null, simulated: !!i?.host?.simulated, pluginName: null, technology: null, steps: [], blockers, closeHost: false, restartHost: false,
      needsAdmin: false, hostRunning: false, destinations: [], vendorWorkflow: null, communication: null, dependencies: [],
    };
    const empty = (): PluginPlan => ({ problems, profile: null, destination: null, destRoot: null, files: [], blockers, view });
    if (type === 'external' || !i?.plugin || !i.host || !i.communication) {
      if (type !== 'external') problems.push('The package does not describe its plugin completely.');
      return empty();
    }
    const pl = i.plugin;
    const profile = profileById(i.host.profile);
    view.pluginName = pl.name ?? m.name;
    view.technology = pl.technology;
    view.communication = { transport: i.communication.transport, protocol: i.communication.protocol, capabilities: i.communication.capabilities.map((c) => c.id) };
    view.dependencies = (pl.dependencies ?? []).map((d) => ({ kind: d.kind, name: d.name, min: d.min ?? null }));
    view.vendorWorkflow = pl.vendorWorkflow ? { title: pl.vendorWorkflow.title, steps: pl.vendorWorkflow.steps, officialUrl: pl.vendorWorkflow.officialUrl ?? null } : null;
    if (!profile) { problems.push(`OmniCandy has no installation profile for "${i.host.profile}", so it will not install anything for it.`); return empty(); }
    view.hostName = profile.name;
    const dest = profile.destinations.find((d) => d.id === pl.destination) ?? null;
    if (!dest && pl.mechanism === 'file-copy') { problems.push(`"${pl.destination}" is not an approved plugin folder for ${profile.name}.`); return { ...empty(), profile }; }
    if (!dest) return { ...empty(), profile };
    if (dest && !dest.technologies.includes(pl.technology)) problems.push(`${profile.name} does not load ${pl.technology} plugins from "${dest.label}".`);
    // The manifest may only say what the installer already knows; it cannot lower a requirement.
    if (dest?.admin && pl.admin !== 'required') problems.push(`The manifest says no administrator rights are needed, but "${dest.label}" needs them.`);
    view.needsAdmin = !!dest?.admin;
    view.closeHost = pl.closeHost === 'required';
    view.restartHost = pl.restart !== 'not-required';
    const destRoot = dest ? resolveDestination(dest, this.o.env, ctx.hostVersion ?? null) : null;
    if (dest && !destRoot) problems.push(`OmniCandy cannot work out ${dest.label} for ${profile.name}${ctx.hostVersion ? ` ${ctx.hostVersion}` : ' (its version is unknown)'}.`);
    else if (dest && destRoot) view.destinations.push({ label: dest.label, path: destRoot, scope: dest.scope });

    const planned: PlannedFile[] = [];
    if (pl.mechanism === 'file-copy' && destRoot && dest) {
      if (pl.files.length + 1 > dest.maxFiles) problems.push(`Too many files for ${dest.label} (limit ${dest.maxFiles}).`);
      for (const f of pl.files) {
        const data = files.get(f.from);
        const abs = path.resolve(destRoot, ...f.to.split('/'));
        if (!data) { problems.push(`The package does not contain "${f.from}".`); continue; }
        if (!inside(destRoot, abs)) { problems.push(`"${f.to}" would leave the plugin folder.`); continue; }
        if (!dest.extensions.includes(path.extname(f.to).toLowerCase())) problems.push(`"${f.to}": ${path.extname(f.to) || 'files without an extension'} is not an allowed file type for ${dest.label}.`);
        if (data.length > dest.maxFileBytes) problems.push(`"${f.to}" is larger than the ${Math.round(dest.maxFileBytes / 1048576)} MB limit.`);
        if (planned.some((p) => lower(p.abs) === lower(abs))) problems.push(`"${f.to}" is listed twice.`);
        planned.push({ from: f.from, to: f.to, abs, bytes: data.length, generated: false });
      }
      // The pairing file is written by the installer, not taken from the package.
      const cfg = path.resolve(destRoot, BRIDGE_CONFIG_FILE);
      if (!dest.extensions.includes('.json')) problems.push(`${dest.label} does not allow the small pairing file OmniCandy needs.`);
      if (planned.some((p) => lower(p.abs) === lower(cfg))) problems.push(`"${BRIDGE_CONFIG_FILE}" is reserved for OmniCandy.`);
      planned.push({ from: null, to: BRIDGE_CONFIG_FILE, abs: cfg, bytes: 0, generated: true });
    }

    view.hostRunning = !!this.o.hostSessionActive?.(pl.id) || await (this.o.isRunning?.(profile.processNames) ?? Promise.resolve(false)).catch(() => false);
    const host = profile.name;

    // The steps the person sees, in the order they happen.
    const steps: InstallStepView[] = [];
    if (view.closeHost) {
      steps.push({ kind: 'close-host', title: `Close ${host}`, detail: view.hostRunning ? `${host} is open right now. Save your work and close it, then continue. OmniCandy never closes it for you.` : `${host} is not open, which is what the install needs. Keep it closed until the install finishes.` });
      if (view.hostRunning) blockers.push(`Close ${host} first, then try again. OmniCandy will not close it for you.`);
    }
    if (type === 'hybrid') steps.push({ kind: 'adapter', title: 'Install the connector', detail: 'The connector runs inside OmniCandy in a restricted process and talks to the add-in.' });
    if (pl.mechanism === 'file-copy') {
      steps.push({ kind: 'plugin-files', title: `Install ${view.pluginName} in ${host}`, detail: destRoot ? `Copies ${planned.length - 1} verified file${planned.length === 2 ? '' : 's'} into ${destRoot}.` : 'Copies the add-in files into the program\'s plugin folder.' });
    } else if (pl.vendorWorkflow) {
      steps.push({ kind: 'vendor-workflow', title: pl.vendorWorkflow.title, detail: `${host}'s vendor requires its own installation workflow. OmniCandy does not copy files for this; it guides you:\n${pl.vendorWorkflow.steps.map((s, n) => `${n + 1}. ${s}`).join('\n')}` });
    }
    if (dest?.admin) steps.push({ kind: 'elevation', title: 'Allow administrator access', detail: `"${dest.label}" is a protected folder. Windows will ask you to approve this once.` });
    if (view.restartHost) steps.push({ kind: 'restart-host', title: `Open or restart ${host}`, detail: profile.restartNote });
    if (profile.readiness !== 'simulated-test' && pl.technology === 'dotnet-addin') steps.push({ kind: 'authorize-in-host', title: `Allow the add-in inside ${host}`, detail: `${host} may ask you to approve a new add-in the first time it loads. Choose the option that loads it.` });
    steps.push({ kind: 'verify', title: 'Test the connection', detail: 'OmniCandy asks the add-in to run a real check inside the program. Only a reply from the add-in counts as connected.' });
    view.steps = steps;
    return { problems, profile, destination: dest, destRoot, files: planned, blockers, view };
  }

  // ---- install ----

  async install(m: PackageManifest, pkgFiles: Map<string, Buffer>, approval: PackageApproval, opts: { hostVersion?: string | null; signal?: AbortSignal; onProgress?: (p: InstallProgress) => void } = {}): Promise<PluginLedger> {
    const pl = m.integration?.plugin;
    if (!pl) throw new InstallError('This package has no plugin to install.', 'blocked');
    if (pl.mechanism === 'vendor-workflow') throw new InstallError('This add-in is installed through the vendor workflow. OmniCandy does not copy files for it.', 'blocked');
    if (!approval.installPlugin) throw new InstallError('You have not approved putting the add-in into the program\'s plugin folder.', 'blocked');
    const plan = await this.plan(m, pkgFiles, { hostVersion: opts.hostVersion });
    if (plan.problems.length || plan.blockers.length || !plan.destination || !plan.destRoot || !plan.profile) throw new InstallError([...plan.problems, ...plan.blockers].join(' ') || 'The install cannot continue.', 'blocked');
    const dest = plan.destination;
    const elevated = dest.admin;
    if (elevated) {
      if (!approval.elevate) throw new InstallError(`"${dest.label}" needs administrator rights and you have not approved that.`, 'needs-elevation');
      if (!this.o.elevator) throw new InstallError(`"${dest.label}" needs administrator rights. This OmniCandy build cannot request them safely; run the vendor's own installer or put the add-in in the per-user folder instead.`, 'needs-elevation');
    }
    const id = m.id;
    const prev = await this.ledger(id);
    if (prev?.state === 'installing') await this.rollback(prev);
    const old = prev?.state === 'installed' ? prev : null;
    const total = plan.files.length;
    const secret = randomBytes(32).toString('hex');

    // Build the exact bytes first: everything is hashed before the first write.
    const out: Array<{ f: PlannedFile; data: Buffer }> = plan.files.map((f) => {
      if (f.generated) {
        const cfg = { pluginId: pl.id, packageId: id, secret, endpointFile: this.o.bridge.endpointFile, protocol: m.integration!.communication!.protocol };
        return { f, data: Buffer.from(`${JSON.stringify(cfg, null, 2)}\n`, 'utf8') };
      }
      return { f, data: pkgFiles.get(f.from!)! };
    });

    // Existing files that OmniCandy did not put there are never overwritten.
    for (const { f, data } of out) {
      const st = await fs.stat(f.abs).catch(() => null);
      if (!st) continue;
      if (!st.isFile()) throw new InstallError(`"${f.to}" exists in the plugin folder and is not a file.`, 'blocked');
      const ours = old?.files.some((x) => lower(x.abs) === lower(f.abs));
      if (!ours && sha256(await fs.readFile(f.abs)) !== sha256(data)) throw new InstallError(`A different file named "${f.to}" is already in ${dest.label}. OmniCandy will not overwrite files it did not install.`, 'blocked');
    }

    await fs.mkdir(this.backupDir(id), { recursive: true });
    const ledger: PluginLedger = {
      packageId: id, pluginId: pl.id, version: pl.version, profile: plan.profile.id, destination: dest.id, destRoot: plan.destRoot, state: 'installing',
      files: [], createdDirs: [], restartPending: false, installedAt: new Date().toISOString(), elevated,
    };
    const journal = () => this.writeLedger(id, ledger);
    await journal();
    // The pairing secret is stored before the plugin can ever use it.
    await fs.mkdir(this.o.bridge.pairingDir, { recursive: true });
    const prevPairing = await fs.readFile(this.pairingFile(pl.id)).catch(() => null);
    await this.writeAtomic(this.pairingFile(pl.id), Buffer.from(JSON.stringify({ pluginId: pl.id, packageId: id, secret, createdAt: ledger.installedAt }), 'utf8'));

    try {
      // Directories first, remembered so uninstall can remove exactly what was created.
      const dirs = new Set<string>();
      for (const { f } of out) { let d = path.dirname(f.abs); while (inside(plan.destRoot, d + path.sep) && lower(d) !== lower(plan.destRoot)) { dirs.add(d); d = path.dirname(d); } }
      if (!(await fs.stat(plan.destRoot).catch(() => null))) { ledger.createdDirs.push(plan.destRoot); }
      let n = 0;
      const pending: Array<{ abs: string; data: Buffer }> = [];
      for (const { f, data } of out) {
        if (opts.signal?.aborted) throw new InstallError('Installation was cancelled.', 'cancelled');
        opts.onProgress?.({ step: `Copying ${f.to}`, done: n, total });
        const entry: LedgerFile = { rel: f.to, abs: f.abs, sha256: sha256(data), bytes: data.length, backup: null, created: true };
        const existing = await fs.readFile(f.abs).catch(() => null);
        if (existing) {
          entry.created = false;
          entry.backup = path.join(this.backupDir(id), `${randomBytes(6).toString('hex')}.bak`);
          await fs.writeFile(entry.backup, existing);
        }
        ledger.files.push(entry);
        await journal();
        if (elevated) pending.push({ abs: f.abs, data });
        else {
          await fs.mkdir(path.dirname(f.abs), { recursive: true });
          await this.writeAtomic(f.abs, data);
        }
        n++;
      }
      if (elevated) await this.o.elevator!.write(pending);
      if (opts.signal?.aborted) throw new InstallError('Installation was cancelled.', 'cancelled');
      // The earlier version's files that the new version no longer has are removed only now, after the new ones are in place.
      if (old) for (const x of old.files) if (!ledger.files.some((y) => lower(y.abs) === lower(x.abs))) await this.removeIfOurs(x, elevated);
      // Verify what is on disk before saying anything is installed.
      for (const x of ledger.files) {
        const b = await fs.readFile(x.abs).catch(() => null);
        if (!b || sha256(b) !== x.sha256) throw new InstallError(`"${x.rel}" was not written correctly.`);
      }
      const hostRunning = plan.view.hostRunning;
      ledger.restartPending = plan.view.restartHost && (hostRunning || pl.restart === 'required');
      ledger.state = 'installed';
      await journal();
      for (const x of ledger.files) if (x.backup) await fs.rm(x.backup, { force: true }).catch(() => undefined);
      return ledger;
    } catch (e) {
      await this.rollback(ledger, elevated).catch(() => undefined);
      if (prevPairing) await this.writeAtomic(this.pairingFile(pl.id), prevPairing).catch(() => undefined);
      else await fs.rm(this.pairingFile(pl.id), { force: true }).catch(() => undefined);
      if (old) await this.writeLedger(id, old).catch(() => undefined);
      else await fs.rm(this.dir(id), { recursive: true, force: true }).catch(() => undefined);
      if (e instanceof InstallError) throw e;
      throw new InstallError(`Could not install the add-in: ${e instanceof Error ? e.message : String(e)}. Nothing was left half-installed.`);
    }
  }

  // ---- state ----

  async ledger(id: string): Promise<PluginLedger | null> {
    try { return JSON.parse(await fs.readFile(this.ledgerFile(id), 'utf8')) as PluginLedger; } catch { return null; }
  }

  /** Files on disk against the ledger. */
  async verify(id: string): Promise<{ state: PluginState; detail: string; problems: string[] }> {
    const l = await this.ledger(id);
    if (!l) return { state: 'none', detail: 'No add-in is installed.', problems: [] };
    if (l.state === 'installing') return { state: 'missing-files', detail: 'An installation was interrupted. Repair finishes or undoes it.', problems: ['interrupted'] };
    const problems: string[] = [];
    let missing = 0;
    for (const x of l.files) {
      const b = await fs.readFile(x.abs).catch(() => null);
      if (!b) { problems.push(`${x.rel} is missing`); missing++; } else if (sha256(b) !== x.sha256) problems.push(`${x.rel} was changed`);
    }
    if (missing) return { state: 'missing-files', detail: `Add-in files are missing: ${problems.slice(0, 3).join('; ')}. Use Repair.`, problems };
    if (problems.length) return { state: 'modified', detail: `Add-in files were changed since install: ${problems.slice(0, 3).join('; ')}. Use Repair.`, problems };
    return { state: l.restartPending ? 'restart-needed' : 'installed', detail: l.restartPending ? 'Installed. The program has to be opened or restarted so it loads the add-in.' : 'Add-in files are in place.', problems };
  }

  async clearRestart(id: string): Promise<void> {
    const l = await this.ledger(id);
    if (l && l.restartPending) { l.restartPending = false; await this.writeLedger(id, l); }
  }

  /** Reinstalls the files from a verified copy of the package. Files the user changed are put back; nothing else is touched. */
  async repair(m: PackageManifest, pkgFiles: Map<string, Buffer>, approval: PackageApproval, opts: { hostVersion?: string | null } = {}): Promise<PluginLedger> {
    const l = await this.ledger(m.id);
    if (l?.state === 'installing') await this.rollback(l, l.elevated);
    return this.install(m, pkgFiles, { ...approval, installPlugin: true }, opts);
  }

  async uninstall(id: string): Promise<{ removed: string[]; kept: string[] }> {
    const l = await this.ledger(id);
    if (!l) return { removed: [], kept: [] };
    if (l.state === 'installing') { await this.rollback(l, l.elevated); await this.cleanup(id, l); return { removed: [], kept: [] }; }
    const removed: string[] = [];
    const kept: string[] = [];
    for (const x of l.files) {
      const r = await this.removeIfOurs(x, l.elevated);
      (r ? removed : kept).push(x.rel);
    }
    await this.cleanup(id, l);
    return { removed, kept };
  }

  /** Undoes interrupted installs (called at start-up). */
  async recover(): Promise<string[]> {
    const fixed: string[] = [];
    let ids: string[] = [];
    try { ids = await fs.readdir(path.join(this.root, 'plugins')); } catch { return fixed; }
    for (const id of ids) {
      const l = await this.ledger(id);
      if (l?.state === 'installing') { await this.rollback(l, l.elevated).catch(() => undefined); await this.cleanup(id, l); fixed.push(id); }
    }
    return fixed;
  }

  // ---- internals ----

  private async removeIfOurs(x: LedgerFile, elevated: boolean): Promise<boolean> {
    const b = await fs.readFile(x.abs).catch(() => null);
    if (b && sha256(b) !== x.sha256) return false; // the user changed it: keep their version
    if (b) { if (elevated && this.o.elevator) await this.o.elevator.remove([x.abs]); else await fs.rm(x.abs, { force: true }); }
    if (x.backup && (await fs.stat(x.backup).catch(() => null))) {
      const prior = await fs.readFile(x.backup);
      await this.writeAtomic(x.abs, prior);
    }
    return true;
  }

  private async rollback(l: PluginLedger, elevated = l.elevated): Promise<void> {
    for (const x of [...l.files].reverse()) {
      const b = await fs.readFile(x.abs).catch(() => null);
      if (x.backup && (await fs.stat(x.backup).catch(() => null))) {
        await this.writeAtomic(x.abs, await fs.readFile(x.backup));
      } else if (b && x.created && sha256(b) === x.sha256) {
        if (elevated && this.o.elevator) await this.o.elevator.remove([x.abs]); else await fs.rm(x.abs, { force: true });
      }
    }
    for (const d of [...l.createdDirs].reverse()) await fs.rmdir(d).catch(() => undefined);
    await this.pruneEmptyDirs(l);
    await fs.rm(this.pairingFile(l.pluginId), { force: true }).catch(() => undefined);
  }

  private async pruneEmptyDirs(l: PluginLedger): Promise<void> {
    const dirs = new Set<string>();
    for (const x of l.files) { let d = path.dirname(x.abs); while (inside(l.destRoot, d + path.sep) && lower(d) !== lower(l.destRoot)) { dirs.add(d); d = path.dirname(d); } }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) await fs.rmdir(d).catch(() => undefined);
  }

  private async cleanup(id: string, l: PluginLedger): Promise<void> {
    await this.pruneEmptyDirs(l);
    for (const d of [...l.createdDirs].reverse()) await fs.rmdir(d).catch(() => undefined);
    await fs.rm(this.pairingFile(l.pluginId), { force: true }).catch(() => undefined);
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }

  private async writeLedger(id: string, l: PluginLedger): Promise<void> {
    await fs.mkdir(this.dir(id), { recursive: true });
    await this.writeAtomic(this.ledgerFile(id), Buffer.from(JSON.stringify(l, null, 2), 'utf8'));
  }

  private async writeAtomic(file: string, data: Buffer): Promise<void> {
    // The temporary name has an extension no program loads (.ccpart) so a half-written file is never picked up as a plugin.
    const tmp = `${file}.${randomBytes(4).toString('hex')}.ccpart`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }
}

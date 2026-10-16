// ConnectService: the beginner-facing operations of Universal Connect, built ON the existing manager, package
// store and trust system (nothing here installs, trusts or runs code by itself):
//   overview           scan + connectors that could be installed + plain-language classification of every program
//   connectAndVerify   connect one program, then check it with the adapter's real health check
//   browse             a portable or unregistered program the user picked by hand
//   forget             drop a remembered location (and the permissions) without touching the real software
// Each application is handled on its own: one failure never changes the outcome of another.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  classifyApp, explainConnectFailure,
  sameInstall, type AdapterOffer, type AdapterState, type BrowseResult, type ConnectEntry, type ConnectOutcome, type ConnectOverview, type ForgetResult,
} from '@shared/connect';
import { compareVersions, type ExternalAppInfo, type ExternalScan, type InstalledAdapter, type PackageReview } from '@shared/integrations';
import type { DiscoveryTarget } from './discovery';
import type { AdapterPackages } from './loader';
import type { IntegrationManager } from './manager';
import { ExternalState, nameSake } from './state';

export interface ConnectDeps {
  manager: IntegrationManager;
  packages: AdapterPackages;
  state: ExternalState;
  /** Folders with connectors shipped with CreateCraft. Reading them lists packages; nothing is installed. */
  catalogDirs: string[];
}

interface KnownOffer extends AdapterOffer { exeNames: string[]; displayNames: string[] }

const lower = (s: string) => s.toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class ConnectService {
  private offerCache: KnownOffer[] = [];
  private lastMissing: ExternalScan['missing'] = [];

  constructor(private readonly d: ConnectDeps) {}

  /** Programs that connectors-to-install would drive, so the next scan looks for them too. */
  extraTargets = async (): Promise<DiscoveryTarget[]> =>
    this.offerCache.filter((o) => o.exeNames.length).map((o) => ({ exeNames: o.exeNames, displayNames: o.displayNames.map((n) => `^${escapeRe(n)}`) }));

  // ---- connectors that could be installed ----

  private offerOf(r: PackageReview, source: 'bundled' | 'inbox'): KnownOffer | null {
    // Blocked, damaged or already-installed packages are not offered; they stay visible in the package list.
    if (!r.id || !r.name || !r.version || r.problems.length || r.action === 'blocked' || r.action === 'reinstall') return null;
    return {
      source, path: r.path, adapterId: r.id, name: r.name, version: r.version, publisherName: r.publisherName,
      signature: r.signature, publisherTrusted: r.publisherTrusted, permissions: r.permissions, exeNames: r.exeNames, displayNames: r.displayNames,
    };
  }

  private async collectOffers(): Promise<KnownOffer[]> {
    const out: KnownOffer[] = [];
    for (const dir of this.d.catalogDirs) {
      let names: string[] = [];
      try { names = (await fs.readdir(dir)).filter((n) => /\.ccadapter$/i.test(n)).sort(); } catch { /* no catalog folder */ }
      for (const n of names) {
        const o = this.offerOf(await this.d.packages.review(path.join(dir, n)), 'bundled');
        if (o) out.push(o);
      }
    }
    const listing = await this.d.packages.listing();
    for (const r of listing.inbox) { const o = this.offerOf(r, 'inbox'); if (o) out.push(o); }
    // Installed but turned off: the connector is on this PC, it only needs turning on.
    for (const a of listing.installed) if (!a.enabled) out.push(this.turnedOff(a));
    // The newest version of one connector wins; a turned-off installed one is only used when nothing newer is offered.
    const byId = new Map<string, KnownOffer>();
    for (const o of out) {
      const p = byId.get(o.adapterId);
      if (!p || p.source === 'installed-off' || (o.source !== 'installed-off' && compareVersions(o.version, p.version) > 0)) byId.set(o.adapterId, o);
    }
    return [...byId.values()];
  }

  private turnedOff(a: InstalledAdapter): KnownOffer {
    return {
      source: 'installed-off', path: null, adapterId: a.id, name: a.name, version: a.version, publisherName: a.publisherName,
      signature: a.fingerprint ? 'valid' : 'unsigned', publisherTrusted: !!a.fingerprint, permissions: a.requestedPermissions, exeNames: [], displayNames: [a.applicationName],
    };
  }

  /** The connector that would drive this program, if any. */
  private offerFor(app: ExternalAppInfo): KnownOffer | null {
    const exe = lower(path.basename(app.exePath));
    return this.offerCache.find((o) => o.adapterId === app.adapterId || o.exeNames.some((e) => lower(e) === exe)) ?? null;
  }

  /**
   * One installation can be found through several of its programs (FreeCAD.exe from the uninstall record, FreeCADCmd.exe
   * from a shortcut). A beginner should see ONE row: the program the connector drives, with the richest name and version.
   */
  private onePerInstall(list: ConnectEntry[]): ConnectEntry[] {
    const idOf = (e: ConnectEntry) => e.adapterId ?? e.offer?.adapterId ?? null;
    const drives = (e: ConnectEntry) => {
      const exe = lower(path.basename(e.exePath));
      return (this.offerCache.find((o) => o.adapterId === idOf(e))?.exeNames ?? []).some((x) => lower(x) === exe);
    };
    const out: ConnectEntry[] = [];
    for (const e of list) {
      const id = idOf(e);
      const i = id ? out.findIndex((o) => idOf(o) === id && sameInstall(o.exePath, e.exePath)) : -1;
      if (i < 0) { out.push(e); continue; }
      const prev = out[i]!;
      const keep = !drives(prev) && drives(e) ? e : prev;
      const other = keep === prev ? e : prev;
      out[i] = { ...keep, version: keep.version ?? other.version, publisher: keep.publisher ?? other.publisher, name: other.source === 'registry' && keep.source !== 'registry' ? other.name : keep.name, forgettable: keep.forgettable || other.forgettable };
    }
    return out;
  }

  // ---- overview ----

  async overview(opts: { rescan?: boolean } = {}): Promise<ConnectOverview> {
    this.offerCache = await this.collectOffers();
    let scan: ExternalScan;
    if (opts.rescan === false) scan = { apps: await this.d.manager.list(), missing: this.lastMissing };
    else { scan = await this.d.manager.scan(); this.lastMissing = scan.missing; }
    const st = await this.d.state.read();
    const saved = [...st.paths, ...st.remembered];
    const entries = this.onePerInstall(scan.apps.map((app) => {
      const hit = nameSake(app.exePath);
      const offer = this.offerFor(app);
      return classifyApp({ app, offer: offer ? stripInternal(offer) : null, forgettable: saved.some(hit) });
    }));
    const manifests = this.d.manager.manifests();
    const notDetected: ConnectOverview['notDetected'] = scan.missing.map((m) => {
      const mf = manifests.find((x) => x.id === m.adapterId);
      const state: AdapterState = m.maturity === 'stub' ? (this.offerCache.some((o) => o.adapterId === m.adapterId) ? 'available' : 'planned') : 'installed';
      return { adapterId: m.adapterId, name: m.name, vendor: m.vendor, adapterState: state, experimental: m.maturity === 'experimental' || mf?.source === 'package' };
    });
    // Connectors that could be installed for programs that are not on this PC.
    const covered = (o: KnownOffer) => entries.some((e) => e.adapterId === o.adapterId || e.offer?.adapterId === o.adapterId) || notDetected.some((n) => n.adapterId === o.adapterId);
    for (const o of this.offerCache) if (!covered(o)) notDetected.push({ adapterId: o.adapterId, name: o.name, vendor: o.publisherName ?? '', adapterState: 'available', experimental: true });
    return { entries, notDetected, firstRun: !st.onboarded, scannedAt: new Date().toISOString() };
  }

  /** Paths the screen may review and install: only what the overview itself listed. */
  offerPaths(): string[] { return this.offerCache.map((o) => o.path).filter((p): p is string => !!p); }

  // ---- connect + verify ----

  async connectAndVerify(key: string): Promise<ConnectOutcome> {
    const before = (await this.d.manager.list()).find((a) => a.key === key);
    const name = before?.adapterName ?? before?.name ?? 'the program';
    const fail = async (e: unknown): Promise<ConnectOutcome> => {
      const raw = e instanceof Error ? e.message : String(e);
      const now = (await this.d.manager.list()).find((a) => a.key === key);
      const status = now?.status ?? 'needs-repair';
      const why = explainConnectFailure(status, name, raw);
      return { key, state: status === 'not-running' || status === 'api-unavailable' ? 'blocked' : 'failed', status, headline: why.headline, detail: why.detail, evidence: [], technical: raw };
    };
    let info: ExternalAppInfo;
    try {
      info = before?.status === 'needs-repair' ? await this.d.manager.repair(key) : await this.d.manager.connect(key);
    } catch (e) { return fail(e); }
    const v = await this.d.manager.verify(key);
    if (!v.ok) {
      // Not verified means not connected: end the session so the list cannot say "Connected".
      await this.d.manager.disconnect(key);
      return fail(new Error(v.detail || 'The connection test failed.'));
    }
    const limited = info.status === 'limited';
    const version = v.version ? ` ${v.version}` : '';
    return {
      key, state: limited ? 'verified-limited' : 'verified', status: info.status,
      headline: limited ? `${name} is connected (experimental)` : `${name} is connected and tested`,
      detail: limited ? `${name} passed its connection test. This connector is experimental, so some features may be limited or untested.` : `${name} passed a real connection test. It is ready to use.`,
      evidence: [`${name}${version} started and answered a real health check`, ...(v.detail ? [v.detail] : [])],
      technical: v.detail,
    };
  }

  // ---- browse ----

  /** Handles a program file or folder the user picked. Only programs CreateCraft has a connector (or a planned one) for are saved. */
  async browse(picked: string): Promise<BrowseResult> {
    const st = await fs.stat(picked).catch(() => null);
    const label = path.basename(picked, path.extname(picked)) || picked;
    if (!st) return { kind: 'no-match', name: label, message: 'That file or folder does not exist any more.' };
    if (st.isFile() && !/\.exe$/i.test(picked)) return { kind: 'no-match', name: label, message: 'Choose the program file (it ends in .exe) or the folder it lives in.' };
    this.offerCache = await this.collectOffers();
    const wanted = new Set([...this.d.manager.manifests().flatMap((m) => m.exeNames), ...this.offerCache.flatMap((o) => o.exeNames)].map(lower));
    const found: string[] = [];
    if (st.isFile()) { if (wanted.has(lower(path.basename(picked)))) found.push(picked); }
    else {
      for (const dir of [picked, path.join(picked, 'bin')]) {
        for (const e of await fs.readdir(dir).catch(() => [] as string[])) if (wanted.has(lower(e)) && !found.some((f) => lower(path.basename(f)) === lower(e))) found.push(path.join(dir, e));
      }
    }
    if (!found.length) {
      return { kind: 'no-match', name: label, message: `CreateCraft has no connector for “${label}”, so it cannot control it. Nothing was saved. It can only connect programs it knows; Settings > Integrations lists them.` };
    }
    const isFound = (key: string) => found.some((f) => lower(path.normalize(f)) === key);
    const known = (await this.d.manager.list()).find((a) => isFound(a.key));
    if (known) return { kind: 'already-known', key: known.key, name: known.adapterName ?? known.name, message: `${known.adapterName ?? known.name} is already in your list.` };
    await this.d.state.addPath(picked);
    const scan = await this.d.manager.scan();
    this.lastMissing = scan.missing;
    const app = scan.apps.find((a) => isFound(a.key));
    if (!app) {
      await this.d.state.removePath(found[0]!);
      return { kind: 'no-match', name: label, message: `CreateCraft looked in “${label}” but could not use it. Nothing was saved.` };
    }
    return { kind: 'added', key: app.key, name: app.adapterName ?? app.name, message: `Added ${app.adapterName ?? app.name}${app.version ? ` ${app.version}` : ''} from the location you chose.` };
  }

  // ---- forget ----

  /** Removes the remembered location and the permissions for a program. The program itself is never touched. */
  async forget(key: string): Promise<ForgetResult> {
    const app = (await this.d.manager.list()).find((a) => a.key === key);
    if (!app) throw new Error('That program is not in the list any more.');
    await this.d.manager.disconnect(key);
    await this.d.manager.revoke(key);
    const had = await this.d.state.removePath(app.exePath);
    const scan = await this.d.manager.scan();
    this.lastMissing = scan.missing;
    const still = scan.apps.some((a) => a.key === key);
    const name = app.adapterName ?? app.name;
    return {
      stillDetected: still,
      message: still
        ? `CreateCraft no longer remembers where ${name} is and forgot the permissions you gave it. Windows still lists it as installed, so it appears in the list again.`
        : `Forgot ${name}${had ? ' and its saved location' : ''}. The program itself was not touched. Use Browse to add it back.`,
    };
  }

  markOnboarded(): Promise<unknown> { return this.d.state.markOnboarded(); }
}

function stripInternal(o: KnownOffer): AdapterOffer {
  return { source: o.source, path: o.path, adapterId: o.adapterId, name: o.name, version: o.version, publisherName: o.publisherName, signature: o.signature, publisherTrusted: o.publisherTrusted, permissions: o.permissions };
}

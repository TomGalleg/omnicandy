// BuilderService: the whole life of a privately generated integration.
//
//   create    research -> design -> build -> test (static, security, simulated)   [AI, then OmniCandi's own checks]
//   install   NOT here: the existing review + native confirmation + AdapterPackages.install path is used unchanged
//   verify    live testing of an installed integration against the real program, per command and per program version
//   repair    AI proposes a patch; OmniCandi tests it; the user approves; the old package is kept for rollback
//
// Nothing here trusts, installs or runs generated code on its own. The AI's output is a blueprint (data); OmniCandi's
// templates and validators decide whether a package exists at all.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compareVersions, versionSupported, type ExternalAppInfo, type Permission } from '@shared/integrations';
import {
  BUILDER_PUBLISHER, STAGE_LABEL, STATUS_LABEL,
  type BuilderChangeSummary, type BuilderCommandView, type BuilderFileView, type BuilderOverview, type BuilderProgress, type BuilderProjectDetail, type BuilderProjectSummary,
  type BuilderRequest, type BuilderStage, type BuilderStatus, type CommandVerification, type InstalledProgram, type MyIntegration, type PipelineReport, type RepairProposal, type TemplateId,
} from '@shared/builder';
import type { AdapterPackages } from '../loader';
import type { IntegrationManager } from '../manager';
import { readPackageSource } from '../packageFormat';
import type { AdapterAuthor, AuthorDoc, AuthorRequest } from './author';
import { fetchDocLinks } from './docLinks';
import { BlueprintError, type Blueprint } from './blueprint';
import { EXTERNAL_TEMPLATES } from './assemble';
import { readDocumentation } from './docs';
import { collectDocumentation, DOC_ORIGIN_LABEL, DocsStore, docsForAuthor, type Collected, type Fetcher } from './docsStore';
import { digestOf, mergeDocSources } from './docsIndex';
import { PYTHON_HOSTS } from './hosts';
import { execFile } from 'node:child_process';
import { renderPluginSource } from './templates/plugin';
import { listInstalledPrograms } from './inventory';
import { buildCandidate, type CandidateResult } from './pipeline';
import { BuilderStore, type ProjectRecord } from './store';
import { reportOf } from './validate';

export interface BuilderDeps {
  /** <integrations root>/builder */
  root: string;
  packages: AdapterPackages;
  manager: IntegrationManager;
  /** An author for new work, or a plain-language reason there is none (for example Claude is signed out). */
  author: () => AdapterAuthor | { error: string };
  claude: () => { ready: boolean; reason: string };
  /** A native "are you sure" the renderer cannot answer. */
  confirm: (title: string, detail: string, okLabel: string) => Promise<boolean>;
  emit?: (p: BuilderProgress) => void;
  /** Override the installed-program list (tests). */
  programs?: () => Promise<InstalledProgram[]>;
  readDocs?: typeof readDocumentation;
  /** Reads documentation links the user pasted (tests inject a fake; default fetches public https pages). */
  readLinks?: typeof fetchDocLinks;
  /** How many build attempts Claude gets (the first plus corrections). Default 3. A live test sets it explicitly. */
  maxAttempts?: number;
  /** Downloads documentation (tests inject a fake; default is the real fetcher). */
  docsFetcher?: Fetcher;
  /** Do not collect documentation (tests of other things). */
  skipDocs?: boolean;
  /** Skip the simulated stage (tests of other things). */
  skipSimulation?: boolean;
  /** Where to find a Python-free fallback etc. is decided inside the pipeline; nothing else is injected here. */
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bump = (v: string) => { const p = v.split('.').map(Number); while (p.length < 3) p.push(0); p[2] = (p[2] ?? 0) + 1; return p.join('.'); };
const MAX_ATTEMPTS = 3;

/** Asks a known program for its version (read-only: its own --version option) when detection could not read it. Only programs in OmniCandi's host table. */
async function probeVersion(exePath: string): Promise<string | null> {
  const exe = path.basename(exePath).toLowerCase();
  const host = Object.values(PYTHON_HOSTS).find((h) => h.exeNames.some((e) => e.toLowerCase() === exe));
  if (!host) return null;
  return new Promise((res) => execFile(exePath, host.versionArgs, { timeout: 20_000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '', windir: process.env.windir ?? '', PATH: process.env.PATH ?? '' } }, (_e, out, err) => res(new RegExp(host.versionRegex, 'i').exec(`${out}\n${err}`)?.[1] ?? null)));
}

export class BuilderService {
  readonly store: BuilderStore;
  readonly docs: DocsStore;
  private running = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();

  constructor(private readonly d: BuilderDeps) { this.store = new BuilderStore(d.root); this.docs = new DocsStore(d.root); }

  // ------------------------------------------------------------------ overview

  /** Programs on this PC without a working integration (placeholders and unsupported programs count as "without"). */
  async programs(): Promise<InstalledProgram[]> {
    if (this.d.programs) return this.d.programs();
    const manifests = this.d.manager.manifests().filter((m) => m.maturity !== 'stub');
    const mine = (await this.store.list()).filter((p) => p.installedVersion).map((p) => p.app.exePath ? path.basename(p.app.exePath).toLowerCase() : '');
    return listInstalledPrograms({
      covered: (name, exe) => manifests.some((m) => m.displayNames.some((r) => { try { return new RegExp(r, 'i').test(name); } catch { return false; } }) || (!!exe && m.exeNames.some((e) => e.toLowerCase() === exe.toLowerCase()))) || (!!exe && mine.includes(exe.toLowerCase())),
    });
  }

  async overview(): Promise<BuilderOverview> {
    const projects = await this.store.list();
    return { programs: await this.programs().catch(() => []), projects: await Promise.all(projects.map((p) => this.summary(p))), claude: this.d.claude() };
  }

  // ------------------------------------------------------------------ create

  /** Documentation the user supplied: files and folders they chose, and links they pasted. */
  private async userDocs(req: BuilderRequest): Promise<{ docs: AuthorDoc[]; notes: string[] }> {
    const files = req.documentation?.length ? await (this.d.readDocs ?? readDocumentation)(req.documentation) : { docs: [], notes: [] };
    const links = req.documentationUrls?.length ? await (this.d.readLinks ?? fetchDocLinks)(req.documentationUrls) : { docs: [], notes: [] };
    return { docs: [...files.docs, ...links.docs], notes: [...files.notes, ...links.notes] };
  }

  async create(req: BuilderRequest): Promise<BuilderProjectSummary> {
    const name = req.appName.trim();
    if (!name || name.length > 80) throw new Error('Type the name of the application (up to 80 characters).');
    const rec = await this.store.create({ ...req, appName: name, fromInstalled: !!req.exePath, documentation: req.documentation ?? [] });
    const p = this.run(rec.id).catch(async (e) => { await this.fail(rec.id, errText(e)); });
    this.running.set(rec.id, p.finally(() => { this.running.delete(rec.id); this.aborts.delete(rec.id); }));
    return this.summary(rec);
  }

  /** Resolves when the project has finished its current run (tests and scripts wait on this). */
  async settled(id: string): Promise<BuilderProjectSummary> {
    await this.running.get(id);
    const rec = await this.must(id);
    return this.summary(rec);
  }

  cancel(id: string): void { this.aborts.get(id)?.abort(); }

  private async must(id: string): Promise<ProjectRecord> {
    const r = await this.store.get(id);
    if (!r) throw new Error('That integration project does not exist (any more).');
    return r;
  }

  private async note(rec: ProjectRecord, stage: BuilderStage | null, text: string, status?: BuilderStatus): Promise<void> {
    rec.stage = stage;
    if (status) rec.status = status;
    rec.log.push({ at: new Date().toISOString(), stage, text });
    await this.store.save(rec);
    if (stage) this.d.emit?.({ projectId: rec.id, stage, label: STAGE_LABEL[stage], detail: text, status: rec.status });
  }

  private async fail(id: string, message: string): Promise<void> {
    const rec = await this.store.get(id);
    if (!rec) return;
    rec.status = 'failed';
    rec.error = message;
    rec.log.push({ at: new Date().toISOString(), stage: rec.stage, text: `Stopped: ${message}` });
    await this.store.save(rec);
    this.d.emit?.({ projectId: id, stage: rec.stage ?? 'checking', label: 'Could not be built', detail: message, status: 'failed' });
  }

  private async locateApp(rec: ProjectRecord): Promise<void> {
    let list = await this.d.manager.list().catch(() => [] as ExternalAppInfo[]);
    if (!list.length) list = (await this.d.manager.scan().catch(() => ({ apps: [] as ExternalAppInfo[] }))).apps;
    const wanted = rec.request.appName.toLowerCase();
    const exe = rec.request.exePath?.toLowerCase();
    const hit = list.find((a) => (exe && a.exePath.toLowerCase() === exe)) ?? list.find((a) => a.name.toLowerCase().includes(wanted) || (a.adapterName ?? '').toLowerCase() === wanted);
    if (hit) { rec.app = { installed: true, version: hit.version ?? (await probeVersion(hit.exePath)), exePath: hit.exePath, key: hit.key }; return; }
    const programs = await this.programs().catch(() => [] as InstalledProgram[]);
    const p = programs.find((x) => (exe && x.exePath?.toLowerCase() === exe) || x.name.toLowerCase().includes(wanted));
    if (p) rec.app = { installed: true, version: p.version, exePath: p.exePath, key: null };
    else if (rec.request.exePath) rec.app = { installed: true, version: null, exePath: rec.request.exePath, key: null };
  }

  private async run(id: string): Promise<void> {
    const rec = await this.must(id);
    const ac = new AbortController();
    this.aborts.set(id, ac);
    await this.note(rec, 'checking', 'Looking for the program on this computer.');
    await this.locateApp(rec);
    await this.note(rec, 'checking', rec.app.installed ? `Found ${rec.request.appName}${rec.app.version ? ` ${rec.app.version}` : ''} on this computer.` : `${rec.request.appName} is not installed here, so a candidate will be built and tested with simulations only.`);
    const a = this.d.author();
    if ('error' in a) { rec.nextSteps = [a.error]; await this.fail(id, a.error); return; }
    const docs = await this.userDocs(rec.request);
    rec.docNames = docs.docs.map((x) => x.name);
    for (const n of docs.notes) await this.note(rec, 'checking', n);
    // documentation: official online, official repository, installed with the program, provided by the user (combined, origins tracked)
    let collected: Collected = { docs: [], notes: [], appSlug: '', refreshed: false, outdated: [] };
    if (!this.d.skipDocs) {
      await this.note(rec, 'checking', 'Collecting documentation (official sources first).');
      collected = await collectDocumentation({ store: this.docs, appName: rec.request.appName, appVersion: rec.app.version, installDir: rec.app.exePath ? path.dirname(rec.app.exePath) : null, userDocs: docs.docs, fetcher: this.d.docsFetcher });
      for (const n of collected.notes) await this.note(rec, 'checking', n);
      this.recordDocs(rec, collected);
    }
    const authorDocs = collected.docs.length ? docsForAuthor(collected.docs, (d) => digestOf(d)) : docs.docs;
    const req: AuthorRequest = { appName: rec.request.appName, version: rec.app.version, exePath: rec.app.exePath, goal: rec.request.goal, docs: authorDocs };

    // ---- research
    await this.note(rec, 'researching', 'Claude is reading the vendor documentation.', 'researching');
    const r = await a.research(req, ac.signal);
    this.addUsage(rec, r.value && r.usage);
    for (const n of r.notes ?? []) await this.note(rec, 'researching', `Research adjusted: ${n}`);
    // The collected documents are added to the sources by OmniCandi itself: their origin is known, not claimed.
    r.value = mergeDocSources(r.value, collected.docs);
    rec.research = { ...r.value };
    rec.author = { ...r.author };
    if (r.value.insufficient || !r.value.sourcesConsulted || !r.value.sources.length) {
      rec.nextSteps = [
        r.value.insufficient ? `Not enough trustworthy information was found: ${r.value.insufficient}` : 'No documentation could be read.',
        `Add more documentation and start again: paste links to the specific pages that describe scripting, the command line or the API (not just overview pages), or add the program's documentation or SDK folder (text, HTML or source files). OmniCandi will not guess what the program can do.`,
      ];
      await this.note(rec, 'researching', 'Stopped: not enough documentation.', 'needs-documentation');
      return;
    }
    await this.note(rec, 'researching', `Found ${r.value.sources.length} source${r.value.sources.length === 1 ? '' : 's'} (${r.value.sources.filter((s) => s.kind === 'official').length} official).`);

    // ---- generate, test, and (if the AI can) correct itself a couple of times
    let bp: Blueprint | null = null;
    let cand: CandidateResult | null = null;
    let attempt = 0;
    let problem = '';
    const version = '1.0.0';
    const maxAttempts = this.d.maxAttempts ?? MAX_ATTEMPTS;
    while (attempt < maxAttempts) {
      attempt++;
      await this.note(rec, attempt === 1 ? 'preparing' : 'building', attempt === 1 ? 'Claude is choosing the safest way to connect and writing the connector.' : `Claude is correcting the connector (attempt ${attempt}).`);
      try {
        if (attempt === 1 || !bp) { const g = await a.generate(req, r.value, ac.signal); bp = g.value; this.addUsage(rec, g.usage); for (const n of g.notes ?? []) await this.note(rec, 'preparing', `Blueprint formatting adjusted: ${n}`); }
        else {
          const fix = await a.repair({ request: req, current: bp, docs: docs.docs, problem: { commandId: null, error: problem, evidence: [], appVersion: rec.app.version, declaredVersions: JSON.stringify(bp.application.versions) } }, ac.signal);
          bp = fix.value.blueprint; this.addUsage(rec, fix.usage);
        }
      } catch (e) {
        if (attempt > 1) break; // keep the last candidate and its reports
        throw e;
      }
      bp.research = r.value; // the research stays what the research step found; the generator cannot rewrite it
      rec.decision = { ...bp.decision };
      if (!bp.decision.feasible) {
        rec.nextSteps = [bp.decision.notFeasibleReason ?? 'This program cannot be integrated safely or reliably with what is documented.', 'Nothing was built or installed.'];
        await this.note(rec, 'building', `Stopped: ${bp.decision.notFeasibleReason ?? 'not feasible'}`, 'not-feasible');
        await this.store.writeBlueprint(id, bp);
        return;
      }
      await this.note(rec, 'building', `Building the integration (${bp.decision.template}).`, 'building');
      cand = await buildCandidate(bp, { version, createdAt: new Date().toISOString(), author: { kind: rec.author?.kind === 'scripted' ? 'scripted' : 'claude', note: rec.author?.note }, projectId: id }, {
        simulate: !this.d.skipSimulation, docs: collected.docs, onStage: (s) => { void this.note(rec, s === 'simulated' ? 'testing' : 'building', s === 'static' ? 'Checking the connector.' : s === 'security' ? 'Running security checks.' : 'Testing with a simulated program.', s === 'simulated' ? 'testing' : 'building'); },
      });
      bp = cand.blueprint; // citations may have been completed from the documentation
      for (const a2 of cand.citations.added) await this.note(rec, 'building', `Citation completed from documentation: ${a2.symbol} (${a2.command}) → ${a2.url}`);
      for (const u of cand.citations.unresolved.slice(0, 6)) await this.note(rec, 'building', `No documentation contains ${u.symbol} (${u.command}); it stays uncited.`);
      if (cand.passed) break;
      problem = cand.reports.flatMap((x) => x.checks.filter((c) => c.state === 'failed').map((c) => `[${x.stage}] ${c.title}: ${c.detail}`)).join('\n').slice(0, 3000);
      await this.note(rec, 'testing', `Attempt ${attempt} did not pass: ${problem.split(String.fromCharCode(10)).join(' | ').slice(0, 700)}`);
    }
    if (!bp || !cand) throw new Error('Nothing could be generated.');
    await this.store.writeBlueprint(id, bp);
    rec.reports = cand.reports;
    rec.adapterId = cand.assembled.adapterId;
    rec.version = version;
    rec.decision = { ...bp.decision };
    const template = bp.decision.template as TemplateId;
    if (cand.bytes && cand.files) {
      await this.store.writeVersion(id, version, cand.bytes, bp, cand.reports);
      rec.versions = [{ version, createdAt: new Date().toISOString(), reason: 'First version', sha256: sha(cand.bytes), bytes: cand.bytes.length }];
    }
    if (!cand.passed) {
      rec.nextSteps = ['The checks did not pass, so nothing was made available to install.', 'Open Advanced to see exactly which check failed. You can try again or add documentation.'];
      rec.error = problem.split('\n')[0] ?? 'A check failed.';
      await this.note(rec, 'testing', 'Stopped: a safety or quality check failed.', 'failed');
      return;
    }
    rec.error = null;
    if (!EXTERNAL_TEMPLATES.includes(template)) {
      rec.nextSteps = ['The source for the add-in was generated and checked, but building and installing add-ins is not available yet, so nothing can be installed from it.', 'Advanced shows the generated source files.'];
      await this.note(rec, 'ready', 'Source generated for review only.', 'awaiting-live-verification');
      return;
    }
    if (rec.app.installed) {
      rec.nextSteps = ['Review the permissions and approve the installation. OmniCandi then connects and tests it on the real program.'];
      await this.note(rec, 'ready', 'Ready for your approval.', 'ready-for-approval');
    } else {
      rec.nextSteps = [`${rec.request.appName} is not installed on this computer, so this integration was only tested with simulations. It is saved as "Awaiting live verification".`, `Install ${rec.request.appName}, then open My Custom Integrations and choose "Test on the real program".`];
      await this.note(rec, 'ready', 'Saved. Waiting for the real program to test it.', 'awaiting-live-verification');
    }
  }

  private recordDocs(rec: ProjectRecord, c: Collected): void {
    rec.docs = c.docs.map((d) => ({ origin: d.origin, title: d.title, url: d.url, versionNote: d.versionNote, fetchedAt: d.fetchedAt, bytes: d.bytes, outdated: c.outdated.includes(d.title) }));
    rec.docNames = c.docs.map((d) => d.title);
  }

  /** Downloads the official documentation for this program again (the stored copy is replaced). Nothing else changes. */
  async refreshDocs(id: string): Promise<{ notes: string[]; count: number }> {
    const rec = await this.must(id);
    const docs = await this.userDocs(rec.request);
    const c = await collectDocumentation({ store: this.docs, appName: rec.request.appName, appVersion: rec.app.version, installDir: rec.app.exePath ? path.dirname(rec.app.exePath) : null, userDocs: docs.docs, refresh: true, fetcher: this.d.docsFetcher });
    this.recordDocs(rec, c);
    await this.store.save(rec);
    return { notes: c.notes, count: c.docs.length };
  }

  private addUsage(rec: ProjectRecord, u: { calls: number; costUsd: number } | undefined): void {
    if (!u) return;
    rec.usage = { calls: rec.usage.calls + u.calls, costUsd: rec.usage.costUsd + u.costUsd };
  }

  // ------------------------------------------------------------------ views

  async summary(rec: ProjectRecord): Promise<BuilderProjectSummary> {
    const ver = await this.store.verifications(rec.id);
    const bp = await this.store.readBlueprint(rec.id, rec.version ?? undefined);
    const ids = bp ? bp.commands.map((c) => c.id) : [];
    const all = ['app.health', ...ids];
    const current = ver.filter((v) => all.includes(v.commandId));
    const verified = current.filter((v) => v.state === 'verified').length;
    const failed = current.filter((v) => v.state === 'failed').length;
    const perms = new Set<Permission>();
    if (bp) for (const c of bp.commands) for (const p of c.permissions) perms.add(p);
    const pkg = rec.version && rec.versions.some((v) => v.version === rec.version) && EXTERNAL_TEMPLATES.includes((rec.decision?.template ?? 'python-script') as TemplateId) ? this.store.packagePath(rec.id, rec.version) : null;
    const installed = !!rec.installedVersion;
    return {
      id: rec.id, appName: rec.request.appName, publisher: rec.research?.application.publisher ?? null, createdAt: rec.createdAt, updatedAt: rec.updatedAt,
      status: rec.status, statusLabel: STATUS_LABEL[rec.status], headline: this.headline(rec, verified, failed, ids.length + 1), stage: rec.stage, adapterId: rec.adapterId, version: rec.version,
      integrationType: rec.decision?.type ?? null, template: (rec.decision?.template as TemplateId | undefined) ?? null, commandCount: ids.length,
      permissions: [...perms].sort(), appInstalled: rec.app.installed, appVersion: rec.app.version, installed,
      verification: { verified, failed, untested: Math.max(0, all.length - verified - failed) }, packagePath: pkg, error: rec.error,
    };
  }

  private headline(rec: ProjectRecord, verified: number, failed: number, total: number): string {
    const n = rec.request.appName;
    switch (rec.status) {
      case 'researching': return `Researching how to connect ${n}…`;
      case 'building': return `Building the integration for ${n}…`;
      case 'testing': return `Testing the ${n} integration safely…`;
      case 'needs-documentation': return `Not enough documentation was found for ${n}.`;
      case 'not-feasible': return `${n} cannot be integrated safely or reliably.`;
      case 'failed': return `The ${n} integration could not be built.`;
      case 'ready-for-approval': return `The ${n} integration is ready for your approval.`;
      case 'awaiting-live-verification': return `Built and tested with simulations only. Waiting for the real ${n}.`;
      case 'installed': return `Installed. Not tested on the real ${n} yet.`;
      case 'live-verified': return `${verified} of ${total} commands tested on the real ${n}.`;
      case 'needs-repair': return `${failed} command${failed === 1 ? '' : 's'} failed on the real ${n}. Repair is available.`;
    }
  }

  async detail(id: string): Promise<BuilderProjectDetail> {
    const rec = await this.must(id);
    const base = await this.summary(rec);
    const bp = await this.store.readBlueprint(id, rec.version ?? undefined);
    const needsProject = bp && bp.decision.template === 'python-script' ? bp.python?.custom?.projectExtension ?? null : null;
    const ver = await this.store.verifications(id);
    const commands: BuilderCommandView[] = (bp?.commands ?? []).map((c) => ({
      id: c.id, label: c.label, description: c.description, permissions: [...c.permissions], destructive: !!c.destructive,
      readOnly: c.python ? !c.python.outputExtensions.length && !c.permissions.includes('modify-project') : !c.permissions.some((p) => p === 'write-files' || p === 'modify-project'),
      verifications: ver.filter((v) => v.commandId === c.id),
    }));
    const files: BuilderFileView[] = [];
    if (rec.version && rec.versions.some((v) => v.version === rec.version)) {
      const loaded = await readPackageSource(this.store.packagePath(id, rec.version)).catch(() => null);
      for (const [p, b] of [...(loaded?.files ?? new Map<string, Buffer>()).entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
        files.push({ path: p, bytes: b.length, role: p === 'adapter.json' ? 'manifest' : p === 'main.js' ? 'connector' : p.endsWith('.py') ? 'program-script' : p.startsWith('docs/') ? 'docs' : p.startsWith('tests/') ? 'tests' : 'other', text: b.length < 200_000 ? b.toString('utf8') : null });
      }
    } else if (bp?.plugin) {
      for (const [pth, b] of renderPluginSource(bp)) files.push({ path: pth, bytes: b.length, role: 'plugin', text: b.toString('utf8') });
    }
    const tested = [...new Set(ver.filter((v) => v.state === 'verified').map((v) => v.appVersion))];
    const declared = bp?.application.versions.length ? bp.application.versions.map((r) => `${r.min ?? ''}–${r.max ?? ''}`).join(', ') : 'not declared';
    return {
      ...base,
      needsProject,
      request: { appName: rec.request.appName, fromInstalled: rec.request.fromInstalled, exePath: rec.request.exePath ?? null, documentation: rec.docNames },
      research: rec.research, decision: rec.decision, commands, reports: rec.reports, files,
      versions: rec.versions.map((v) => ({ version: v.version, createdAt: v.createdAt, reason: v.reason, sha256: v.sha256, current: v.version === rec.version, installed: v.version === rec.installedVersion, verifiedCommands: ver.filter((x) => x.state === 'verified').length })),
      log: rec.log, nextSteps: rec.nextSteps, userGuide: bp?.userGuide ?? null,
      compatibility: { declared, tested, note: tested.length ? `Commands were run and checked on ${tested.join(', ')}. Other versions in the declared range have not been tested.` : 'Not tested on any real version yet.' },
      usage: rec.usage, proposal: rec.proposal,
      documentation: (rec.docs ?? []).map((x) => ({ ...x, originLabel: DOC_ORIGIN_LABEL[x.origin as keyof typeof DOC_ORIGIN_LABEL] ?? x.origin })),
    };
  }

  // ------------------------------------------------------------------ installed state

  /** Called after the user installed (or updated) the package through the normal install flow. Reads the truth from the installer. */
  async syncInstalled(id: string): Promise<BuilderProjectSummary> {
    const rec = await this.must(id);
    const listing = await this.d.packages.listing();
    const inst = listing.installed.find((x) => x.id === rec.adapterId);
    if (!inst) { rec.installedVersion = null; if (['installed', 'live-verified', 'needs-repair'].includes(rec.status)) rec.status = rec.app.installed ? 'ready-for-approval' : 'awaiting-live-verification'; await this.store.save(rec); return this.summary(rec); }
    // A repair proposal that was just installed becomes the current version.
    if (rec.proposal && inst.version === rec.proposal.toVersion) await this.promoteProposal(rec);
    rec.installedVersion = inst.version;
    rec.approvedPermissions = [...inst.approvedPermissions];
    const s = await this.summary(rec);
    rec.status = s.verification.failed ? 'needs-repair' : s.verification.verified ? 'live-verified' : 'installed';
    rec.nextSteps = rec.status === 'installed' ? ['Connect it, then run "Test on the real program" so the commands are checked for real.'] : rec.nextSteps;
    await this.store.save(rec);
    return this.summary(rec);
  }

  // ------------------------------------------------------------------ live verification (stage 4)

  /** Runs the blueprint's live tests against the real, installed program through the same manager Claude uses. */
  async verifyLive(id: string, opts: { independent?: (commandId: string, result: import('@shared/integrations').CommandResult) => Promise<string[]>; project?: string } = {}): Promise<PipelineReport> {
    const rec = await this.must(id);
    const bp = await this.store.readBlueprint(id, rec.version ?? undefined);
    if (!bp || !rec.adapterId) throw new Error('This integration has not been built yet.');
    const inst = (await this.d.packages.listing()).installed.find((x) => x.id === rec.adapterId);
    if (!inst) throw new Error('Install the integration first (Review and approve), then test it on the real program.');
    const checks: PipelineReport['checks'] = [];
    const add = (state: 'passed' | 'failed' | 'warning' | 'skipped', cid: string, title: string, detail: string) => checks.push({ id: cid, title, state, detail });
    await this.note(rec, 'connecting', 'Connecting to the real program.');
    const scan = await this.d.manager.scan();
    const app = scan.apps.find((x) => x.adapterId === rec.adapterId);
    if (!app) {
      add('failed', 'find', 'Find the program', `${rec.request.appName} was not found on this computer, so nothing was tested. Install it or use Browse for Application.`);
      return this.finishLive(rec, bp, checks, null);
    }
    rec.app = { installed: true, version: app.version, exePath: app.exePath, key: app.key };
    let appVersion = app.version ?? 'unknown';
    try {
      const info = await this.d.manager.connect(app.key);
      const v = await this.d.manager.verify(app.key);
      appVersion = v.version ?? info.version ?? appVersion;
      if (!v.ok) throw new Error(v.detail);
      add('passed', 'connect', 'Connect and verify the version', `Connected to the real ${rec.request.appName} ${appVersion}.`);
    } catch (e) {
      add('failed', 'connect', 'Connect and verify the version', errText(e));
      return this.finishLive(rec, bp, checks, appVersion);
    }
    const range = versionSupported(appVersion === 'unknown' ? null : appVersion, bp.application.versions[0] ?? {}, bp.application.versions);
    if (range === 'too-old' || range === 'too-new') add('warning', 'range', 'Declared compatibility', `Version ${appVersion} is outside the range this integration declares. Results below apply to this version only.`);

    const record = async (commandId: string, state: CommandVerification['state'], evidence: string[], detail: string) => {
      await this.store.recordVerification(id, { commandId, appVersion, state, at: new Date().toISOString(), evidence, detail });
    };
    // A program that works with project files is tested on the project the user names (never one made up).
    const projectExt = bp.decision.template === 'python-script' ? bp.python?.custom?.projectExtension ?? null : null;
    if (projectExt && !opts.project?.trim()) {
      add('failed', 'project', 'Project file for the test', `${rec.request.appName} works with project files. Enter the full path of a ${projectExt} file in "Project for the live test", then test again. Use a copy or a test project: the commands may change it.`);
      return this.finishLive(rec, bp, checks, appVersion);
    }
    const exec = async (commandId: string, params: Record<string, unknown>) => this.d.manager.execute(app.key, commandId, projectExt ? { ...params, project: opts.project!.trim() } : params);

    const health = await exec('app.health', {});
    if (health.ok && health.verified) { add('passed', 'health', 'Connection check command', health.message); await record('app.health', 'verified', health.evidence, health.message); }
    else { add('failed', 'health', 'Connection check command', health.error?.message ?? health.message); await record('app.health', 'failed', [], health.error?.message ?? health.message); }

    // reads first, then the small safe edits; unique names so nothing is ever overwritten
    const suffix = `-${Date.now().toString(36).slice(-5)}`;
    const uniq = (p: Record<string, string | number | boolean>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'string' && /name|file|document|output|stem|title/i.test(k) ? v.replace(/^([A-Za-z0-9][A-Za-z0-9 _-]{0,40})(\.[A-Za-z0-9]{1,8})?$/, `$1${suffix}$2`) : v]));
    const order = [...bp.commands].filter((c) => c.liveTest).sort((a, b) => (a.liveTest!.kind === b.liveTest!.kind ? 0 : a.liveTest!.kind === 'edit' ? -1 : 1));
    // an edit that creates a file must run before the read that opens it
    for (const c of order) {
      const r = await exec(c.id, uniq(c.liveTest!.params));
      if (!r.ok) { add('failed', `cmd:${c.id}`, `Command ${c.id}`, `${r.error?.kind}: ${r.error?.message}`); await record(c.id, 'failed', r.evidence, r.error?.message ?? r.message); continue; }
      const evidence = [...r.evidence];
      let extra = true;
      if (opts.independent) {
        try { evidence.push(...(await opts.independent(c.id, r)).map((e) => `outside check: ${e}`)); } catch (e) { extra = false; evidence.push(`outside check FAILED: ${errText(e)}`); }
      }
      const independent = evidence.some((e) => /independent check/.test(e)) || bp.decision.template === 'file-exchange';
      const good = r.verified && independent && extra;
      add(good ? 'passed' : 'failed', `cmd:${c.id}`, `Command ${c.id}`, good ? `${r.message} Verified by an independent re-check.` : 'The command ran, but its result could not be independently verified, so it is not marked tested.');
      await record(c.id, good ? 'verified' : 'failed', evidence, r.message);
    }
    // recovery: drop the connection and connect again
    try {
      await this.d.manager.disconnect(app.key);
      await this.d.manager.connect(app.key);
      const v2 = await this.d.manager.verify(app.key);
      add(v2.ok ? 'passed' : 'failed', 'recovery', 'Connection recovery', v2.ok ? 'After disconnecting, it connected and passed the health check again.' : v2.detail);
    } catch (e) { add('failed', 'recovery', 'Connection recovery', errText(e)); }
    add('skipped', 'app-closed', 'Behaviour when the program closes', 'Each command starts the program by itself and the program exits afterwards, so there is no long-lived session to lose. (Not applicable to this integration type.)');
    return this.finishLive(rec, bp, checks, appVersion);
  }

  private async finishLive(rec: ProjectRecord, _bp: Blueprint, checks: PipelineReport['checks'], appVersion: string | null): Promise<PipelineReport> {
    const report = reportOf('live', `Live testing on the real program${appVersion ? ` (${appVersion})` : ''}`, checks);
    rec.reports = [...rec.reports.filter((r) => r.stage !== 'live'), report];
    const s = await this.summary(rec);
    rec.status = report.state === 'failed' || s.verification.failed ? 'needs-repair' : s.verification.verified ? 'live-verified' : 'installed';
    rec.nextSteps = rec.status === 'live-verified' ? [] : rec.status === 'needs-repair' ? ['Some commands failed on the real program. Use "Repair integration" to let Claude propose a fix. You approve it before anything changes.'] : rec.nextSteps;
    await this.note(rec, report.state === 'failed' ? 'connecting' : 'connected', report.state === 'failed' ? 'Live testing found problems.' : 'Connected and tested.');
    return report;
  }

  // ------------------------------------------------------------------ repair / update / rollback

  /** AI-assisted repair. Builds and tests a patched package and returns a proposal; nothing is installed. */
  async propose(id: string, why: { commandId?: string | null; error?: string } = {}): Promise<RepairProposal> {
    const rec = await this.must(id);
    const bp = await this.store.readBlueprint(id, rec.version ?? undefined);
    if (!bp || !rec.version) throw new Error('This integration has not been built yet.');
    const a = this.d.author();
    if ('error' in a) throw new Error(a.error);
    const ver = await this.store.verifications(id);
    const failedV = ver.find((v) => v.state === 'failed' && (!why.commandId || v.commandId === why.commandId));
    const commandId = why.commandId ?? failedV?.commandId ?? null;
    const error = why.error ?? failedV?.detail ?? 'No command failed; checking the integration against the installed program version.';
    const evidence = failedV?.evidence ?? [];
    const app = (await this.d.manager.list().catch(() => [])).find((x) => x.adapterId === rec.adapterId);
    const userDocs = rec.request.documentation?.length ? await (this.d.readDocs ?? readDocumentation)(rec.request.documentation) : { docs: [], notes: [] };
    const coll = this.d.skipDocs ? null : await collectDocumentation({ store: this.docs, appName: rec.request.appName, appVersion: app?.version ?? rec.app.version, userDocs: userDocs.docs, fetcher: this.d.docsFetcher });
    const docs = { docs: coll?.docs.length ? docsForAuthor(coll.docs, (d) => digestOf(d)) : userDocs.docs, notes: userDocs.notes };
    const req: AuthorRequest = { appName: rec.request.appName, version: app?.version ?? rec.app.version, exePath: rec.app.exePath, goal: rec.request.goal, docs: docs.docs };
    const diagnosis = [
      `Failing command: ${commandId ?? 'none (compatibility check)'}`, `Error: ${error}`,
      `Installed program version: ${app?.version ?? rec.app.version ?? 'unknown'}; declared: ${bp.application.versions.map((r) => `${r.min ?? ''}–${r.max ?? ''}`).join(', ') || 'not declared'}`,
      `Documentation consulted: ${bp.research.sources.map((s) => s.url).join(', ') || 'none'}`,
    ];
    await this.note(rec, 'building', 'Claude is preparing a fix.');
    const fix = await a.repair({ request: req, current: bp, docs: docs.docs, problem: { commandId, error, evidence, appVersion: app?.version ?? rec.app.version, declaredVersions: JSON.stringify(bp.application.versions) } });
    this.addUsage(rec, fix.usage);
    const next = fix.value.blueprint;
    const toVersion = bump(rec.version);
    const cand = await buildCandidate(next, { version: toVersion, createdAt: new Date().toISOString(), author: { kind: 'repair', note: fix.author.note }, projectId: id }, { simulate: !this.d.skipSimulation, docs: coll?.docs });
    const changes = await diffBlueprints(bp, next, fix.value.changes);
    const dir = this.store.proposalDir(id);
    await fs.rm(dir, { recursive: true, force: true });
    let packagePath: string | null = null;
    if (cand.bytes) {
      await fs.mkdir(dir, { recursive: true });
      packagePath = path.join(dir, 'package.ccadapter');
      await fs.writeFile(packagePath, cand.bytes);
      await fs.writeFile(path.join(dir, 'blueprint.json'), JSON.stringify(next, null, 2));
      await fs.writeFile(path.join(dir, 'reports.json'), JSON.stringify(cand.reports, null, 2));
    }
    const proposal: RepairProposal = { projectId: id, fromVersion: rec.version, toVersion, problem: error, diagnosis, changes, reports: cand.reports, packagePath, passed: cand.passed && !!packagePath };
    rec.proposal = proposal;
    await this.note(rec, 'ready', proposal.passed ? 'A fix is ready for your review.' : 'The proposed fix did not pass the checks.');
    return proposal;
  }

  private async promoteProposal(rec: ProjectRecord): Promise<void> {
    const p = rec.proposal;
    if (!p?.packagePath) return;
    const dir = this.store.proposalDir(rec.id);
    const bytes = await fs.readFile(p.packagePath);
    const bp = JSON.parse(await fs.readFile(path.join(dir, 'blueprint.json'), 'utf8')) as Blueprint;
    const reports = JSON.parse(await fs.readFile(path.join(dir, 'reports.json'), 'utf8')) as PipelineReport[];
    await this.store.writeVersion(rec.id, p.toVersion, bytes, bp, reports);
    await this.store.writeBlueprint(rec.id, bp);
    rec.versions.push({ version: p.toVersion, createdAt: new Date().toISOString(), reason: p.problem.slice(0, 160), sha256: sha(bytes), bytes: bytes.length });
    rec.version = p.toVersion;
    rec.reports = [...p.reports, ...rec.reports.filter((r) => r.stage === 'live')];
    // Commands whose code or settings changed must be tested again; unchanged ones keep their (per program version) record.
    await this.store.clearVerifications(rec.id, [...p.changes.changed, ...p.changes.added]);
    rec.proposal = null;
    await fs.rm(dir, { recursive: true, force: true });
  }

  async discardProposal(id: string): Promise<void> {
    const rec = await this.must(id);
    rec.proposal = null;
    await fs.rm(this.store.proposalDir(id), { recursive: true, force: true });
    await this.store.save(rec);
  }

  /** Puts an earlier package version back (uninstalls the current one, installs the saved one) after a native confirmation. */
  async rollback(id: string, version: string): Promise<BuilderProjectSummary> {
    const rec = await this.must(id);
    const target = rec.versions.find((v) => v.version === version);
    if (!target || !rec.adapterId) throw new Error('That version is not saved.');
    const file = this.store.packagePath(id, version);
    const review = await this.d.packages.review(file);
    if (review.problems.length && !review.problems.every((p) => /older|already installed/i.test(p))) throw new Error(`The saved version cannot be installed: ${review.problems.join('; ')}`);
    const ok = await this.d.confirm('Go back to an earlier version?', `${rec.request.appName} integration ${rec.installedVersion ?? rec.version} will be removed and version ${version} restored from your saved copy. Its permissions (${(rec.approvedPermissions.length ? rec.approvedPermissions : review.permissions).join(', ') || 'none'}) are the ones you approved before.`, 'Go back');
    if (!ok) throw new Error('Cancelled. Nothing was changed.');
    if ((await this.d.packages.listing()).installed.some((x) => x.id === rec.adapterId)) await this.d.packages.uninstall(rec.adapterId);
    await this.d.packages.install(file, { permissions: (rec.approvedPermissions.length ? rec.approvedPermissions : review.permissions) as Permission[], allowUnsigned: true });
    rec.version = version;
    rec.installedVersion = version;
    const bp = await this.store.readBlueprint(id, version);
    if (bp) await this.store.writeBlueprint(id, bp);
    await this.store.save(rec);
    return this.syncInstalled(id);
  }

  /** Removes the installed integration. The project (and its saved versions) stays so it can be installed again. */
  async removeIntegration(id: string): Promise<BuilderProjectSummary> {
    const rec = await this.must(id);
    if (rec.adapterId && (await this.d.packages.listing()).installed.some((x) => x.id === rec.adapterId)) await this.d.packages.uninstall(rec.adapterId);
    rec.installedVersion = null;
    rec.status = rec.app.installed ? 'ready-for-approval' : 'awaiting-live-verification';
    await this.store.save(rec);
    return this.summary(rec);
  }

  async deleteProject(id: string): Promise<void> {
    const rec = await this.must(id);
    if (rec.installedVersion) throw new Error('Remove the installed integration first.');
    await this.store.delete(id);
  }

  // ------------------------------------------------------------------ My Integrations

  async mine(): Promise<MyIntegration[]> {
    const listing = await this.d.packages.listing();
    const projects = await this.store.list();
    const out: MyIntegration[] = [];
    for (const i of listing.installed) {
      const p = projects.find((x) => x.adapterId === i.id);
      const custom = !!p || i.publisherName === BUILDER_PUBLISHER;
      const s = p ? await this.summary(p) : null;
      out.push({
        adapterId: i.id, name: i.name, version: i.version, origin: custom ? 'custom' : 'official', publisher: i.publisherName, signed: !!i.fingerprint, enabled: i.enabled, state: i.state, stateDetail: i.stateDetail,
        integrationType: i.integrationType, commandCount: i.commandCount, projectId: p?.id ?? null, status: s?.status ?? null,
        verification: s ? { ...s.verification, summary: s.verification.verified ? `${s.verification.verified} command${s.verification.verified === 1 ? '' : 's'} tested on the real program` : 'Not tested on the real program yet' } : null,
      });
    }
    return out;
  }

  /** Is the installed program newer/older than anything this integration was tested on? */
  async compatibility(id: string): Promise<{ appVersion: string | null; tested: string[]; needsCheck: boolean; message: string }> {
    const rec = await this.must(id);
    const ver = await this.store.verifications(id);
    const tested = [...new Set(ver.filter((v) => v.state === 'verified').map((v) => v.appVersion))];
    const app = (await this.d.manager.list().catch(() => [])).find((x) => x.adapterId === rec.adapterId);
    const v = app?.version ?? null;
    const needsCheck = !!v && !tested.some((t) => compareVersions(t, v) === 0);
    return { appVersion: v, tested, needsCheck, message: !v ? 'The program version could not be read.' : needsCheck ? `${rec.request.appName} ${v} has not been tested with this integration${tested.length ? ` (tested: ${tested.join(', ')})` : ''}. Run the live test or ask for an update.` : `Tested on ${v}.` };
  }
}

/** Plain list of what differs between two blueprints. */
export async function diffBlueprints(a: Blueprint, b: Blueprint, aiNotes: string[] = []): Promise<BuilderChangeSummary> {
  const byId = (bp: Blueprint) => new Map(bp.commands.map((c) => [c.id, c]));
  const A = byId(a), B = byId(b);
  const added = [...B.keys()].filter((k) => !A.has(k));
  const removed = [...A.keys()].filter((k) => !B.has(k));
  const changed = [...B.keys()].filter((k) => A.has(k) && JSON.stringify(A.get(k)) !== JSON.stringify(B.get(k)));
  const perms = (bp: Blueprint) => new Set(bp.commands.flatMap((c) => c.permissions));
  const pa = perms(a), pb = perms(b);
  return {
    added, removed, changed,
    newPermissions: [...pb].filter((p) => !pa.has(p)).sort(),
    removedPermissions: [...pa].filter((p) => !pb.has(p)).sort(),
    notes: aiNotes,
  };
}

export { BlueprintError };

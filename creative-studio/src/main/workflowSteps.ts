// What a workflow run does for real, per file: pick the library files (or import a folder),
// run app edits in the background and export with Deliver presets. App edits use the same
// verified quick edits as the Edit/Color/Effects/Audio tabs, run with NO window:
//  - PhotoCraft, VectorCraft, SoundCraft through their headless command-line tools (AppEditors);
//  - FilmCraft, LightCraft, EffectCraft, DesignCraft through their CLI's own MCP engine (headless).
// Results are always new versions (library) or new files (exports); nothing is overwritten.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkEditValues, EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { deliverGroupFor, presetById, presetsFor } from '@shared/deliver';
import type { StepRequest } from '@shared/workflowRunner';
import { AppEditors } from './appEditors';
import type { DeliverQueue } from './deliver';
import { LiveDesignCraft, LiveEffectCraft, LiveFilmCraft, LiveLightCraft, LivePdfCraft, LiveWordCraft, LiveGridCraft } from './liveApps';
import { IMPORTABLE_EXTENSIONS } from './media';
import type { ProjectStore } from './projectStore';

type Engine = LiveFilmCraft | LiveLightCraft | LiveEffectCraft | LiveDesignCraft | LiveWordCraft | LivePdfCraft | LiveGridCraft;
const ENGINES: Partial<Record<EditorAppId, (o: ConstructorParameters<typeof LiveFilmCraft>[0]) => Engine>> = {
  filmcraft: (o) => new LiveFilmCraft(o),
  lightcraft: (o) => new LiveLightCraft(o),
  effectcraft: (o) => new LiveEffectCraft(o),
  designcraft: (o) => new LiveDesignCraft(o),
  wordcraft: (o) => new LiveWordCraft(o),
  gridcraft: (o) => new LiveGridCraft(o),
  pdfcraft: (o) => new LivePdfCraft(o),
};
const CLI_APPS = new Set<EditorAppId>(['photocraft', 'vectorcraft', 'soundcraft']);

export interface WorkflowStepsDeps {
  store: ProjectStore;
  installDir: (app: EditorAppId) => string;
  deliver: () => Promise<DeliverQueue>;
}

/** One run's real side effects. Call close() when the run ends (stops the background engines). */
export class WorkflowSteps {
  private readonly engines = new Map<EditorAppId, Engine>();
  private readonly editors: AppEditors;
  private readonly runDir: string;

  constructor(private readonly d: WorkflowStepsDeps) {
    this.editors = new AppEditors(d.store);
    this.runDir = path.join(d.store.root, 'work', 'workflow', randomUUID().slice(0, 8));
  }

  /** The Files step: chosen library files, or every supported file in a folder (copied into the library). */
  async resolveImport(params: Record<string, string>): Promise<Array<{ assetId: string; name: string }>> {
    const manifest = await this.d.store.loadManifest();
    if (params.mode === 'folder') {
      const dir = params.folder ?? '';
      if (!path.isAbsolute(dir)) throw new Error('Choose a folder.');
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => { throw new Error(`Can't read the folder ${dir}.`); });
      const files = entries.filter((e) => e.isFile() && IMPORTABLE_EXTENSIONS.includes(path.extname(e.name).slice(1).toLowerCase()))
        .map((e) => path.join(dir, e.name)).sort();
      if (!files.length) throw new Error('The folder has no files CreateCraft can open.');
      const out = [];
      for (const f of files.slice(0, 200)) {
        const r = await this.d.store.importFile(f, { origin: 'imported', source: `Imported by a workflow from ${dir}` });
        const id = r.duplicateOf ?? r.asset.id;
        out.push({ assetId: id, name: (await this.d.store.loadManifest()).assets.find((a) => a.id === id)?.name ?? path.basename(f) });
      }
      return out;
    }
    let ids: string[] = [];
    try { ids = JSON.parse(params.assetIds || '[]') as string[]; } catch { /* none */ }
    if (!ids.length && params.assetId) ids = [params.assetId];
    return ids.map((id) => {
      const a = manifest.assets.find((x) => x.id === id);
      if (!a) throw new Error('A chosen file is no longer in the library.');
      return { assetId: a.id, name: a.name };
    });
  }

  /** Runs one quick edit on the first of `inputs` the app can open; returns the new versions, main first. */
  async applyStep(step: StepRequest, inputs: string[]): Promise<{ assetIds: string[]; message: string }> {
    const app = EDITOR_APPS[step.appId as EditorAppId];
    if (!app) throw new Error(`Unknown app "${step.appId}".`);
    const op = app.quickEdits.find((o) => o.id === step.opId);
    if (!op) throw new Error(`${app.name} has no edit "${step.opId}".`);
    const check = checkEditValues(op, step.values);
    if (!check.ok) throw new Error(check.reason);
    const assets = (await this.d.store.loadManifest()).assets;
    const a = inputs.map((id) => assets.find((x) => x.id === id)).find((x) => x && app.formats.includes(x.sourceFormat.toLowerCase()));
    if (!a) {
      const first = assets.find((x) => x.id === inputs[0]);
      throw new Error(`${app.name} can't open ${first ? `${first.sourceFormat.toUpperCase()} files` : 'this file'}.`);
    }

    if (CLI_APPS.has(app.id)) {
      const r = await this.editors.apply(a.id, op.id, check.values);
      return { assetIds: r.assetIds, message: `${op.label} (${app.name})` };
    }

    const make = ENGINES[app.id];
    if (!make) throw new Error(`${app.name} can't run in a workflow.`);
    let engine = this.engines.get(app.id);
    if (!engine) {
      engine = make({ installDir: this.d.installDir(app.id), readRoot: this.d.store.root, writeRoot: path.join(this.runDir, app.id), headless: true });
      this.engines.set(app.id, engine);
    }
    await engine.ensureStarted();
    await engine.open(await this.d.store.resolveAssetPath(a.id));
    for (const s of await engine.quickEditSteps!(op.id, check.values)) await engine.run(s);
    const out = path.join(this.runDir, app.id, 'out');
    await fs.mkdir(out, { recursive: true });
    const files: { main: string; preview?: string } = await engine.writeVersion(out, randomUUID().slice(0, 8));
    const base = a.name.replace(/\.[^.]+$/, '');
    const tag = op.label.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    const settings = op.params.map((p) => `${p.label} ${check.values[p.key]}${p.type === 'number' && p.unit ? p.unit : ''}`).join(', ');
    const source = `${app.name} (workflow, no window): ${op.label}${settings ? ` (${settings})` : ''}`;
    const main = await this.d.store.addDerivedFile(files.main, { name: await this.freeName(`${base}-${tag}`, path.extname(files.main).slice(1)), parentId: a.id, provenance: { origin: 'generated', source } });
    const ids = [main.id];
    if (files.preview) {
      ids.push((await this.d.store.addDerivedFile(files.preview, { name: await this.freeName(`${base}-${tag}`, 'png'), parentId: main.id, provenance: { origin: 'generated', source: `PNG of ${main.name}` } })).id);
    }
    return { assetIds: ids, message: `${op.label} (${app.name})` };
  }

  /** Exports with Deliver presets, each from the first of `inputs` it fits; returns the exported names. */
  async deliver(inputs: string[], presetIds: string[]): Promise<string[]> {
    const assets = (await this.d.store.loadManifest()).assets;
    const byInput = new Map<string, string[]>();
    for (const pid of presetIds) {
      const p = presetById(pid);
      if (!p) throw new Error(`Unknown export format "${pid}".`);
      const a = inputs.map((id) => assets.find((x) => x.id === id)).find((x) => x && presetsFor(x.sourceFormat).some((q) => q.id === pid));
      if (a) byInput.set(a.id, [...(byInput.get(a.id) ?? []), pid]); // formats that don't fit this file are skipped
    }
    if (!byInput.size) {
      const first = assets.find((x) => x.id === inputs[0]);
      throw new Error(`None of the chosen formats fit ${first ? `a ${deliverGroupFor(first.sourceFormat) ?? first.sourceFormat.toUpperCase()} file` : 'this file'}.`);
    }
    const q = await this.d.deliver();
    const jobs = [];
    for (const [assetId, ps] of byInput) jobs.push(...(await q.enqueue(assetId, ps, 'workflow')));
    const done = await q.wait(jobs.map((j) => j.id));
    const bad = done.filter((j) => j.status !== 'done');
    if (bad.length) throw new Error(bad.map((j) => `${j.presetLabel}: ${j.error ?? j.status}`).join('; '));
    return done.map((j) => j.output!);
  }

  private async freeName(base: string, ext: string): Promise<string> {
    const names = new Set((await this.d.store.loadManifest()).assets.map((a) => a.name));
    for (let i = 1; ; i++) { const n = `${base}${i === 1 ? '' : `-${i}`}.${ext}`; if (!names.has(n)) return n; }
  }

  /** Stops the background engines this run started and removes its scratch folder. */
  async close() {
    for (const e of this.engines.values()) e.killApp();
    this.engines.clear();
    await new Promise((r) => setTimeout(r, 300));
    await fs.rm(this.runDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

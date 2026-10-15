// Deliver: an export queue that turns library files into finished files with the ArtCraft apps'
// own command-line tools, headless (no app window opens). One job runs at a time; each one writes
// a new file into the project's exports/ folder (never over an earlier export) and records the
// source, its version history, the preset and a checksum in exports/manifest.json.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { lineage, MANIFEST_FILE, presetById, presetsFor, type DeliverJob, type DeliverPreset, type DeliverRecord } from '@shared/deliver';
import type { Asset } from '@shared/types';
import { kindForExtension } from './media';
import { sha256File, type ProjectStore } from './projectStore';

const LONG_EDGE_WEB = 1920;

export interface DeliverCommand {
  app: EditorAppId;
  args: string[];
  /** FilmCraft: `run` script lines, written to `scriptPath` before the tool starts. */
  script?: Array<{ id: string; params: Record<string, unknown> }>;
  scriptPath?: string;
  /** PdfCraft: a `run --script` file (JSON array of {tool, args}), written to `scriptPath` before the tool starts. */
  jsonScript?: Array<{ tool: string; args: Record<string, unknown> }>;
  /** The tool writes nothing when there is nothing to do (a PDF that can't be made smaller): copy the source instead. */
  copyIfNoOutput?: string;
}

/** The deepest folder that contains both files (PdfCraft's --root must cover the source and the output). */
function commonFolder(a: string, b: string): string {
  const pa = path.dirname(a).split(path.sep);
  const pb = path.dirname(b).split(path.sep);
  const n: string[] = [];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i]!.toLowerCase() === pb[i]!.toLowerCase(); i++) n.push(pa[i]!);
  return n.join(path.sep) || path.dirname(a);
}

/** The command line for one export (pure; every form here was verified against the installed tools). */
export function deliverCommand(p: DeliverPreset, src: string, out: string, a: Pick<Asset, 'width' | 'height'>, tmp: string): DeliverCommand {
  switch (p.id) {
    case 'image-png': case 'image-tiff': case 'image-psd': return { app: 'photocraft', args: ['convert', src, out] };
    case 'image-jpg': return { app: 'photocraft', args: ['convert', src, out, '--quality', '92'] };
    case 'image-webp': return { app: 'photocraft', args: ['convert', src, out, '--quality', '85'] };
    case 'image-web': {
      const w = a.width ?? 0, h = a.height ?? 0;
      const long = Math.max(w, h);
      if (long <= LONG_EDGE_WEB) return { app: 'photocraft', args: ['convert', src, out, '--quality', '80'] };
      const k = LONG_EDGE_WEB / long;
      const size = { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
      return { app: 'photocraft', args: ['run', src, '--cmd', 'image.imageSize', '--params', JSON.stringify(size), '--out', out, '--quality', '80'] };
    }
    case 'vector-svg': case 'vector-pdf': case 'vector-png': case 'vector-eps': return { app: 'vectorcraft', args: ['convert', src, out] };
    case 'vector-png2x': return { app: 'vectorcraft', args: ['convert', src, out, '--scale', '2'] };
    case 'audio-wav': return { app: 'soundcraft', args: ['convert', src, out, '--bit-depth', '24'] };
    case 'audio-cd': return { app: 'soundcraft', args: ['convert', src, out, '--bit-depth', '16', '--rate', '44100'] };
    case 'audio-normalized': return { app: 'soundcraft', args: ['convert', src, out, '--bit-depth', '24', '--normalize'] };
    case 'audio-flac': case 'audio-aiff': return { app: 'soundcraft', args: ['convert', src, out] };
    case 'design-pdf': return { app: 'designcraft', args: ['run', '--in', src, '--export', out] };
    case 'design-png': return { app: 'designcraft', args: ['run', '--in', src, '--scale', '2', '--export', out] };
    case 'document-pdf': case 'document-txt': case 'document-md': case 'document-html': case 'document-odt': case 'document-rtf':
      return { app: 'wordcraft', args: ['convert', src, out] };
    case 'cad-pdf': case 'cad-png': case 'cad-svg': case 'cad-dxf': case 'cad-dwg': return { app: 'cadcraft', args: ['convert', src, out] };
    case 'ui-png': case 'ui-svg': case 'ui-pdf': return { app: 'figcraft', args: ['export', src, '-o', out, '--no-system-fonts'] };
    case 'ui-png2x': return { app: 'figcraft', args: ['export', src, '-o', out, '--scale', '2', '--no-system-fonts'] };
    case 'deck-pdf': case 'deck-pptx': case 'deck-png': return { app: 'deckcraft', args: ['convert', src, out] };
    case 'sheet-csv': case 'sheet-tsv': case 'sheet-json': case 'sheet-html': return { app: 'gridcraft', args: ['convert', src, out] };
    case 'document-png': return { app: 'wordcraft', args: ['render', src, out, '--page', '1'] };
    case 'pdf-png': return { app: 'pdfcraft', args: ['render', src, '--page', '1', '--dpi', '150', '--out', out] };
    case 'pdf-txt': case 'pdf-docx': case 'pdf-html': case 'pdf-rtf': case 'pdf-small': {
      const tool = p.id === 'pdf-txt' ? 'doc_export_text' : p.id === 'pdf-small' ? 'doc_reduce' : 'doc_export_office';
      const scriptPath = path.join(tmp, 'export.json');
      return {
        app: 'pdfcraft',
        args: ['run', '--script', scriptPath, '--root', commonFolder(src, out)],
        scriptPath,
        jsonScript: [{ tool: 'doc_open', args: { path: src } }, { tool, args: { doc: 1, path: out } }],
        ...(p.id === 'pdf-small' ? { copyIfNoOutput: 'This PDF is already as small as PdfCraft can make it, so the file is an unchanged copy.' } : {}),
      };
    }
  }
  const film: Record<string, Record<string, unknown>> = {
    'video-mp4': { format: 'h264' },
    'video-mp4-half': { format: 'h264', scale: 0.5 },
    'video-prores': { format: 'prores', proresProfile: 'standard' },
    'video-gif': { format: 'gif', scale: 0.5, audio: false },
    'video-aac': { format: 'aac' },
    'video-wav': { format: 'wav' },
  };
  const settings = film[p.id];
  if (!settings) throw new Error(`Unknown export preset "${p.id}".`);
  // A fresh headless FilmCraft project: the clip is item 1, its sequence is exported and waited for.
  const scriptPath = path.join(tmp, 'export.jsonl');
  return {
    app: 'filmcraft',
    args: ['--data-dir', path.join(tmp, 'filmcraft-data'), '--compact', 'run', scriptPath],
    scriptPath,
    script: [
      { id: 'file.newProject', params: { name: 'Deliver' } },
      { id: 'file.import', params: { paths: [src] } },
      { id: 'file.newSequence', params: { name: 'Deliver', fromItem: 1 } },
      { id: 'file.exportMedia', params: { path: out, wait: true, ...settings } },
    ],
  };
}

/** A free name in `dir`: base.ext, then base-2.ext, base-3.ext… */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  for (let i = 1; ; i++) {
    const name = `${base}${i === 1 ? '' : `-${i}`}.${ext}`;
    if (!(await fs.access(path.join(dir, name)).then(() => true, () => false))) return name;
  }
}

export interface DeliverDeps {
  store: ProjectStore;
  emit: (jobs: DeliverJob[]) => void;
  /** Folder of an installed ArtCraft app (its `<app>-cli.exe` lives there). */
  installDir: (app: EditorAppId) => string;
  /** Runs a tool; injectable for tests. */
  exec?: (exe: string, args: string[], o: { cwd: string; signal: AbortSignal }) => Promise<string>;
}

const defaultExec = (exe: string, args: string[], o: { cwd: string; signal: AbortSignal }) => new Promise<string>((resolve, reject) => {
  execFile(exe, args, { cwd: o.cwd, signal: o.signal, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error((String(stderr || '').trim().split(/\r?\n/).filter((l) => !/^warning:/i.test(l)).pop() || err.message).replace(/^\w+-cli: /, '')));
    else resolve(String(stdout));
  });
});

export class DeliverQueue {
  private jobs: DeliverJob[] = [];
  private running: { id: string; abort: AbortController } | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly d: DeliverDeps) {}

  list(): DeliverJob[] { return this.jobs; }

  private publish() {
    this.d.emit(this.jobs);
    for (const w of this.waiters.splice(0)) w();
  }

  /** Queues one export per preset for a library file. Throws before queueing anything that can't be exported. */
  async enqueue(assetId: string, presetIds: string[], requestedBy: DeliverJob['requestedBy'] = 'user'): Promise<DeliverJob[]> {
    const a = (await this.d.store.loadManifest()).assets.find((x) => x.id === assetId);
    if (!a) throw new Error('Unknown file.');
    if (!presetIds.length) throw new Error('Pick at least one export format.');
    const allowed = new Set(presetsFor(a.sourceFormat).map((p) => p.id));
    const presets = [...new Set(presetIds)].map((id) => {
      const p = presetById(id);
      if (!p || !allowed.has(id)) throw new Error(`"${id}" can't export ${a.sourceFormat.toUpperCase()} files.`);
      return p;
    });
    const now = new Date().toISOString();
    const added: DeliverJob[] = presets.map((p) => ({
      id: randomUUID(), assetId: a.id, assetName: a.name, presetId: p.id, presetLabel: p.label, status: 'queued', requestedBy, queuedAt: now,
    }));
    this.jobs = [...this.jobs.filter((j) => j.status === 'queued' || j.status === 'running' || Date.parse(j.queuedAt) > Date.now() - 6 * 3600_000).slice(-100), ...added];
    this.publish();
    void this.pump();
    return added;
  }

  cancel(jobId: string) {
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j) throw new Error('Unknown export.');
    if (j.status === 'queued') this.update(j.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    else if (j.status === 'running' && this.running?.id === j.id) this.running.abort.abort();
  }

  /**
   * Hands a finished export on to another app: a copy goes into the library as a new file derived from
   * the source (the file in exports/ and its manifest record stay). Only types CreateCraft can open.
   */
  async addToLibrary(jobId: string): Promise<Asset> {
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== 'done' || !j.output) throw new Error('That export has not finished.');
    const ext = path.extname(j.output).slice(1).toLowerCase();
    if (!kindForExtension(ext)) throw new Error(`.${ext} files can't be opened in CreateCraft, so there is nothing to hand on.`);
    const manifest = await this.d.store.loadManifest();
    const src = manifest.assets.find((x) => x.id === j.assetId);
    if (!src) throw new Error('The source file is no longer in the library.');
    const exportsDir = await this.d.store.exportsDir();
    const tmp = path.join(this.d.store.root, 'work', 'deliver-handoff', jobId);
    await fs.mkdir(tmp, { recursive: true });
    const base = src.name.replace(/.[^.]+$/, '').replace(/^[0-9a-f]{8}-/, '');
    const name = `${base}-from-${src.sourceFormat}.${ext}`;
    const copy = path.join(tmp, name);
    await fs.copyFile(path.join(exportsDir, j.output), copy);
    try {
      return await this.d.store.addDerivedFile(copy, {
        name, parentId: src.id,
        provenance: { origin: 'generated', source: `Exported from ${src.name} as ${j.presetLabel} and kept in the library (hand-off)` },
      });
    } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  }

  /** Removes finished, failed and cancelled jobs from the list (the files and manifest stay). */
  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    this.publish();
  }

  /** Resolves when all of these jobs have finished (done, failed or cancelled). */
  async wait(ids: string[]): Promise<DeliverJob[]> {
    const pending = () => this.jobs.filter((j) => ids.includes(j.id) && (j.status === 'queued' || j.status === 'running'));
    while (pending().length) await new Promise<void>((r) => this.waiters.push(r));
    return this.jobs.filter((j) => ids.includes(j.id));
  }

  /** Recorded exports (newest first), optionally only those made from one file. */
  async history(assetId?: string): Promise<DeliverRecord[]> {
    const all = await this.readManifest();
    return (assetId ? all.filter((r) => r.source.assetId === assetId) : all).slice().reverse();
  }

  private update(id: string, patch: Partial<DeliverJob>) {
    this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
    this.publish();
  }

  private async manifestPath() { return path.join(await this.d.store.exportsDir(), MANIFEST_FILE); }
  private async readManifest(): Promise<DeliverRecord[]> {
    try { const r = JSON.parse(await fs.readFile(await this.manifestPath(), 'utf8')) as { exports?: DeliverRecord[] }; return r.exports ?? []; } catch { return []; }
  }
  private async record(r: DeliverRecord) {
    const all = [...(await this.readManifest()), r];
    const file = await this.manifestPath();
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ schemaVersion: 1, exports: all }, null, 2));
    await fs.rename(`${file}.tmp`, file);
  }

  private async pump() {
    if (this.running) return;
    const next = this.jobs.find((j) => j.status === 'queued');
    if (!next) return;
    const abort = new AbortController();
    this.running = { id: next.id, abort };
    const started = Date.now();
    this.update(next.id, { status: 'running', startedAt: new Date(started).toISOString() });
    const tmp = path.join(this.d.store.root, 'work', 'deliver', next.id);
    let out: string | null = null;
    try {
      const p = presetById(next.presetId)!;
      const manifest = await this.d.store.loadManifest();
      const a = manifest.assets.find((x) => x.id === next.assetId);
      if (!a) throw new Error('The file is no longer in the library.');
      const src = await this.d.store.resolveAssetPath(a.id);
      const dir = await this.d.store.exportsDir();
      const base = a.name.replace(/\.[^.]+$/, '').replace(/[^\w.\- ]+/g, '_');
      const name = await freeName(dir, `${base}${p.suffix}`, p.ext);
      out = path.join(dir, name);
      await fs.mkdir(tmp, { recursive: true });
      const cmd = deliverCommand(p, src, out, a, tmp);
      if (cmd.script && cmd.scriptPath) await fs.writeFile(cmd.scriptPath, cmd.script.map((l) => JSON.stringify(l)).join('\n'));
      if (cmd.jsonScript && cmd.scriptPath) await fs.writeFile(cmd.scriptPath, JSON.stringify(cmd.jsonScript));
      const exe = path.join(this.d.installDir(cmd.app), `${cmd.app}-cli.exe`);
      await (this.d.exec ?? defaultExec)(exe, cmd.args, { cwd: tmp, signal: abort.signal });
      let note: string | undefined;
      let st = await fs.stat(out).catch(() => null);
      if (!st?.size && cmd.copyIfNoOutput) {
        await fs.copyFile(src, out);
        await fs.chmod(out, 0o666);
        note = cmd.copyIfNoOutput;
        st = await fs.stat(out);
      }
      if (!st?.size) throw new Error(`${EDITOR_APPS[cmd.app].name} finished but wrote no file.`);
      await this.record({
        jobId: next.id, at: new Date().toISOString(), preset: p.id, presetLabel: p.label, app: cmd.app, requestedBy: next.requestedBy,
        source: { assetId: a.id, name: a.name, sha256: a.sha256, versions: lineage(manifest.assets, a.id).map((x) => x.name) },
        output: { file: name, bytes: st.size, sha256: await sha256File(out) },
        ms: Date.now() - started,
      });
      this.update(next.id, { status: 'done', finishedAt: new Date().toISOString(), output: name, bytes: st.size, ...(note ? { note } : {}) });
    } catch (err) {
      if (out) await fs.rm(out, { force: true });
      const cancelled = abort.signal.aborted;
      this.update(next.id, { status: cancelled ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), error: cancelled ? undefined : (err instanceof Error ? err.message : String(err)) });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      this.running = null;
      void this.pump();
    }
  }
}

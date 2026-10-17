// REAL per-file-type editing through the matching ArtCraft app's CLI (headless), plus
// "Open in app" with a writable working copy that can be brought back as a new version.
//
// Every request is checked against src/shared/appEditors.ts (operation exists for this file type,
// values within range). Each CLI is run with a fixed argv and no shell; outputs go to the project's
// work/ folder and are registered as new read-only versions linked to their source.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkEditValues, EDITOR_APPS, editorFor, photocraftCommand, vectorcraftSteps, type EditorAppId } from '@shared/appEditors';
import type { Asset } from '@shared/types';
import { PhotoCraftCliAdapter } from './photocraftCli';
import { sha256File, type ProjectStore } from './projectStore';
import { craftBin, craftInstallDir } from './platform/craftApps';

const exe = (app: EditorAppId, gui = false) => {
  const folder = EDITOR_APPS[app].name;
  return craftBin(craftInstallDir(folder), `${folder.toLowerCase()}${gui ? '' : '-cli'}`);
};

function run(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: 180_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${stderr}\n${stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? err.message;
        reject(new Error(msg.replace(/^[\w-]+-cli:\s*/, '').replace(/^error:\s*/, '')));
      } else resolve(String(stdout));
    });
  });
}

export interface EditResult {
  app: EditorAppId;
  /** New versions, main one first (e.g. .svg then its .png preview). */
  assetIds: string[];
  message: string;
}

export interface ExternalEdit {
  id: string;
  app: EditorAppId;
  assetId: string;
  assetName: string;
  /** Working copy the app has open (inside work/<app>/). */
  workPath: string;
  hashAtOpen: string;
  openedAt: string;
}

export class AppEditors {
  private readonly external = new Map<string, ExternalEdit>();

  /** `launch` opens the app window on a working copy (tests pass a stand-in so no window opens). */
  constructor(private readonly store: ProjectStore, private readonly launch = (exePath: string, file: string) => { spawn(exePath, [file], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); }) {}

  private async asset(id: string): Promise<Asset> {
    const a = (await this.store.loadManifest()).assets.find((x) => x.id === id);
    if (!a) throw new Error('Unknown asset.');
    return a;
  }

  private async workDir(app: EditorAppId): Promise<string> {
    const d = path.join(await this.store.workDir(), app);
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  async apply(assetId: string, opId: string, rawValues: Record<string, unknown>): Promise<EditResult> {
    const a = await this.asset(assetId);
    const app = editorFor(a.sourceFormat);
    if (!app) throw new Error(`No ArtCraft app edits ${a.sourceFormat.toUpperCase()} files.`);
    const op = app.quickEdits.find((o) => o.id === opId);
    if (!op) throw new Error(`${app.name} has no quick edit "${opId}".`);
    const check = checkEditValues(op, rawValues);
    if (!check.ok) throw new Error(check.reason);
    const v = check.values;
    const src = await this.store.resolveAssetPath(a.id);
    const base = a.name.replace(/\.[^.]+$/, '');
    const tag = op.label.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
    const settings = op.params.map((p) => `${p.label} ${v[p.key]}${p.type === 'number' && p.unit ? p.unit : ''}`).join(', ');
    const source = `${app.name} (headless): ${op.label}${settings ? ` (${settings})` : ''}`;

    switch (app.id) {
      case 'photocraft': {
        const pc = await PhotoCraftCliAdapter.create(this.store);
        if (!pc) throw new Error('PhotoCraft is not installed.');
        const { documentId } = await pc.open(`asset:${a.id}`);
        const { command, params } = photocraftCommand(op.id, v);
        const r = await pc.execute(documentId, { command, params });
        return { app: app.id, assetIds: r.outputAssetIds, message: `${op.label} applied by PhotoCraft.` };
      }
      case 'vectorcraft': {
        const work = await this.workDir('vectorcraft');
        const tmp = randomUUID().slice(0, 8);
        const outMain = path.join(work, `${tmp}.${a.sourceFormat}`);
        const outPng = path.join(work, `${tmp}.png`);
        const args = ['run', '--in', src];
        for (const s of vectorcraftSteps(op.id, v)) {
          args.push('--cmd', s.cmd);
          if (s.params) args.push('--params', JSON.stringify(s.params));
        }
        args.push('--export', outMain, '--export', outPng);
        try {
          await run(exe('vectorcraft'), args, work);
        } catch (e) {
          await Promise.all([fs.rm(outMain, { force: true }), fs.rm(outPng, { force: true })]);
          throw e;
        }
        const main = await this.store.addDerivedFile(outMain, { name: `${base}-${tag}.${a.sourceFormat}`, parentId: a.id, provenance: { origin: 'generated', source } });
        const png = await this.store.addDerivedFile(outPng, { name: `${base}-${tag}.png`, parentId: main.id, provenance: { origin: 'generated', source: `PNG preview of ${main.name} (VectorCraft export)` } });
        return { app: app.id, assetIds: [main.id, png.id], message: `${op.label} applied by VectorCraft.` };
      }
      case 'soundcraft': {
        const work = await this.workDir('soundcraft');
        const tmp = randomUUID().slice(0, 8);
        const out = path.join(work, `${tmp}.wav`);
        const cli = exe('soundcraft');
        try {
          if (op.id === 'normalize') await run(cli, ['convert', src, out, '--normalize'], work);
          else if (op.id === 'resample') await run(cli, ['convert', src, out, '--rate', String(v.rate)], work);
          else {
            // SoundCraft keeps an "Audio Files" folder beside a session: give it its own folder.
            const sessionDir = path.join(work, `session-${tmp}`);
            await fs.mkdir(sessionDir, { recursive: true });
            const session = path.join(sessionDir, 'edit.scraft');
            const imported = await run(cli, ['run', '--cmd', `file.import_audio=${JSON.stringify({ path: src })}`, '--save', session], work);
            const m = /file\.import_audio:\s*(\{.*\})/.exec(imported);
            const info = m ? (JSON.parse(m[1]!) as { imported?: Array<{ track: number; frames: number }> }).imported?.[0] : undefined;
            if (!info) throw new Error('SoundCraft did not report the imported clip.');
            const cmds: string[] = [];
            if (op.id === 'gain') cmds.push('--cmd', 'edit.select_all', '--cmd', `clip.gain=${JSON.stringify({ db: v.db })}`);
            if (op.id === 'fades') {
              const fileInfo = JSON.parse(await run(cli, ['info', src], work)) as { seconds?: number };
              const seconds = fileInfo.seconds ?? 0;
              if (!(seconds > 0)) throw new Error('Could not read the audio duration.');
              const perSecond = info.frames / seconds;
              const fin = Math.min(Number(v.fadeIn), seconds / 2);
              const fout = Math.min(Number(v.fadeOut), seconds / 2);
              if (fin > 0) cmds.push('--cmd', `edit.fades_create=${JSON.stringify({ shape: v.shape, tracks: [info.track], start: 0, end: Math.round(fin * perSecond) })}`);
              if (fout > 0) cmds.push('--cmd', `edit.fades_create=${JSON.stringify({ shape: v.shape, tracks: [info.track], start: Math.round(info.frames - fout * perSecond), end: info.frames })}`);
              if (!cmds.length) throw new Error('Set a fade-in or fade-out length.');
            }
            try {
              await run(cli, ['run', '--in', session, ...cmds, '--bounce', out], work);
            } finally {
              await fs.rm(sessionDir, { recursive: true, force: true });
            }
          }
        } catch (e) {
          await fs.rm(out, { force: true });
          throw e;
        }
        const wav = await this.store.addDerivedFile(out, { name: `${base}-${tag}.wav`, parentId: a.id, provenance: { origin: 'generated', source } });
        return { app: app.id, assetIds: [wav.id], message: `${op.label} applied by SoundCraft.` };
      }
      default:
        throw new Error(`${app.name} has no quick edits yet.`);
    }
  }

  /**
   * Opens a writable working copy in the app's own window. The library file is never handed to the
   * app. Audio is opened as a SoundCraft session with the file imported (the app can't open bare WAVs).
   */
  async openWorkingCopy(assetId: string): Promise<ExternalEdit> {
    const a = await this.asset(assetId);
    const app = editorFor(a.sourceFormat);
    if (!app || app.open === 'none') throw new Error(`Opening ${a.sourceFormat.toUpperCase()} files this way isn't supported.`);
    const work = await this.workDir(app.id);
    const id = randomUUID().slice(0, 8);
    const src = await this.store.resolveAssetPath(a.id);
    const safe = a.name.replace(/[^\w.\- ]+/g, '_');
    let workPath: string;
    if (app.id === 'soundcraft') {
      const dir = path.join(work, `${id}-${safe.replace(/\.[^.]+$/, '')}`);
      await fs.mkdir(dir, { recursive: true });
      workPath = path.join(dir, `${safe.replace(/\.[^.]+$/, '')}.scraft`);
      await run(exe('soundcraft'), ['run', '--cmd', `file.import_audio=${JSON.stringify({ path: src })}`, '--save', workPath], work);
    } else {
      workPath = path.join(work, `${id}-${safe}`);
      await fs.copyFile(src, workPath);
      await fs.chmod(workPath, 0o666);
    }
    const edit: ExternalEdit = { id, app: app.id, assetId: a.id, assetName: a.name, workPath, hashAtOpen: await sha256File(workPath), openedAt: new Date().toISOString() };
    this.external.set(id, edit);
    this.launch(exe(app.id, true), workPath);
    return edit;
  }

  list(): ExternalEdit[] {
    return [...this.external.values()];
  }

  /** Registers the saved working copy as a new version (audio: also bounced to WAV). */
  async bringBack(editId: string): Promise<EditResult> {
    const e = this.external.get(editId);
    if (!e) throw new Error('That working copy is no longer tracked.');
    const app = EDITOR_APPS[e.app];
    if ((await sha256File(e.workPath)) === e.hashAtOpen) throw new Error(`No saved changes yet. Save in ${app.name} first (Ctrl+S), then bring it back.`);
    const work = await this.workDir(e.app);
    const base = e.assetName.replace(/\.[^.]+$/, '');
    const n = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const snapshot = path.join(work, `bring-${randomUUID().slice(0, 8)}${path.extname(e.workPath)}`);
    await fs.copyFile(e.workPath, snapshot);
    const ids: string[] = [];
    if (e.app === 'soundcraft') {
      // A session isn't self-contained (its audio lives beside it), so the version is the bounced mix;
      // the session itself stays in the working folder for further editing.
      await fs.rm(snapshot, { force: true });
      const wavTmp = path.join(work, `bring-${randomUUID().slice(0, 8)}.wav`);
      await run(exe('soundcraft'), ['run', '--in', e.workPath, '--bounce', wavTmp], work);
      const wav = await this.store.addDerivedFile(wavTmp, { name: `${base}-edit-${n}.wav`, parentId: e.assetId, provenance: { origin: 'generated', source: `Mix bounced by SoundCraft from your edited session (${path.basename(e.workPath)})` } });
      ids.push(wav.id);
    } else {
      const ext = path.extname(e.workPath).slice(1);
      const main = await this.store.addDerivedFile(snapshot, { name: `${base}-edit-${n}.${ext}`, parentId: e.assetId, provenance: { origin: 'generated', source: `Edited by hand in ${app.name}` } });
      ids.push(main.id);
      if (e.app === 'vectorcraft') {
        const png = path.join(work, `bring-${randomUUID().slice(0, 8)}.png`);
        await run(exe('vectorcraft'), ['convert', await this.store.resolveAssetPath(main.id), png], work);
        ids.push((await this.store.addDerivedFile(png, { name: `${base}-edit-${n}.png`, parentId: main.id, provenance: { origin: 'generated', source: `PNG preview of ${main.name} (VectorCraft)` } })).id);
      }
    }
    e.hashAtOpen = await sha256File(e.workPath);
    return { app: e.app, assetIds: ids, message: `Brought back your ${app.name} edits as a new version.` };
  }
}

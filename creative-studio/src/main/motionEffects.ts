// Motion Effects in the main process: turns one library picture into a short video with FilmCraft's
// headless engine (keyframed camera move). Free, local, and not generative AI: the result is saved
// as a new version of the picture with provenance that says so. No network, no provider, no cost.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MOTION_FORMATS, MOTION_LABEL, MOTION_PRESETS, firstClipId, motionMoveScript, motionSetupScript, normalizeMotionJob, type FilmScriptLine, type MotionJob } from '@shared/motionEffects';
import type { Asset } from '@shared/types';
import type { ProjectStore } from './projectStore';

export type MotionExec = (exe: string, args: string[], o: { cwd: string; signal: AbortSignal }) => Promise<string>;

export interface MotionDeps {
  store: () => Promise<ProjectStore>;
  /** Folder of the installed FilmCraft (its `filmcraft-cli.exe` lives there). */
  filmcraftDir: () => string;
  exec?: MotionExec;
}

const defaultExec: MotionExec = (exe, args, o) => new Promise((resolve, reject) => {
  execFile(exe, args, { cwd: o.cwd, signal: o.signal, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      if (o.signal.aborted) reject(new MotionCancelled());
      else reject(new Error((String(stderr || '').trim().split(/\r?\n/).filter((l) => !/^warning:/i.test(l)).pop() || err.message).replace(/^\w+-cli: /, '')));
    } else resolve(String(stdout));
  });
});

export class MotionCancelled extends Error {
  constructor() { super('Motion video cancelled.'); this.name = 'MotionCancelled'; }
}

export interface MotionResult { asset: Asset; message: string }

export class MotionService {
  private active: AbortController | null = null;

  constructor(private readonly d: MotionDeps) {}

  get busy(): boolean { return this.active !== null; }

  cancel(): void { this.active?.abort(); }

  async render(raw: MotionJob): Promise<MotionResult> {
    if (this.active) throw new Error('A motion video is already being made. Wait for it or cancel it first.');
    const job = normalizeMotionJob(raw);
    const store = await this.d.store();
    const asset = (await store.loadManifest()).assets.find((a) => a.id === job.assetId);
    if (!asset) throw new Error('That picture is no longer in the library.');
    if (!MOTION_FORMATS.includes(asset.sourceFormat)) throw new Error(`${asset.name}: only PNG, JPEG or WebP pictures can be used.`);
    if (!asset.width || !asset.height) throw new Error(`${asset.name}: its size is not known, so the move cannot be planned.`);
    const exe = path.join(this.d.filmcraftDir(), 'filmcraft-cli.exe');
    if (!(await fs.access(exe).then(() => true, () => false))) throw new Error('FilmCraft is not installed, so Motion Effects cannot make a video.');

    const ac = new AbortController();
    this.active = ac;
    const exec = this.d.exec ?? defaultExec;
    const tmp = path.join(await store.workDir('motion'), randomUUID().slice(0, 8));
    try {
      await fs.mkdir(tmp, { recursive: true });
      const common = ['--data-dir', path.join(tmp, 'filmcraft-data'), '--compact'];
      const project = path.join(tmp, 'motion.fcproj');
      const write = async (name: string, lines: FilmScriptLine[]) => {
        const p = path.join(tmp, name);
        await fs.writeFile(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
        return p;
      };
      const run = (args: string[]) => exec(exe, [...common, ...args], { cwd: tmp, signal: ac.signal });

      const source = (await store.resolveAssetPath(asset.id)).replace(/\\/g, '/');
      await run(['--save-as', project, 'run', await write('setup.jsonl', motionSetupScript(job, source))]);
      const seq = JSON.parse(await run(['--project', project, 'inspect', 'sequence'])) as unknown;
      const clip = firstClipId(seq);
      if (clip === null) throw new Error('FilmCraft did not place the picture on the timeline.');
      await run(['--project', project, '--save', 'run', await write('move.jsonl', motionMoveScript(job, clip, asset.width, asset.height))]);
      const out = path.join(tmp, 'motion.mp4');
      await run(['--project', project, 'export', out, '--format', 'h264']);
      if (!(await fs.stat(out).then((s) => s.size > 1000, () => false))) throw new Error('FilmCraft did not produce a video file.');

      const label = MOTION_PRESETS.find((p) => p.id === job.preset)!.label;
      const base = asset.name.replace(/\.[^.]+$/, '');
      const name = `${base}-${job.preset}.mp4`;
      const derived = await store.addDerivedFile(out, {
        name, parentId: asset.id,
        provenance: {
          origin: 'generated',
          source: `${MOTION_LABEL} · made with FilmCraft · ${label}`,
          settings: { movement: label, strength: job.intensity, aspect: job.aspectRatio, resolution: job.resolution, fps: String(job.fps), length: `${job.durationSeconds} s` },
          requestedBy: 'user',
          referenceAssetIds: [asset.id],
          licensingNotes: 'Not AI-generated: the same picture with a camera move. Rights follow the source picture.',
        },
      });
      return { asset: derived, message: `Made a ${job.durationSeconds} s motion video from ${asset.name} (${label}). Free and local; not AI-generated.` };
    } finally {
      this.active = null;
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// REAL PhotoCraft adapter (headless). Drives the installed `photocraft-cli.exe`:
//   run <current version> [--cmd layer.flattenImage] --cmd <id> --params <json> --out work/<tmp>.pcraft
//   convert work/<tmp>.pcraft work/<tmp>.png
// Both outputs are registered as new immutable versions derived from the input asset; the input
// is only read. Arguments are passed as an argv array (no shell), commands and params are checked
// against the shared allowlist, and every path is inside the project root.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppAdapter, AppOperation } from '@shared/contracts';
import { checkPhotoCraftOp, presetLabel } from '@shared/photocraftOps';
import type { AppProbeResult, Asset } from '@shared/types';
import { ARTCRAFT_APPS, probeArtCraftApp } from './artcraftProbe';
import { craftInstallDir } from './platform/craftApps';
import type { ProjectStore } from './projectStore';

/** Formats PhotoCraft opens as layered/raster documents directly. Anything else is flattened first. */
const RASTER_OR_NATIVE = new Set(['pcraft', 'psd', 'psb', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'bmp', 'gif', 'exr', 'tga']);
const OPENABLE = new Set([...RASTER_OR_NATIVE, 'svg']);
export const EXPORT_FORMATS = ['png', 'jpg', 'webp', 'tif', 'psd', 'pcraft'] as const;

export class PhotoCraftCliError extends Error {}

export function runCli(exe: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('error')).pop()
          ?? String(stderr || err.message).trim().split(/\r?\n/).pop();
        reject(new PhotoCraftCliError(detail?.replace(/^error:\s*/, '') || 'PhotoCraft failed.'));
      } else resolve(String(stdout));
    });
  });
}

export function parseAssetRef(ref: string): string {
  const m = /^asset:([\w-]{1,128})$/.exec(ref);
  if (!m) throw new Error('This node needs an asset from the library as input.');
  return m[1]!;
}

export class PhotoCraftCliAdapter implements AppAdapter {
  readonly id = 'photocraft';
  readonly isMock = false;
  private readonly docs = new Map<string, { assetId: string }>();
  private version: string | null = null;

  constructor(private readonly exe: string, private readonly store: ProjectStore) {}

  static async create(store: ProjectStore, installDir?: string): Promise<PhotoCraftCliAdapter | null> {
    const def = ARTCRAFT_APPS.find((a) => a.id === 'photocraft')!;
    // Same lookup as detection and the launcher: the chosen folder, Program Files, Program Files\ArtCraft, the registry.
    let dir = installDir;
    if (!dir) { try { dir = craftInstallDir(def.folder); } catch { return null; } }
    const exe = path.join(dir, def.cli);
    const ok = await fs.access(exe).then(() => true, () => false);
    if (!ok) return null;
    const a = new PhotoCraftCliAdapter(exe, store);
    a.version = (await runCli(exe, ['--version'], path.dirname(exe), 15_000).catch(() => '')).trim().split(/\r?\n/)[0] || null;
    return a;
  }

  async probe(): Promise<AppProbeResult> {
    const def = ARTCRAFT_APPS.find((a) => a.id === 'photocraft')!;
    return probeArtCraftApp(def, path.dirname(path.dirname(this.exe)));
  }

  private async asset(assetId: string): Promise<Asset> {
    const a = (await this.store.loadManifest()).assets.find((x) => x.id === assetId);
    if (!a) throw new Error('Input asset no longer exists.');
    return a;
  }

  async open(assetRef: string): Promise<{ documentId: string }> {
    const a = await this.asset(parseAssetRef(assetRef));
    if (!OPENABLE.has(a.sourceFormat)) throw new Error(`PhotoCraft can't edit ${a.sourceFormat.toUpperCase()} files (${a.name}).`);
    const documentId = `pc-${randomUUID()}`;
    this.docs.set(documentId, { assetId: a.id });
    return { documentId };
  }

  async execute(documentId: string, op: AppOperation): Promise<{ checkpointId: string; outputAssetIds: string[] }> {
    const doc = this.docs.get(documentId);
    if (!doc) throw new Error('Unknown document.');
    const check = checkPhotoCraftOp(op.command, op.params);
    if (!check.ok) throw new Error(check.reason);

    const input = await this.asset(doc.assetId);
    const inputPath = await this.store.resolveAssetPath(input.id);
    const work = await this.store.workDir();
    const tmp = randomUUID().slice(0, 8);
    const outDoc = path.join(work, `${tmp}.pcraft`);
    const outPng = path.join(work, `${tmp}.png`);

    const steps: string[] = [];
    const flatten = !RASTER_OR_NATIVE.has(input.sourceFormat);
    if (flatten) steps.push('--cmd', 'layer.flattenImage');
    steps.push('--cmd', op.command, '--params', JSON.stringify(check.params));

    try {
      await runCli(this.exe, ['run', inputPath, ...steps, '--out', outDoc], work);
      await runCli(this.exe, ['convert', outDoc, outPng], work);
    } catch (err) {
      await Promise.all([fs.rm(outDoc, { force: true }), fs.rm(outPng, { force: true })]);
      throw err;
    }

    const base = input.name.replace(/\.[^.]+$/, '');
    const label = presetLabel(op.command).replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const source = `PhotoCraft headless (${this.version ?? 'photocraft-cli'}): ${flatten ? 'layer.flattenImage → ' : ''}${op.command} ${JSON.stringify(check.params)}`;
    const docAsset = await this.store.addDerivedFile(outDoc, { name: `${base}-${label}.pcraft`, parentId: input.id, provenance: { origin: 'generated', source } });
    const pngAsset = await this.store.addDerivedFile(outPng, { name: `${base}-${label}.png`, parentId: docAsset.id, provenance: { origin: 'generated', source: `Flattened PNG of ${docAsset.name} (photocraft-cli convert)` } });

    doc.assetId = docAsset.id; // further operations continue from the layered document
    return { checkpointId: docAsset.id, outputAssetIds: [docAsset.id, pngAsset.id] };
  }

  async save(): Promise<void> {
    // Every execute() already persists a new version; nothing is pending.
  }

  async export(documentId: string, format: string): Promise<string> {
    const doc = this.docs.get(documentId);
    if (!doc) throw new Error('Unknown document.');
    return this.exportAsset(doc.assetId, format);
  }

  /** Converts an asset to `format` in the project's exports/ folder; returns the file name. */
  async exportAsset(assetId: string, format: string): Promise<string> {
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new Error(`Unsupported export format "${format}".`);
    const a = await this.asset(assetId);
    const src = await this.store.resolveAssetPath(a.id);
    const dir = await this.store.exportsDir();
    const base = a.name.replace(/\.[^.]+$/, '').replace(/[^\w.\- ]+/g, '_');
    let name = `${base}.${format}`;
    for (let i = 2; await fs.access(path.join(dir, name)).then(() => true, () => false); i++) name = `${base}-${i}.${format}`;
    await runCli(this.exe, ['convert', src, path.join(dir, name)], dir);
    return name;
  }
}

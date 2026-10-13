// REAL live control of VectorCraft and SoundCraft windows (PhotoCraft lives in photocraftLive.ts).
//
// Both are launched with `--control <port>` on 127.0.0.1 and driven through their CLI's MCP bridge
// (`… mcp --connect`). Neither app offers a control token (verified in the Phase 2 audit), so the
// port is random per launch and loopback-only. VectorCraft additionally gets automation roots
// (VECTORCRAFT_AUTOMATION_READ_ROOT / _WRITE_ROOT) so it refuses automated file access outside the
// project. Only commands from src/shared/appEditors.ts are ever sent; nothing free-form.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { vectorcraftSteps, type EditValues, type EditorAppId } from '@shared/appEditors';
import type { AppOperation } from '@shared/contracts';
import { McpClient } from './mcpClient';
import { freePort, waitForPort, type LiveDoc } from './photocraftLive';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LiveAppOptions {
  installDir: string;
  readRoot: string;
  writeRoot: string;
  /** Called with the app's process id right after launch (before its window appears). */
  onSpawn?: (pid: number) => void;
}

abstract class LiveAppBase implements LiveDoc {
  protected gui: ChildProcess | null = null;
  protected mcp: McpClient | null = null;
  private starting: Promise<void> | null = null;
  abstract readonly appId: EditorAppId;
  protected abstract exeName: string;

  constructor(protected readonly o: LiveAppOptions) {}

  get connected(): boolean { return !!this.mcp?.alive && !!this.gui && this.gui.exitCode === null; }
  get pid(): number | null { return this.connected ? this.gui!.pid ?? null : null; }

  async ensureStarted(): Promise<void> {
    if (this.connected) return;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  protected abstract guiEnv(): NodeJS.ProcessEnv;
  protected abstract bridgeArgs(port: number): string[];

  private async start(): Promise<void> {
    this.stop();
    await fs.mkdir(this.o.writeRoot, { recursive: true });
    const port = await freePort();
    const gui = spawn(path.join(this.o.installDir, `${this.exeName}.exe`), ['--control', String(port)], {
      env: { ...process.env, ...this.guiEnv() }, stdio: 'ignore', windowsHide: false,
    });
    this.gui = gui;
    if (gui.pid) this.o.onSpawn?.(gui.pid);
    gui.on('exit', () => { if (this.gui === gui) { this.gui = null; this.mcp?.close(); this.mcp = null; } });
    await waitForPort(port, 30_000, () => gui.exitCode !== null);
    this.mcp = await McpClient.start(path.join(this.o.installDir, `${this.exeName}-cli.exe`), this.bridgeArgs(port));
  }

  protected client(): McpClient {
    if (!this.connected || !this.mcp) throw new Error(`The ${this.appId} window is not running (was it closed?).`);
    return this.mcp;
  }

  abstract open(absPath: string): Promise<{ name: string }>;
  abstract run(op: AppOperation): Promise<void>;
  abstract history(): Promise<string[]>;
  abstract writeVersion(dir: string, base: string): Promise<{ main: string; preview?: string }>;

  stop() { this.mcp?.close(); this.mcp = null; this.gui = null; }
  /** Closes the window this session started, discarding unsaved changes. Tests only. */
  killApp() { const g = this.gui; this.stop(); g?.kill(); }
}

/** Waits until a file exists and its size has stopped changing (for saves the app finishes in the background). */
async function waitForFile(file: string, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < end) {
    const size = await fs.stat(file).then((s) => s.size, () => -1);
    if (size > 0 && size === last) return;
    last = size;
    await sleep(200);
  }
  throw new Error(`Saving ${path.basename(file)} did not finish in time.`);
}

export class LiveVectorCraft extends LiveAppBase {
  readonly appId = 'vectorcraft' as const;
  protected exeName = 'vectorcraft';

  protected guiEnv() {
    return { VECTORCRAFT_AUTOMATION_READ_ROOT: this.o.readRoot, VECTORCRAFT_AUTOMATION_WRITE_ROOT: this.o.writeRoot };
  }
  protected bridgeArgs(port: number) { return ['mcp', '--connect', `127.0.0.1:${port}`]; }

  async open(absPath: string) {
    await this.client().callTool('open_file', { path: absPath });
    return { name: path.basename(absPath) };
  }
  async run(op: AppOperation) {
    await this.client().callTool('run_command', { command: op.command, params: op.params });
  }
  async history() {
    const r = (await this.client().callTool('inspect_document', { depth: 0 })) as { history?: unknown };
    return ['Open', ...(Array.isArray(r?.history) ? r.history.map(String) : [])];
  }
  async undo() { await this.client().callTool('undo', {}); }
  quickEditSteps(opId: string, values: EditValues): AppOperation[] {
    return vectorcraftSteps(opId, values).map((s) => ({ command: s.cmd, params: s.params ?? {} }));
  }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.svg`);
    const preview = path.join(dir, `${base}.png`);
    await this.client().callTool('save_file', { path: main });
    await waitForFile(main);
    await this.client().callTool('export', { path: preview });
    return { main, preview };
  }
  async screenshot(maxSide: number): Promise<Buffer | null> {
    const r = (await this.client().request('tools/call', { name: 'screenshot', arguments: { max_side: maxSide } })) as { content?: Array<{ type: string; data?: string }> };
    const img = r.content?.find((c) => c.type === 'image');
    return img?.data ? Buffer.from(img.data, 'base64') : null;
  }
  async preview(maxSide: number): Promise<Buffer | null> {
    const r = (await this.client().request('tools/call', { name: 'render_preview', arguments: { max_side: maxSide } })) as { content?: Array<{ type: string; data?: string }> };
    const img = r.content?.find((c) => c.type === 'image');
    return img?.data ? Buffer.from(img.data, 'base64') : null;
  }
}

export class LiveSoundCraft extends LiveAppBase {
  readonly appId = 'soundcraft' as const;
  protected exeName = 'soundcraft';
  private clip: { track: number; frames: number; seconds: number } | null = null;
  private applied: string[] = [];

  protected guiEnv() { return {}; }
  protected bridgeArgs(port: number) { return ['mcp', '--connect', String(port)]; }

  private cliInfo(file: string): Promise<{ seconds?: number }> {
    return new Promise((resolve, reject) => {
      execFile(path.join(this.o.installDir, 'soundcraft-cli.exe'), ['info', file], { windowsHide: true, timeout: 30_000 }, (err, out) => {
        if (err) reject(err); else { try { resolve(JSON.parse(String(out))); } catch (e) { reject(e); } }
      });
    });
  }

  async open(absPath: string) {
    await this.client().callTool('new_session', { template: 'blank', name: path.basename(absPath).replace(/\.[^.]+$/, '') });
    const r = (await this.client().callTool('import_audio', { path: absPath })) as { imported?: Array<{ track: number; frames: number }> };
    const imp = r?.imported?.[0];
    if (!imp) throw new Error('SoundCraft did not import the audio.');
    const info = await this.cliInfo(absPath);
    this.clip = { track: imp.track, frames: imp.frames, seconds: info.seconds ?? 0 };
    this.applied = ['Import audio'];
    return { name: path.basename(absPath) };
  }
  async run(op: AppOperation) {
    await this.client().callTool('execute', { command: op.command, params: op.params });
    this.applied.push(op.command);
  }
  async history() { return [...this.applied]; }
  async undo() {
    await this.client().callTool('execute', { command: 'edit.undo', params: {} });
    if (this.applied.length > 1) this.applied.pop();
  }
  quickEditSteps(opId: string, v: EditValues): AppOperation[] {
    const c = this.clip;
    if (!c) throw new Error('No audio is open.');
    if (opId === 'gain') return [{ command: 'edit.select_all', params: {} }, { command: 'clip.gain', params: { db: v.db } }];
    if (opId === 'fades') {
      if (!(c.seconds > 0)) throw new Error('Could not read the audio duration.');
      const perSecond = c.frames / c.seconds;
      const fin = Math.min(Number(v.fadeIn), c.seconds / 2);
      const fout = Math.min(Number(v.fadeOut), c.seconds / 2);
      const steps: AppOperation[] = [];
      if (fin > 0) steps.push({ command: 'edit.fades_create', params: { shape: v.shape, tracks: [c.track], start: 0, end: Math.round(fin * perSecond) } });
      if (fout > 0) steps.push({ command: 'edit.fades_create', params: { shape: v.shape, tracks: [c.track], start: Math.round(c.frames - fout * perSecond), end: c.frames } });
      if (!steps.length) throw new Error('Set a fade-in or fade-out length.');
      return steps;
    }
    throw new Error(`SoundCraft can't apply "${opId}" live.`);
  }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.wav`);
    await this.client().callTool('bounce_mix', { path: main, format: 'wav' }, 300_000);
    await waitForFile(main);
    return { main };
  }
  async screenshot(maxSide: number): Promise<Buffer | null> {
    const r = (await this.client().request('tools/call', { name: 'screenshot', arguments: { max_side: maxSide } })) as { content?: Array<{ type: string; data?: string }> };
    const img = r.content?.find((c) => c.type === 'image');
    return img?.data ? Buffer.from(img.data, 'base64') : null;
  }
}

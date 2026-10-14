// REAL live control of VectorCraft, SoundCraft, FilmCraft, LightCraft, EffectCraft and DesignCraft
// windows (PhotoCraft lives in photocraftLive.ts).
//
// Both are launched with `--control <port>` on 127.0.0.1 and driven through their CLI's MCP bridge
// (`… mcp --connect`). Neither app offers a control token (verified in the Phase 2 audit), so the
// port is random per launch and loopback-only. VectorCraft additionally gets automation roots
// (VECTORCRAFT_AUTOMATION_READ_ROOT / _WRITE_ROOT) so it refuses automated file access outside the
// project. Only commands from src/shared/appEditors.ts are ever sent; nothing free-form.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { designcraftSteps, effectcraftSteps, filmcraftSteps, type DesignPage, lightcraftSteps, vectorcraftSteps, type EditValues, type EditorAppId } from '@shared/appEditors';
import type { TimelineDto } from '@shared/live';
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

  protected abstract guiEnv(port: number): NodeJS.ProcessEnv;
  /** Command-line arguments for the app window (default: just the control port). */
  protected guiArgs(port: number): string[] { return ['--control', String(port)]; }
  protected abstract bridgeArgs(port: number): string[];

  private async start(): Promise<void> {
    this.stop();
    await fs.mkdir(this.o.writeRoot, { recursive: true });
    const port = await freePort();
    const gui = spawn(path.join(this.o.installDir, `${this.exeName}.exe`), this.guiArgs(port), {
      env: { ...process.env, ...this.guiEnv(port) }, stdio: 'ignore', windowsHide: false,
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
  async applyTheme(value: string): Promise<string | null> {
    await this.client().callTool('run_command', { command: 'prefs.set', params: { key: 'uiBrightness', value } });
    const r = await this.client().callTool('run_command', { command: 'prefs.get', params: { key: 'uiBrightness' } });
    return typeof r === 'string' ? r : String(r ?? '');
  }
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

interface ScSession {
  sample_rate?: number; length_samples?: number;
  transport?: { position?: number };
  selection?: { clips?: number[] };
  tracks?: Array<{ id: number; name: string; clips?: Array<{ id: number; name: string; start?: number; position?: number; end?: number; length?: number; fade_in?: number; fade_out?: number; gain_db?: number; muted?: boolean }> }>;
}

export class LiveSoundCraft extends LiveAppBase {
  readonly appId = 'soundcraft' as const;
  protected exeName = 'soundcraft';
  private clip: { track: number; frames: number; seconds: number } | null = null;
  private applied: string[] = [];
  /** Undo steps that belong to opening (new session + import); history starts after them. */
  private baseUndo = 0;

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
    this.baseUndo = (await this.undoList())?.length ?? 0;
    return { name: path.basename(absPath) };
  }
  async run(op: AppOperation) {
    await this.client().callTool('execute', { command: op.command, params: op.params });
    this.applied.push(op.command);
  }
  /** SoundCraft's own undo history (engine.history), so edits made by hand show up too. */
  private async undoList(): Promise<string[] | null> {
    try { return ((await this.client().callTool('execute', { command: 'engine.history', params: {} })) as { undo?: string[] }).undo ?? []; } catch { return null; }
  }
  async history() {
    const u = await this.undoList();
    return u ? ['Open', ...u.slice(this.baseUndo)] : [...this.applied];
  }
  async applyTheme(value: string): Promise<string | null> {
    await this.client().callTool('ui_set', { state: { theme: value } });
    const ui = await this.client().callTool('ui_inspect', {});
    const m = /"theme"\s*:\s*"(\w+)"/.exec(typeof ui === 'string' ? ui : JSON.stringify(ui));
    return m?.[1] ?? null;
  }
  async undo() {
    const u = await this.undoList();
    if (u && u.length <= this.baseUndo) throw new Error('Nothing to undo.');
    await this.client().callTool('execute', { command: 'edit.undo', params: {} });
    if (this.applied.length > 1) this.applied.pop();
  }
  /** The session's tracks and clips (gain, fades) from inspect_session, times in seconds. */
  async timeline(): Promise<TimelineDto> {
    const s = (await this.client().callTool('inspect_session', {})) as ScSession;
    const sr = s.sample_rate || 48000;
    const sec = (n: number) => Math.round((n / sr) * 1000) / 1000;
    const tracks = (s.tracks ?? []).filter((t) => (t.clips ?? []).length).map((t) => ({
      id: t.id, name: t.name, kind: 'audio' as const, transitions: 0,
      clips: (t.clips ?? []).map((k) => {
        const start = k.start ?? k.position ?? 0;
        const len = k.length ?? Math.max(0, (k.end ?? start) - start);
        return { id: k.id, name: k.name, start: sec(start), duration: sec(len), speed: 1, effects: [], gainDb: k.gain_db ?? 0, fadeIn: sec(k.fade_in ?? 0), fadeOut: sec(k.fade_out ?? 0), muted: !!k.muted };
      }),
    }));
    const end = Math.max(s.length_samples ?? 0, ...(s.tracks ?? []).flatMap((t) => (t.clips ?? []).map((k) => k.end ?? 0)));
    return { duration: sec(end), fps: 0, playhead: sec(s.transport?.position ?? 0), tracks, selection: s.selection?.clips ?? [] };
  }
  async setPlayhead(seconds: number) {
    const s = (await this.client().callTool('inspect_session', {})) as ScSession;
    await this.client().callTool('execute', { command: 'transport.locate', params: { at: Math.round(seconds * (s.sample_rate || 48000)) } });
  }
  describe() { return this.timeline(); }
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

// ---- FilmCraft, LightCraft, EffectCraft, DesignCraft (Phase 3; every call below verified live) ----

const imageOf = (r: unknown): Buffer | null => {
  const img = (r as { content?: Array<{ type: string; data?: string }> }).content?.find((c) => c.type === 'image');
  return img?.data ? Buffer.from(img.data, 'base64') : null;
};

/** FilmCraft time unit: 254 016 000 000 ticks per second. */
const TICKS = 254_016_000_000;

interface FcItem { clip: number; name: string; start: number; duration: number; startFrame: number; durationFrames: number; speed: number; effects?: Array<{ effect: string }> }
interface FcTrack { id: number; name: string; items: FcItem[]; transitions?: unknown[] }
interface FcSequence { video?: FcTrack[]; audio?: FcTrack[]; duration: number; playhead: number | null; selection?: number[]; settings?: { frame_rate?: { num: number; den: number } } }

/**
 * FilmCraft: `filmcraft --control <port>` (loopback, no token) driven through `filmcraft-cli mcp
 * --bridge`. Each open starts a fresh FilmCraft project with the video on its own sequence; the
 * library file is only read. Auto-save/recovery data goes to the project's work folder.
 */
export class LiveFilmCraft extends LiveAppBase {
  readonly appId = 'filmcraft' as const;
  protected exeName = 'filmcraft';
  private opened = false;

  protected guiArgs(port: number) { return ['--control', String(port), '--empty', '--no-recover', '--data-dir', path.join(this.o.writeRoot, 'filmcraft-data')]; }
  protected guiEnv() { return {}; }
  protected bridgeArgs(port: number) { return ['mcp', '--bridge', `127.0.0.1:${port}`]; }

  private cmd(id: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    return this.client().callTool('command_run', { id, params }, timeoutMs);
  }
  private async sequence(): Promise<FcSequence> {
    return (await this.client().callTool('sequence_inspect', {})) as FcSequence;
  }

  async open(absPath: string) {
    if (this.opened) {
      await this.cmd('file.closeProject', { force: true });
      await this.cmd('file.newProject', { name: 'CreateCraft' });
    }
    const r = (await this.client().callTool('media_import', { paths: [absPath] })) as { items?: number[]; errors?: unknown[] };
    const item = r.items?.[0];
    if (item === undefined) throw new Error(`FilmCraft could not import the file${r.errors?.length ? `: ${JSON.stringify(r.errors[0])}` : '.'}`);
    await this.cmd('file.newSequence', { name: path.basename(absPath).replace(/\.[^.]+$/, ''), fromItem: item });
    this.opened = true;
    return { name: path.basename(absPath) };
  }
  async run(op: AppOperation) { await this.cmd(op.command, op.params); }
  async history() {
    const h = (await this.cmd('history.list')) as { undo?: string[] };
    return ['Open', ...(h.undo ?? []).slice(2)]; // the import and new-sequence steps are part of opening
  }
  async undo() {
    const h = (await this.cmd('history.list')) as { undo?: string[] };
    if ((h.undo?.length ?? 0) <= 2) throw new Error('Nothing to undo.');
    await this.cmd('edit.undo');
  }
  async quickEditSteps(opId: string, values: EditValues): Promise<AppOperation[]> {
    const s = await this.sequence();
    const fr = s.settings?.frame_rate;
    const fps = fr && fr.den ? fr.num / fr.den : 24;
    const clips = (t?: FcTrack) => (t?.items ?? []).map((i) => ({ clip: i.clip, startFrame: i.startFrame, durationFrames: i.durationFrames }));
    return filmcraftSteps(opId, values, { fps, video: clips(s.video?.[0]), audio: clips(s.audio?.[0]) });
  }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.mp4`);
    await this.cmd('file.exportMedia', { path: main, format: 'h264', wait: true }, 600_000);
    await waitForFile(main);
    return { main };
  }
  async preview(maxSide: number) { return imageOf(await this.client().request('tools/call', { name: 'render_frame', arguments: { max_side: maxSide } })); }
  async screenshot(maxSide: number) { return imageOf(await this.client().request('tools/call', { name: 'ui_screenshot', arguments: { max_side: maxSide } })); }
  async applyTheme(value: string): Promise<string | null> {
    await this.cmd('prefs.set', { key: 'appearance.colorTheme', value });
    const now = await this.cmd('prefs.get', { key: 'appearance.colorTheme' });
    return typeof now === 'string' ? now : null;
  }
  async timeline(): Promise<TimelineDto> {
    const s = await this.sequence();
    const fr = s.settings?.frame_rate;
    const sec = (t: number) => Math.round((t / TICKS) * 1000) / 1000;
    const track = (t: FcTrack, kind: 'video' | 'audio') => ({
      id: t.id, name: t.name, kind, transitions: t.transitions?.length ?? 0,
      clips: t.items.map((i) => ({ id: i.clip, name: i.name.replace(/^[0-9a-f]{8}-/, ''), start: sec(i.start), duration: sec(i.duration), speed: i.speed, effects: (i.effects ?? []).map((e) => e.effect) })),
    });
    const used = (ts?: FcTrack[]) => (ts ?? []).filter((t, i) => i === 0 || t.items.length);
    return {
      duration: sec(s.duration), fps: fr && fr.den ? fr.num / fr.den : 24, playhead: s.playhead === null ? null : sec(s.playhead),
      tracks: [...used(s.video).reverse().map((t) => track(t, 'video')), ...used(s.audio).map((t) => track(t, 'audio'))],
      selection: s.selection ?? [],
    };
  }
  /** The timeline (clips, times in seconds, effects) so Claude knows what the video looks like. */
  describe() { return this.timeline(); }
  async setPlayhead(seconds: number) { await this.cmd('playhead.set', { seconds }); }
  async selectClip(clipId: number) { await this.cmd('timeline.select', { clips: [clipId], add: false, toggle: false }); }
}

/**
 * LightCraft: `lightcraft --control <port> --memory` (a throwaway in-memory session, so the user's
 * LightCraft library is never touched) driven through `lightcraft-cli mcp --connect`. The photo is
 * imported from a copy in the work folder (LightCraft may write sidecars next to what it imports).
 */
export class LiveLightCraft extends LiveAppBase {
  readonly appId = 'lightcraft' as const;
  protected exeName = 'lightcraft';
  private photo: number | null = null;
  private port = 0;
  private ext = 'png';

  protected guiArgs(port: number) { this.port = port; return ['--control', String(port), '--memory', '--no-demo']; }
  protected guiEnv() { return {}; }
  protected bridgeArgs(port: number) { return ['mcp', '--connect', `127.0.0.1:${port}`]; }

  private cmd(command: string, params: Record<string, unknown> = {}) { return this.client().callTool('run_command', { command, params }); }

  async open(absPath: string) {
    const copy = path.join(this.o.writeRoot, `src-${Date.now().toString(36)}-${path.basename(absPath).replace(/[^\w.-]+/g, '_')}`);
    await fs.copyFile(absPath, copy);
    await fs.chmod(copy, 0o666);
    const r = (await this.client().callTool('import', { paths: [copy] })) as { imported?: number[]; duplicates?: number[] };
    const id = r.imported?.[0] ?? r.duplicates?.[0];
    if (id === undefined) throw new Error('LightCraft did not import the photo.');
    await this.client().callTool('select_photos', { ids: [id], active: id });
    this.photo = id;
    const e = path.extname(absPath).slice(1).toLowerCase();
    this.ext = e === 'jpeg' ? 'jpg' : ['jpg', 'png', 'tif', 'tiff', 'webp'].includes(e) ? e : 'png';
    return { name: path.basename(absPath) };
  }
  async run(op: AppOperation) {
    if (this.photo === null) throw new Error('No photo is open in LightCraft.');
    await this.cmd(op.command, op.params);
  }
  async history() {
    const h = (await this.cmd('history.list', this.photo === null ? {} : { id: this.photo })) as { history?: string[] };
    return ['Open', ...(h.history ?? [])];
  }
  async undo() { await this.cmd('edit.undo'); }
  quickEditSteps(opId: string, values: EditValues): AppOperation[] { return lightcraftSteps(opId, values); }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.${this.ext}`);
    await this.cmd('app.export', { path: main, longEdge: 0, ...(this.photo !== null ? { ids: [this.photo] } : {}) });
    await waitForFile(main);
    return { main };
  }
  async preview(maxSide: number) { return imageOf(await this.client().request('tools/call', { name: 'render_preview', arguments: { max_side: maxSide } })); }
  /** settings.appearanceMode through the control channel (`lightcraft-cli run --connect … ui.set`). */
  async applyTheme(value: string): Promise<string | null> {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(path.join(this.o.installDir, 'lightcraft-cli.exe'), ['run', '--connect', `127.0.0.1:${this.port}`, 'ui.set', JSON.stringify({ settings: { appearanceMode: value } })],
        { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
    const m = /"appearanceMode"\s*:\s*"(\w+)"/.exec(out);
    return m?.[1] ?? null;
  }
}

/**
 * EffectCraft: `effectcraft` with EFFECTCRAFT_CONTROL_PORT (loopback) driven through `effectcraft-cli
 * mcp --bridge` with automation roots, so EffectCraft refuses automated file access outside the
 * project (read) and its work folder (write), and refuses scripts. Each open makes a new project
 * with a composition from the file.
 */
export class LiveEffectCraft extends LiveAppBase {
  readonly appId = 'effectcraft' as const;
  protected exeName = 'effectcraft';
  private layer: number | null = null;
  private still = false;

  protected guiArgs() { return []; }
  protected guiEnv(port: number) { return { EFFECTCRAFT_CONTROL_PORT: String(port) }; }
  protected bridgeArgs(port: number) { return ['mcp', '--bridge', String(port), '--automation-read-root', this.o.readRoot, '--automation-write-root', this.o.writeRoot]; }

  private exec(command: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    return this.client().callTool('execute_command', { command, params }, timeoutMs);
  }

  async open(absPath: string) {
    await this.client().callTool('open_project', { new: true });
    const r = (await this.exec('file.import', { paths: [absPath] })) as { items?: number[]; errors?: unknown[] };
    const item = r.items?.[0];
    if (item === undefined) throw new Error(`EffectCraft could not import the file${r.errors?.length ? `: ${JSON.stringify(r.errors[0])}` : '.'}`);
    this.still = !['mp4', 'mov', 'webm', 'mkv'].includes(path.extname(absPath).slice(1).toLowerCase());
    await this.exec('project.select', { items: [item] });
    await this.exec('file.newCompFromSelection', this.still ? { duration: 5 } : {});
    const comp = (await this.client().callTool('get_comp', {})) as { layers?: Array<{ id: number; type: string }> };
    this.layer = comp.layers?.find((l) => l.type !== 'Text')?.id ?? null;
    return { name: path.basename(absPath) };
  }
  async run(op: AppOperation) {
    if (op.command.startsWith('tool:')) await this.client().callTool(op.command.slice(5), op.params);
    else await this.exec(op.command, op.params);
  }
  async history() {
    const p = (await this.client().callTool('get_project', {})) as { undo?: string[] };
    return ['Open', ...(p.undo ?? []).slice(2)]; // import + new comp are part of opening
  }
  async undo() {
    const p = (await this.client().callTool('get_project', {})) as { undo?: string[] };
    if ((p.undo?.length ?? 0) <= 2) throw new Error('Nothing to undo.');
    await this.client().callTool('undo', {});
  }
  quickEditSteps(opId: string, values: EditValues): AppOperation[] {
    if (this.layer === null) throw new Error('No composition is open in EffectCraft.');
    return effectcraftSteps(opId, values, { layer: this.layer });
  }
  async writeVersion(dir: string, base: string) {
    if (this.still) {
      const main = path.join(dir, `${base}.png`);
      await this.client().callTool('render_frame', { time: 0, max_side: 0, path: main, inline: false });
      await waitForFile(main);
      return { main };
    }
    const main = path.join(dir, `${base}.mp4`);
    const item = (await this.exec('renderQueue.add', { format: 'h264', output: main })) as { id?: number };
    try {
      await this.exec('renderQueue.render', { wait: true }, 600_000);
    } finally {
      if (item?.id !== undefined) await this.exec('renderQueue.remove', { item: item.id }).catch(() => {});
    }
    await waitForFile(main);
    return { main };
  }
  async preview(maxSide: number) { return imageOf(await this.client().request('tools/call', { name: 'render_preview', arguments: { max_side: maxSide } })); }
  async applyTheme(value: string): Promise<string | null> {
    await this.exec('prefs.set', { key: 'appearance.appearanceMode', value });
    const now = await this.exec('prefs.get', { key: 'appearance.appearanceMode' });
    return typeof now === 'string' ? now : null;
  }
}

interface DcInspect {
  pageCount?: number;
  settings?: { pageWidth: number; pageHeight: number };
  spreads?: Array<{ pages?: DesignPage[] }>;
  stories?: Array<{ preview: string }>;
}

/**
 * DesignCraft: `designcraft --control <port>` (loopback, no token) driven through `designcraft-cli
 * mcp --connect`. The layout is opened read-only from the library; saving writes a new
 * .designcraft into the work folder (plus a PNG of the first page).
 */
export class LiveDesignCraft extends LiveAppBase {
  readonly appId = 'designcraft' as const;
  protected exeName = 'designcraft';

  protected guiArgs(port: number) { return ['--control', String(port)]; }
  protected guiEnv() { return {}; }
  protected bridgeArgs(port: number) { return ['mcp', '--connect', String(port)]; }

  async open(absPath: string) {
    await this.client().callTool('open_document', { path: absPath });
    return { name: path.basename(absPath) };
  }
  private exec(command: string, params: Record<string, unknown> = {}) { return this.client().callTool('execute', { command, params }); }
  private async inspect() { return (await this.exec('document.inspect')) as DcInspect; }

  async run(op: AppOperation) {
    if (op.command === 'createcraft.addText') {
      // New text frame, then size and colour applied to just that story (verified headless + live).
      const { rect, text, size, fill } = op.params as { rect: number[]; text: string; size: number; fill: string };
      const r = (await this.exec('frame.create', { rect, content: 'text', text })) as { story?: number };
      if (r?.story !== undefined) await this.exec('find.change', { find: text, change: text, story: r.story, attrs: { size, fill } });
      return;
    }
    const r = (await this.exec(op.command, op.params)) as { count?: number };
    if (op.command === 'find.change' && r?.count === 0) throw new Error(`"${String(op.params.find)}" was not found in the layout.`);
  }
  async quickEditSteps(opId: string, values: EditValues): Promise<AppOperation[]> {
    const page = (await this.inspect()).spreads?.[0]?.pages?.[0];
    if (!page) throw new Error('The layout has no pages.');
    return designcraftSteps(opId, values, page);
  }
  /** Page size and the text on each page, so Claude knows what it can replace. */
  async describe() {
    const d = await this.inspect();
    return {
      pages: d.pageCount, pageSize: d.settings ? `${d.settings.pageWidth}x${d.settings.pageHeight} pt` : undefined,
      text: (d.stories ?? []).map((s) => s.preview),
    };
  }
  async history() {
    const h = (await this.exec('document.history')) as { undo?: string[] };
    return ['Open', ...(h.undo ?? [])];
  }
  async undo() { await this.exec('edit.undo'); }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.designcraft`);
    const preview = path.join(dir, `${base}.png`);
    await this.client().callTool('save_document', { path: main });
    await waitForFile(main);
    await this.client().callTool('export_png', { path: preview, page: 0, scale: 1 });
    await waitForFile(preview);
    return { main, preview };
  }
  async preview(maxSide: number) {
    const png = imageOf(await this.client().request('tools/call', { name: 'render_page', arguments: { page: 0, scale: Math.min(2, maxSide / 800) } }));
    return png;
  }
  async screenshot() { return imageOf(await this.client().request('tools/call', { name: 'screenshot', arguments: {} })); }
  async applyTheme(value: string): Promise<string | null> {
    await this.client().callTool('ui_set', { brightness: value });
    const ui = (await this.client().callTool('ui_inspect', {})) as { ui?: { brightness?: string } };
    const b = ui?.ui?.brightness;
    return b ? b.charAt(0).toLowerCase() + b.slice(1) : null;
  }
}

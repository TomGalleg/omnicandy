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
import net from 'node:net';
import path from 'node:path';
import { designcraftSteps, effectcraftSteps, filmcraftSteps, type DesignPage, lightcraftSteps, cadcraftSteps, deckcraftSteps, figcraftSteps, gridcraftSteps, pdfcraftSteps, vectorcraftSteps, wordcraftSteps, type EditValues, type EditorAppId } from '@shared/appEditors';
import type { TimelineDto, TimelineEdit } from '@shared/live';
import type { AppOperation } from '@shared/contracts';
import { McpClient } from './mcpClient';
import { freePort, waitForPort, type LiveDoc } from './photocraftLive';
import { binName } from '@shared/platform';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LiveAppOptions {
  installDir: string;
  readRoot: string;
  writeRoot: string;
  /** Called with the app's process id right after launch (before its window appears). */
  onSpawn?: (pid: number) => void;
  /**
   * Run the app's engine in its command-line tool's own MCP server, with no window (workflows).
   * Only apps with headlessArgs() support it.
   */
  headless?: boolean;
}

abstract class LiveAppBase implements LiveDoc {
  /** What the last engine command returned, so Claude can read it back (app_command shows it). */
  lastResult: unknown = undefined;
  protected gui: ChildProcess | null = null;
  protected mcp: McpClient | null = null;
  private starting: Promise<void> | null = null;
  abstract readonly appId: EditorAppId;
  protected abstract exeName: string;

  constructor(protected readonly o: LiveAppOptions) {}

  get connected(): boolean { return this.o.headless ? !!this.mcp?.alive : !!this.mcp?.alive && !!this.gui && this.gui.exitCode === null; }
  /** The app window's process (none when headless). */
  get pid(): number | null { return this.connected && this.gui ? this.gui.pid ?? null : null; }

  async ensureStarted(): Promise<void> {
    if (this.connected) return;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  protected abstract guiEnv(port: number): NodeJS.ProcessEnv;
  /** Command-line arguments for the app window (default: just the control port). */
  protected guiArgs(port: number): string[] { return ['--control', String(port)]; }
  protected abstract bridgeArgs(port: number): string[];
  /** Arguments for the CLI's MCP server running the engine without a window; null when not supported. */
  protected headlessArgs(): string[] | null { return null; }

  private async start(): Promise<void> {
    this.stop();
    await fs.mkdir(this.o.writeRoot, { recursive: true });
    if (this.o.headless) {
      const args = this.headlessArgs();
      if (!args) throw new Error(`The ${this.appId} engine can't run without its window.`);
      this.mcp = await McpClient.start(path.join(this.o.installDir, binName(`${this.exeName}-cli`)), args);
      return;
    }
    const port = await freePort();
    const gui = spawn(path.join(this.o.installDir, binName(this.exeName)), this.guiArgs(port), {
      env: { ...process.env, ...this.guiEnv(port) }, stdio: 'ignore', windowsHide: false,
    });
    this.gui = gui;
    if (gui.pid) this.o.onSpawn?.(gui.pid);
    gui.on('exit', () => { if (this.gui === gui) { this.gui = null; this.mcp?.close(); this.mcp = null; } });
    await waitForPort(port, 30_000, () => gui.exitCode !== null);
    this.mcp = await McpClient.start(path.join(this.o.installDir, binName(`${this.exeName}-cli`)), this.bridgeArgs(port));
  }

  protected client(): McpClient {
    if (!this.connected || !this.mcp) throw new Error(this.o.headless ? `The ${this.appId} engine stopped.` : `The ${this.appId} window is not running (was it closed?).`);
    return this.mcp;
  }

  abstract open(absPath: string): Promise<{ name: string }>;
  abstract run(op: AppOperation): Promise<void>;
  abstract history(): Promise<string[]>;
  abstract writeVersion(dir: string, base: string): Promise<{ main: string; preview?: string }>;
  /** Optional cheap save of the just-opened state (no preview), used to tell "nothing changed" semantically. */
  writeBaseline?(dir: string, base: string): Promise<string>;

  /** Runs `<app>-cli <args>` and returns its output (used for command discovery). */
  protected cliText(args: string[]): Promise<string> {
    const exe = path.join(this.o.installDir, binName(`${this.exeName}-cli`));
    return new Promise<string>((resolve, reject) => {
      execFile(exe, args, { windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err && !stdout ? reject(new Error(`${this.appId} could not list its commands.`)) : resolve(stdout)));
    });
  }

  /**
   * Lists the engine commands through the app's own CLI (`commands`; JSON for most apps, plain lines for
   * SoundCraft). Disabled commands stay listed (the CLI has no document open). A filter that is exactly one
   * command id returns that command's full details (`describe`) when the app has it.
   */
  async listCommands(filter?: string): Promise<string> {
    const f = filter?.trim() ?? '';
    if (f && /^[A-Za-z0-9_.:-]+$/.test(f)) {
      const d = await this.cliText(['describe', f]).catch(() => '');
      if (d.trim() && !/unknown|no such|not found/i.test(d.slice(0, 120))) return d.trim().slice(0, 4000);
    }
    const out = await this.cliText(['commands']);
    let rows: string[];
    try {
      const list = JSON.parse(out) as Array<Record<string, unknown>>;
      if (!Array.isArray(list)) throw new Error('not a list');
      rows = list.filter((c) => typeof c.id === 'string').map((c) => `${c.id}${c.params ? ` ${String(typeof c.params === 'string' ? c.params : JSON.stringify(c.params)).slice(0, 300)}` : ''}${c.label ? ` — ${String(c.label)}` : ''}`);
    } catch {
      rows = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/\s{2,}/g, ' — '));
    }
    if (!rows.length) throw new Error(`${this.appId} lists no engine commands; use its quick edits (get_status).`);
    const q = f.toLowerCase();
    const hit = q ? rows.filter((r) => r.toLowerCase().includes(q)) : rows;
    if (!hit.length) return `No ${this.appId} commands match "${filter}". Try a shorter word such as layer, text, frame, page, select or export.`;
    const shown = hit.slice(0, 80);
    return `${shown.join('\n')}${hit.length > shown.length ? `\n… ${hit.length - shown.length} more; narrow with a filter word, or pass one exact id for its full parameters.` : ''}`;
  }

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
    this.lastResult = await this.client().callTool('run_command', { command: op.command, params: op.params });
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
      execFile(path.join(this.o.installDir, binName('soundcraft-cli')), ['info', file], { windowsHide: true, timeout: 30_000 }, (err, out) => {
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
    this.lastResult = await this.client().callTool('execute', { command: op.command, params: op.params });
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
  protected headlessArgs() { return ['--data-dir', path.join(this.o.writeRoot, 'filmcraft-data'), 'mcp']; }

  private cmd(id: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    return this.client().callTool('command_run', { id, params }, timeoutMs);
  }
  private async sequence(): Promise<FcSequence> {
    return (await this.client().callTool('sequence_inspect', {})) as FcSequence;
  }

  async open(absPath: string) {
    if (this.opened) {
      await this.cmd('file.closeProject', { force: true });
      await this.cmd('file.newProject', { name: 'OmniCandi' });
    }
    const r = (await this.client().callTool('media_import', { paths: [absPath] })) as { items?: number[]; errors?: unknown[] };
    const item = r.items?.[0];
    if (item === undefined) throw new Error(`FilmCraft could not import the file${r.errors?.length ? `: ${JSON.stringify(r.errors[0])}` : '.'}`);
    await this.cmd('file.newSequence', { name: path.basename(absPath).replace(/\.[^.]+$/, ''), fromItem: item });
    this.opened = true;
    return { name: path.basename(absPath) };
  }
  async run(op: AppOperation) {
    if (op.command === 'createcraft.place') return this.place(op.params as { path: string; as: 'clip' | 'music'; still?: boolean });
    if (op.command === 'createcraft.fitMusic') return this.fitMusic();
    this.lastResult = await this.cmd(op.command, op.params);
  }
  /**
   * Adds a library file to the open sequence (verified live): a clip goes at the end of V1 with its
   * sound on A1; music goes on the first free audio track from the start, with sync lock off so
   * reordering clips doesn't shift it, trimmed to the picture's length.
   */
  private async place(p: { path: string; as: 'clip' | 'music'; still?: boolean }) {
    const r = (await this.client().callTool('media_import', { paths: [p.path] })) as { items?: number[]; errors?: unknown[] };
    const item = r.items?.[0];
    if (item === undefined) throw new Error(`FilmCraft could not import ${path.basename(p.path)}${r.errors?.length ? `: ${JSON.stringify(r.errors[0])}` : ''}.`);
    let s = await this.sequence();
    const v1 = s.video?.[0], a1 = s.audio?.[0];
    const endOf = (t?: FcTrack) => Math.max(0, ...(t?.items ?? []).map((i) => i.start + i.duration));
    if (p.as === 'clip') {
      if (!v1) throw new Error('The sequence has no video track.');
      await this.cmd('timeline.place', { item, track: v1.id, ...(a1 ? { audioTrack: a1.id } : {}), time: endOf(v1), insert: false, ...(p.still ? { duration: 3 * TICKS } : {}) });
      await this.fitMusic(); // music that was cut to the old length runs on under the new clip
      return;
    }
    let music = (s.audio ?? []).slice(1).find((t) => !t.items.length);
    if (!music) {
      await this.cmd('sequence.addTracks', { video: 0, audio: 1 });
      s = await this.sequence();
      music = (s.audio ?? []).slice(1).find((t) => !t.items.length);
      if (!music) throw new Error('Could not add a music track.');
    }
    await this.cmd('timeline.place', { item, track: music.id, time: 0, insert: false, video: false });
    await this.cmd('timeline.setTrack', { track: music.id, syncLock: false, name: 'Music' });
    await this.fitMusic();
  }
  /**
   * Music follows the picture's length: never past its end (trimmed, or removed when it starts after
   * it), and the last music clip runs on to the end again when the picture gets longer, as far as the
   * music file allows.
   */
  private async fitMusic() {
    const s = await this.sequence();
    const picture = Math.max(0, ...(s.video?.[0]?.items ?? []).map((i) => i.start + i.duration));
    if (!picture) return;
    for (const i of (s.audio ?? []).slice(1).flatMap((t) => t.items)) {
      const end = i.start + i.duration;
      if (i.start >= picture) await this.cmd('edit.clear', { clips: [i.clip] });
      else if (end > picture) await this.cmd('timeline.trim', { clip: i.clip, edge: 'out', mode: 'regular', delta: picture - end });
    }
    const music = (s.audio ?? []).slice(1).flatMap((t) => t.items);
    const last = music.sort((a, b) => b.start + b.duration - (a.start + a.duration))[0];
    if (last && last.start < picture && last.start + last.duration < picture) {
      // FilmCraft stops the trim where the media ends; a refusal just leaves the music as it is.
      await this.cmd('timeline.trim', { clip: last.clip, edge: 'out', mode: 'regular', delta: picture - (last.start + last.duration) }).catch(() => {});
    }
  }
  /** FilmCraft steps for a clip-list change (the file path is resolved and checked by the controller). */
  async timelineSteps(edit: TimelineEdit, file?: { path: string; still: boolean }): Promise<AppOperation[]> {
    if (edit.kind === 'add') {
      if (!file) throw new Error('No file to add.');
      return [{ command: 'createcraft.place', params: { path: file.path, as: edit.as, still: file.still } }];
    }
    const s = await this.sequence();
    const v1 = s.video?.[0];
    const clips = [...(v1?.items ?? [])].sort((a, b) => a.start - b.start);
    const all = [...(s.video ?? []), ...(s.audio ?? [])].flatMap((t) => t.items);
    if (!all.some((i) => i.clip === edit.clip)) throw new Error(`There is no clip ${edit.clip} on the timeline.`);
    if (edit.kind === 'remove') {
      if (clips.length === 1 && clips[0]!.clip === edit.clip) throw new Error('That is the only picture clip; open another video instead.');
      return [{ command: 'edit.rippleDelete', params: { clips: [edit.clip] } }, { command: 'createcraft.fitMusic', params: {} }];
    }
    const from = clips.findIndex((i) => i.clip === edit.clip);
    if (from < 0) throw new Error('Only picture clips (V1) can be reordered.');
    const to = Math.max(0, Math.min(clips.length - 1, Math.round(edit.to)));
    if (to === from) throw new Error('The clip is already there.');
    // Insert-move: before the clip now at `to` (moving earlier) or after it (moving later).
    const target = clips[to]!;
    const time = to < from ? target.start : target.start + target.duration;
    return [{ command: 'timeline.move', params: { moves: [{ clip: edit.clip, track: v1!.id, time }], insert: true, linked: true } }];
  }
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
    const clips = (t?: FcTrack) => [...(t?.items ?? [])].sort((a, b) => a.start - b.start).map((i) => ({ clip: i.clip, startFrame: i.startFrame, durationFrames: i.durationFrames }));
    const music = (s.audio ?? []).slice(1).flatMap((t) => clips(t));
    const steps = filmcraftSteps(opId, values, { fps, video: clips(s.video?.[0]), audio: clips(s.audio?.[0]), music });
    // Trims and speed changes shorten the picture: keep the music inside it.
    return music.length && (opId === 'trim' || opId === 'speed') ? [...steps, { command: 'createcraft.fitMusic', params: {} }] : steps;
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
    const track = (t: FcTrack, kind: 'video' | 'audio', music = false) => ({
      id: t.id, name: music ? 'Music' : t.name, kind, ...(music ? { music: true } : {}), transitions: t.transitions?.length ?? 0,
      clips: t.items.map((i) => ({ id: i.clip, name: i.name.replace(/^[0-9a-f]{8}-/, ''), start: sec(i.start), duration: sec(i.duration), speed: i.speed, effects: (i.effects ?? []).map((e) => e.effect) })),
    });
    const used = (ts?: FcTrack[]) => (ts ?? []).filter((t, i) => i === 0 || t.items.length);
    return {
      duration: sec(s.duration), fps: fr && fr.den ? fr.num / fr.den : 24, playhead: s.playhead === null ? null : sec(s.playhead),
      tracks: [...used(s.video).reverse().map((t) => track(t, 'video')), ...used(s.audio).map((t, i) => track(t, 'audio', i > 0))],
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
  /** In-memory session: the user's LightCraft library is never opened. */
  protected headlessArgs() { return ['mcp']; }

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
    this.lastResult = await this.cmd(op.command, op.params);
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
      execFile(path.join(this.o.installDir, binName('lightcraft-cli')), ['run', '--connect', `127.0.0.1:${this.port}`, 'ui.set', JSON.stringify({ settings: { appearanceMode: value } })],
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
  protected headlessArgs() { return ['mcp', '--automation-read-root', this.o.readRoot, '--automation-write-root', this.o.writeRoot]; }

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
    if (op.command.startsWith('tool:')) this.lastResult = await this.client().callTool(op.command.slice(5), op.params);
    else this.lastResult = await this.exec(op.command, op.params);
  }
  async history() {
    const p = (await this.client().callTool('get_project', {})) as { undo?: string[] };
    return ['Open', ...(p.undo ?? []).slice(2)]; // import + new comp are part of opening
  }
  /** EffectCraft's friendlier automation tools (set_property, add_keyframe, add_effect, get_comp...) plus the engine commands. */
  async listCommands(filter?: string): Promise<string> {
    const q = filter?.trim().toLowerCase() ?? '';
    const skip = new Set(['execute_command', 'run_script', 'script_ui', 'open_project', 'save_project', 'list_commands', 'describe_command', 'command_list', 'command_run', 'command_batch', 'batch']);
    const tools = ((await this.client().request('tools/list', {}).catch(() => ({ tools: [] }))) as { tools?: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }> }).tools ?? [];
    const exact = tools.find((t) => !skip.has(t.name) && (t.name === q || `tool:${t.name}` === q));
    if (exact) return `tool:${exact.name}
${exact.description ?? ''}
params: ${JSON.stringify(exact.inputSchema?.properties ?? {}).slice(0, 2500)}
required: ${(exact.inputSchema?.required ?? []).join(', ') || 'none'}`;
    const rows = tools.filter((t) => !skip.has(t.name) && (!q || `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q)))
      .map((t) => `tool:${t.name} {${Object.keys(t.inputSchema?.properties ?? {}).join(', ')}} — ${(t.description ?? '').split(/(?<=\.)\s/)[0]?.slice(0, 110) ?? ''}`);
    const cmds = await super.listCommands(filter).catch(() => '');
    return [rows.length ? `Tools (use as tool:<name>; set_property with "time" makes a keyframe, paths like transform/position or effects/#1/blurriness):
${rows.join('\n')}` : '', cmds ? `Engine commands:
${cmds}` : ''].filter(Boolean).join('\n\n') || `No EffectCraft commands match "${filter}".`;
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
  protected headlessArgs() { return ['mcp']; }

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
    this.lastResult = r;
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
  async writeBaseline(dir: string, base: string) {
    const main = path.join(dir, `${base}.designcraft`);
    await this.client().callTool('save_document', { path: main });
    await waitForFile(main);
    return main;
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

/**
 * WordCraft: `wordcraft --control <port>` (loopback, no token) driven through `wordcraft-cli mcp
 * --connect 127.0.0.1:<port>`. The .docx is opened from the library and never written back; saving
 * writes a new .docx into the work folder plus a PNG of page 1. Headless runs use the CLI's own MCP
 * engine confined to the library (read) and the work folder (write) with its automation roots.
 */
export class LiveWordCraft extends LiveAppBase {
  readonly appId = 'wordcraft' as const;
  protected exeName = 'wordcraft';

  protected guiArgs(port: number) { return ['--control', String(port)]; }
  protected guiEnv() { return {}; }
  protected bridgeArgs(port: number) { return ['mcp', '--connect', `127.0.0.1:${port}`]; }
  protected headlessArgs() { return ['mcp', '--automation-read-root', this.o.readRoot, '--automation-write-root', this.o.writeRoot]; }

  async open(absPath: string) {
    await this.client().callTool('open_document', { path: absPath });
    return { name: path.basename(absPath) };
  }
  private exec(command: string, params: Record<string, unknown> = {}) { return this.client().callTool('execute', { command, params }); }

  async run(op: AppOperation) {
    const r = (await this.exec(op.command, op.params)) as { replaced?: number };
    this.lastResult = r;
    if (op.command === 'edit.replaceAll' && r?.replaced === 0) throw new Error(`"${String(op.params.text)}" was not found in the document.`);
  }
  async quickEditSteps(opId: string, values: EditValues): Promise<AppOperation[]> {
    return wordcraftSteps(opId, values);
  }
  /** Page count, word count and the opening text, so Claude knows what it can replace. */
  async describe() {
    const d = (await this.client().callTool('inspect_document', {})) as { pages?: number; blocks?: Array<{ text?: string }> };
    const text = (d.blocks ?? []).map((b) => b.text ?? '').filter(Boolean);
    return { pages: d.pages, text: text.slice(0, 40).map((t) => t.slice(0, 160)) };
  }
  async history() {
    const h = (await this.exec('edit.undoHistory')) as { undo?: string[] };
    return ['Open', ...(h.undo ?? [])];
  }
  async undo() { await this.exec('edit.undo'); }
  /** Cheap save of the just-opened document, so "unchanged" and "undone" saves can be told apart by content. */
  async writeBaseline(dir: string, base: string) {
    const main = path.join(dir, `${base}.docx`);
    await this.client().callTool('save_document', { path: main });
    await waitForFile(main);
    return main;
  }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.docx`);
    const preview = path.join(dir, `${base}.png`);
    await this.client().callTool('save_document', { path: main });
    await waitForFile(main);
    // Page 1 as a picture (the PNG the library shows beside the document).
    const png = imageOf(await this.client().request('tools/call', { name: 'render_page', arguments: { page: 1, scale: 1.5 } }));
    if (png) { await fs.writeFile(preview, png); return { main, preview }; }
    return { main };
  }
  async preview(maxSide: number) {
    return imageOf(await this.client().request('tools/call', { name: 'render_page', arguments: { page: 1, scale: Math.min(2, maxSide / 800) } }));
  }
  async screenshot() { return imageOf(await this.client().request('tools/call', { name: 'screenshot', arguments: {} })); }
}

/** Friendly history names for PdfCraft operations. */
const PDF_STEP_LABEL: Record<string, string> = {
  'pdf.replaceText': 'Replace text', 'pdf.addText': 'Add text', 'tool:page_rotate': 'Rotate pages', 'tool:page_delete': 'Delete pages',
  'tool:doc_watermark': 'Add watermark', 'tool:doc_set_info': 'Set title',
};
/** Engine tools that manage documents, windows or the machine rather than edit the open PDF; OmniCandi runs those itself or never. */
const PDF_BLOCKED_TOOLS = new Set(['doc_open', 'doc_close', 'doc_list', 'doc_batch', 'doc_save', 'doc_print', 'printers', 'printer_options', 'link_open', 'sign_windows_ids', 'sign_keychain_ids', 'sign_id_create', 'sign_trust', 'command_run', 'command_batch', 'command_list', 'js_enabled', 'ocr_recognize_files', 'doc_create_multiple', 'doc_split']);
const isPdfEngineTool = (name: string) => /^[a-z][a-z0-9_]*$/.test(name) && !PDF_BLOCKED_TOOLS.has(name);

/**
 * PdfCraft. Its window (`pdfcraft --control <file>`) only accepts GUI-level calls (open, commands without
 * parameters, state, screenshot) over a token-protected loopback port written to the control file, so the
 * document itself is edited by the CLI's own automation engine (`pdfcraft-cli mcp --root <work>`), which
 * has the full tool set and writes atomically. The window shows the same working copy and is refreshed
 * after every edit; edits made by hand in the window are saved into the working copy (never the library
 * original) and picked up before the next step, so you and Claude never overwrite each other.
 *
 * Every step is a snapshot of the working copy, so undo is exact and covers hand edits too.
 */
export class LivePdfCraft extends LiveAppBase {
  readonly appId = 'pdfcraft' as const;
  protected exeName = 'pdfcraft';
  private starting2: Promise<void> | null = null;
  private control: { port: number; token: string } | null = null;
  private work: string | null = null;
  private docId = 0;
  private snaps: string[] = [];
  private labels: string[] = [];
  private session = 0;

  protected guiEnv() { return {}; }
  protected bridgeArgs() { return ['mcp', '--root', this.o.writeRoot]; }
  protected headlessArgs() { return ['mcp', '--root', this.o.writeRoot]; }

  async ensureStarted(): Promise<void> {
    if (this.connected) return;
    this.starting2 ??= this.startPdf().finally(() => { this.starting2 = null; });
    return this.starting2;
  }

  private async startPdf(): Promise<void> {
    this.stop();
    await fs.mkdir(this.o.writeRoot, { recursive: true });
    const cli = path.join(this.o.installDir, binName('pdfcraft-cli'));
    this.mcp = await McpClient.start(cli, ['mcp', '--root', this.o.writeRoot]);
    if (this.o.headless) return;
    const ctlFile = path.join(this.o.writeRoot, 'pdfcraft-control.json');
    await fs.rm(ctlFile, { force: true });
    const gui = spawn(path.join(this.o.installDir, binName('pdfcraft')), ['--control', ctlFile], { stdio: 'ignore', windowsHide: false });
    this.gui = gui;
    if (gui.pid) this.o.onSpawn?.(gui.pid);
    gui.on('exit', () => { if (this.gui === gui) { this.gui = null; this.mcp?.close(); this.mcp = null; this.control = null; } });
    const end = Date.now() + 30_000;
    for (;;) {
      if (gui.exitCode !== null) throw new Error('PdfCraft closed before it was ready.');
      try {
        const c = JSON.parse(await fs.readFile(ctlFile, 'utf8')) as { port?: number; token?: string };
        if (c.port && c.token) { this.control = { port: c.port, token: c.token }; break; }
      } catch { /* not written yet */ }
      if (Date.now() > end) throw new Error('PdfCraft did not open its control port in time.');
      await sleep(150);
    }
    await waitForPort(this.control.port, 15_000, () => gui.exitCode !== null);
  }

  /** One GUI call on the window's control port (authenticated per connection). */
  private ui(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const c = this.control;
    if (!c) return Promise.reject(new Error('The PdfCraft window is not running (was it closed?).'));
    return new Promise((resolve, reject) => {
      const sock = net.connect(c.port, '127.0.0.1');
      let buf = '';
      let answered = 0;
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`PdfCraft's window did not answer ${method}.`)); }, 20_000);
      const send = (id: number, m: string, p: Record<string, unknown>) => sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: m, params: p })}\n`);
      sock.on('connect', () => send(1, 'auth', { token: c.token }));
      sock.on('error', (e) => { clearTimeout(timer); reject(new Error(`Can't reach the PdfCraft window (${e.message}).`)); });
      sock.on('data', (d) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const m = JSON.parse(line) as { error?: { message?: string }; result?: Record<string, unknown> };
          if (m.error) { clearTimeout(timer); sock.end(); reject(new Error(m.error.message ?? `${method} failed.`)); return; }
          if (answered++ === 0) send(2, method, params);
          else { clearTimeout(timer); sock.end(); resolve(m.result ?? {}); return; }
        }
      });
    });
  }

  private tool(name: string, args: Record<string, unknown> = {}, timeoutMs?: number) { return this.client().callTool(name, args, timeoutMs); }
  private toolInfo: Array<{ name: string; description?: string; read_only?: boolean; input_schema?: { properties?: Record<string, unknown>; required?: string[] } }> | null = null;
  lastResult: unknown = null;
  private async tools() {
    if (!this.toolInfo) this.toolInfo = JSON.parse(await this.cliText(['tools'])) as NonNullable<LivePdfCraft['toolInfo']>;
    return this.toolInfo;
  }
  private async isReadOnlyTool(name: string): Promise<boolean> { return (await this.tools().catch(() => [])).find((t) => t.name === name)?.read_only === true; }
  /** PdfCraft's automation tools (`tool:<name>` ids for app_command) with their parameters. */
  async listCommands(filter?: string): Promise<string> {
    const q = filter?.trim().toLowerCase() ?? '';
    const all = (await this.tools()).filter((t) => isPdfEngineTool(t.name));
    const exact = all.find((t) => t.name === q || `tool:${t.name}` === q);
    if (exact) return `tool:${exact.name}${exact.read_only ? ' (read only)' : ''}
${exact.description ?? ''}
params: ${JSON.stringify(exact.input_schema?.properties ?? {}).slice(0, 2500)}
required: ${(exact.input_schema?.required ?? []).join(', ') || 'none'} ("doc" is filled in for you)`;
    const rows = all.filter((t) => !q || `${t.name} ${t.description ?? ''}`.toLowerCase().includes(q)).map((t) => `tool:${t.name} {${Object.keys(t.input_schema?.properties ?? {}).filter((k) => k !== 'doc').join(', ')}} — ${(t.description ?? '').split(/(?<=\.)\s/)[0]?.slice(0, 110) ?? ''}`);
    if (!rows.length) return `No PdfCraft tools match "${filter}". Try page, text, form, redact, bookmark, comment, watermark, ocr or accessibility.`;
    return `${rows.slice(0, 70).join('\n')}${rows.length > 70 ? `\n… ${rows.length - 70} more; narrow with a filter word, or pass one exact tool name for its full parameters.` : ''}`;
  }

  /** Opens `absPath` as a working copy in the work folder; the library file is only read. */
  async open(absPath: string) {
    this.client();
    const dir = path.join(this.o.writeRoot, `session-${Date.now().toString(36)}-${++this.session}`);
    await fs.mkdir(dir, { recursive: true });
    const work = path.join(dir, path.basename(absPath));
    await fs.copyFile(absPath, work);
    await fs.chmod(work, 0o666); // library files are read-only; the working copy must be writable
    this.work = work;
    this.snaps = [];
    this.labels = [];
    try { await this.loadEngine(); } catch (e) { this.work = null; throw e; }
    this.snaps = [await this.snapshot()];
    await this.showInWindow();
    return { name: path.basename(absPath) };
  }

  private async snapshot(): Promise<string> {
    const f = path.join(path.dirname(this.work!), `step-${this.snaps.length}.pdf`);
    await fs.copyFile(this.work!, f);
    return f;
  }

  /** (Re)loads the working copy into the automation engine. */
  private async loadEngine() {
    const client = this.client();
    if (this.docId) { await client.callTool('doc_close', { doc: this.docId, discard_changes: true }).catch(() => {}); this.docId = 0; }
    try {
      const r = (await client.callTool('doc_open', { path: this.work })) as { doc?: number };
      if (!r?.doc) throw new Error('PdfCraft did not return a document.');
      this.docId = r.doc;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (/password|encrypt/i.test(m)) throw new Error('This PDF is password-protected. Remove the password in PdfCraft first, then open it again.');
      throw new Error(`PdfCraft could not read this file as a PDF (${m}).`);
    }
  }

  private same(a: string, b: string) { return path.resolve(a.replace(/^\\\\\?\\/, '')).toLowerCase() === path.resolve(b).toLowerCase(); }

  private async windowDocs(): Promise<Array<{ doc: number; path: string; dirty: boolean }>> {
    const s = (await this.ui('ui.state')) as { documents?: Array<{ doc: number; path?: string; dirty?: boolean }> };
    return (s.documents ?? []).map((d) => ({ doc: d.doc, path: d.path ?? '', dirty: !!d.dirty }));
  }

  /** Shows the working copy in the window: closes the tabs it had and opens the file fresh. */
  private async showInWindow() {
    if (this.o.headless || !this.control || !this.work) return;
    let docs = await this.windowDocs();
    for (let n = 0; docs.length && n < 12; n++) {
      if (docs.some((d) => d.dirty)) await this.ui('ui.command', { id: 'file.save' }).catch(() => {});
      await this.ui('ui.command', { id: 'file.close' }).catch(() => {});
      await sleep(150);
      const now = await this.windowDocs();
      if (now.length >= docs.length) break; // a prompt blocked the close
      docs = now;
    }
    await this.ui('ui.open', { path: this.work });
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      if ((await this.windowDocs()).some((d) => this.same(d.path, this.work!))) return;
    }
  }

  /** Takes in edits made by hand in the window: saved into the working copy, then re-read by the engine. */
  private async syncFromWindow() {
    if (this.o.headless || !this.control || !this.work) return;
    const mine = (await this.windowDocs()).filter((d) => this.same(d.path, this.work!));
    if (!mine.some((d) => d.dirty)) return;
    await this.ui('ui.command', { id: 'file.save' });
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      if (!(await this.windowDocs()).some((d) => this.same(d.path, this.work!) && d.dirty)) break;
    }
    this.snaps.push(await this.snapshot());
    this.labels.push('Edit in PdfCraft');
    await this.loadEngine();
  }

  async run(op: AppOperation) {
    if (!this.work) throw new Error('No PDF is open.');
    await this.syncFromWindow();
    const p = op.params;
    if (op.command === 'pdf.replaceText') await this.replaceText(String(p.find), String(p.replace));
    else if (op.command === 'pdf.addText') await this.addText(String(p.text), Number(p.page), String(p.position), Number(p.size));
    else if (op.command.startsWith('tool:')) {
      const name = op.command.slice(5);
      if (!isPdfEngineTool(name)) throw new Error(`PdfCraft tool "${name}" is not allowed.`);
      await this.checkPages(name, p.pages);
      const res = await this.tool(name, { doc: this.docId, ...p });
      this.lastResult = res;
      if (await this.isReadOnlyTool(name)) return;
    } else throw new Error(`Unknown PdfCraft command "${op.command}".`);
    await this.commit(PDF_STEP_LABEL[op.command] ?? op.command);
  }

  /** Saves the engine's document into the working copy, records a step and refreshes the window. */
  private async commit(label: string) {
    await this.tool('doc_save', { doc: this.docId, full: true });
    this.snaps.push(await this.snapshot());
    this.labels.push(label);
    await this.showInWindow();
  }

  private async pageCount(): Promise<number> {
    const r = (await this.tool('doc_info', { doc: this.docId })) as { pages?: unknown[] };
    return r.pages?.length ?? 0;
  }

  private async checkPages(tool: string, pages: unknown) {
    if (!Array.isArray(pages)) return;
    const n = await this.pageCount();
    if ((pages as number[]).some((x) => x > n)) throw new Error(`The document has only ${n} page${n === 1 ? '' : 's'}.`);
    if (tool === 'page_delete' && new Set(pages as number[]).size >= n) throw new Error('A PDF needs at least one page: leave one page in.');
  }

  private async replaceText(find: string, replace: string) {
    const n = await this.pageCount();
    let replaced = 0;
    for (let page = 1; page <= n; page++) {
      const r = (await this.tool('text_paragraphs', { doc: this.docId, page })) as { paragraphs?: Array<{ paragraph: number; text: string }> };
      for (const para of r.paragraphs ?? []) {
        if (!para.text.includes(find)) continue;
        await this.tool('text_edit', { doc: this.docId, page, paragraph: para.paragraph, text: para.text.split(find).join(replace) });
        replaced += para.text.split(find).length - 1;
      }
    }
    if (!replaced) throw new Error(`"${find}" was not found in the document.`);
  }

  private async addText(text: string, page: number, position: string, size: number) {
    const info = (await this.tool('doc_info', { doc: this.docId })) as { pages?: Array<{ width: number; height: number }> };
    const pg = info.pages?.[page - 1];
    if (!pg) throw new Error(`The document has only ${info.pages?.length ?? 0} page${info.pages?.length === 1 ? '' : 's'}.`);
    const y = position === 'top' ? 54 : position === 'middle' ? pg.height / 2 : pg.height - 90;
    await this.tool('page_add_text', { doc: this.docId, page, text, size, at: [72, Math.round(y)], width: Math.max(50, Math.round(pg.width - 144)) });
  }

  quickEditSteps(opId: string, values: EditValues): AppOperation[] { return pdfcraftSteps(opId, values); }

  async describe() {
    await this.syncFromWindow();
    const info = (await this.tool('doc_info', { doc: this.docId })) as { title?: string | null; pages?: unknown[] };
    const pages = info.pages?.length ?? 0;
    const t = (await this.tool('text_extract', { doc: this.docId, pages: Array.from({ length: Math.min(pages, 3) }, (_, i) => i + 1) })) as { pages?: Array<{ text?: string }> } | string;
    const raw = typeof t === 'string' ? t : (t.pages ?? []).map((p) => p.text ?? '').join('\n');
    const text = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 40).map((l) => l.slice(0, 160));
    return { pages, title: info.title ?? null, text };
  }

  async history() {
    await this.syncFromWindow();
    return ['Open', ...this.labels];
  }

  async undo() {
    await this.syncFromWindow();
    if (this.snaps.length <= 1) throw new Error('Nothing to undo.');
    this.snaps.pop();
    this.labels.pop();
    await fs.copyFile(this.snaps.at(-1)!, this.work!);
    await this.loadEngine();
    await this.showInWindow();
  }

  async writeVersion(dir: string, base: string) {
    await this.syncFromWindow();
    const main = path.join(dir, `${base}.pdf`);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(this.work!, main);
    await fs.chmod(main, 0o666);
    const png = await this.preview(1100);
    if (png) {
      const preview = path.join(dir, `${base}.png`);
      await fs.writeFile(preview, png);
      return { main, preview };
    }
    return { main };
  }

  async preview(maxSide: number) {
    if (!this.docId) return null;
    return imageOf(await this.client().request('tools/call', { name: 'render_preview', arguments: { doc: this.docId, page: 1, max_side: Math.min(4096, Math.max(64, Math.round(maxSide))) } }));
  }

  async screenshot() {
    const r = (await this.ui('ui.screenshot')) as { png_base64?: string };
    return r.png_base64 ? Buffer.from(r.png_base64, 'base64') : null;
  }
}

/**
 * GridCraft: `gridcraft --control <port>` (loopback, no token) driven through `gridcraft-cli mcp
 * --connect <port>`. The .xlsx is opened from the library and never written back (saving always goes
 * to a new file in the work folder). The headless engine (`gridcraft-cli mcp`) has no file roots, so
 * workflows only read the library file and write into their own scratch folder.
 */
export class LiveGridCraft extends LiveAppBase {
  readonly appId = 'gridcraft' as const;
  protected exeName = 'gridcraft';

  protected guiArgs(port: number) { return ['--control', String(port)]; }
  protected guiEnv() { return {}; }
  protected bridgeArgs(port: number) { return ['mcp', '--connect', String(port)]; }
  protected headlessArgs() { return ['mcp']; }

  async open(absPath: string) {
    await this.client().callTool('open_workbook', { path: absPath });
    return { name: path.basename(absPath) };
  }
  private exec(command: string, params: Record<string, unknown> = {}) { return this.client().callTool('execute_command', { command, params }); }

  async run(op: AppOperation) { this.lastResult = await this.exec(op.command, op.params); }
  async quickEditSteps(opId: string, values: EditValues): Promise<AppOperation[]> { return gridcraftSteps(opId, values); }
  /** Sheets, their used ranges and the top rows of the active sheet, so Claude knows what is there. */
  async describe() {
    const d = (await this.client().callTool('inspect_workbook', {})) as { activeSheet?: number; sheets?: Array<{ name: string; usedRange?: string }> };
    const sheets = d.sheets ?? [];
    const active = sheets[d.activeSheet ?? 0];
    let top: unknown[] = [];
    if (active?.usedRange) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(active.usedRange);
      const range = m ? `${m[1]}${m[2]}:${m[3]}${Math.min(Number(m[4]), Number(m[2]) + 11)}` : active.usedRange;
      const r = (await this.client().callTool('read_range', { range, sheet: active.name })) as { values?: unknown[] };
      top = r.values ?? [];
    }
    return { sheets: sheets.map((s) => ({ name: s.name, usedRange: s.usedRange })), activeSheet: active?.name, topRows: top };
  }
  async history() {
    const h = (await this.exec('history.list')) as { undo?: string[] };
    return ['Open', ...(h.undo ?? [])];
  }
  async undo() { await this.client().callTool('undo', {}); }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.xlsx`);
    await this.client().callTool('save_workbook', { path: main });
    await waitForFile(main);
    // A picture of the window, when there is one (the headless engine cannot draw).
    if (this.o.headless) return { main };
    const preview = path.join(dir, `${base}.png`);
    try {
      await this.client().callTool('screenshot', { path: preview });
      await waitForFile(preview);
      return { main, preview };
    } catch { return { main }; }
  }
  async preview(_maxSide: number) {
    if (this.o.headless) return null;
    const f = path.join(this.o.writeRoot, `preview-${Date.now()}.png`);
    try {
      await this.client().callTool('screenshot', { path: f });
      await waitForFile(f);
      const b = await fs.readFile(f);
      await fs.rm(f, { force: true });
      return b;
    } catch { return null; }
  }
}

/**
 * DeckCraft: `deckcraft --control <port>` (loopback, no token) driven through `deckcraft-cli mcp
 * --connect <port>`. The deck is opened from the library and never written back; saving writes a new
 * .deckcraft into the work folder plus a PNG of the current slide. DeckCraft has no find-and-replace
 * command, so text edits go through its set_text tool shape by shape (the first run's formatting is
 * kept for the whole shape).
 */
export class LiveDeckCraft extends LiveAppBase {
  readonly appId = 'deckcraft' as const;
  protected exeName = 'deckcraft';

  protected guiArgs(port: number) { return ['--control', String(port)]; }
  protected guiEnv() { return {}; }
  protected bridgeArgs(port: number) { return ['mcp', '--connect', String(port)]; }
  protected headlessArgs() { return ['mcp']; }

  async open(absPath: string) {
    await this.client().callTool('open_presentation', { path: absPath });
    return { name: path.basename(absPath) };
  }
  private cmd(command: string, params: Record<string, unknown> = {}) { return this.client().callTool('run_command', { command, params }); }
  private async slideCount(): Promise<number> {
    const d = (await this.client().callTool('inspect_document', {})) as { slides?: unknown[] };
    return d.slides?.length ?? 0;
  }

  async run(op: AppOperation) {
    if (op.command === 'createcraft.replaceText') {
      const { find, replace } = op.params as { find: string; replace: string };
      let changed = 0;
      const n = await this.slideCount();
      for (let i = 0; i < n; i++) {
        const s = (await this.client().callTool('inspect_slide', { index: i })) as { shapes?: Array<{ id: number; text?: string }> };
        for (const sh of s.shapes ?? []) {
          if (typeof sh.text !== 'string' || !sh.text.includes(find)) continue;
          await this.client().callTool('set_text', { id: sh.id, text: sh.text.split(find).join(replace) });
          changed++;
        }
      }
      if (!changed) throw new Error(`"${find}" was not found on any slide.`);
      return;
    }
    if (op.command === 'createcraft.addSlide') {
      const { title, body } = op.params as { title: string; body: string };
      await this.cmd('slide.new', { layout: 'titleAndContent', at: await this.slideCount(), title, body });
      return;
    }
    await this.cmd(op.command, op.params);
  }
  async quickEditSteps(opId: string, values: EditValues): Promise<AppOperation[]> { return deckcraftSteps(opId, values); }
  /** Slide titles, layouts and text, so Claude knows what it can replace. */
  async describe() {
    const d = (await this.client().callTool('inspect_document', {})) as { slides?: Array<{ index: number; title?: string; layout?: string }> };
    const slides = [];
    for (const s of (d.slides ?? []).slice(0, 30)) {
      const sl = (await this.client().callTool('inspect_slide', { index: s.index })) as { shapes?: Array<{ text?: string }> };
      slides.push({ slide: s.index + 1, title: s.title, layout: s.layout, text: (sl.shapes ?? []).map((x) => x.text ?? '').filter(Boolean).map((t) => t.slice(0, 120)) });
    }
    return { slideCount: d.slides?.length ?? 0, slides };
  }
  async history() {
    // inspect_document reports only the newest undo step, as one label (not a list).
    const d = (await this.client().callTool('inspect_document', {})) as { undo?: string | string[] | null };
    return ['Open', ...(Array.isArray(d.undo) ? d.undo : d.undo ? [d.undo] : [])];
  }
  async undo() { await this.cmd('edit.undo'); }
  async writeBaseline(dir: string, base: string) {
    const main = path.join(dir, `${base}.deckcraft`);
    await this.client().callTool('save_presentation', { path: main });
    await waitForFile(main);
    return main;
  }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.deckcraft`);
    const preview = path.join(dir, `${base}.png`);
    await this.client().callTool('save_presentation', { path: main });
    await waitForFile(main);
    const png = imageOf(await this.client().request('tools/call', { name: 'render_slide', arguments: { slide: 0, scale: 1 } }));
    if (png) { await fs.writeFile(preview, png); return { main, preview }; }
    return { main };
  }
  async preview(maxSide: number) {
    return imageOf(await this.client().request('tools/call', { name: 'render_slide', arguments: { scale: Math.min(2, maxSide / 960) } }));
  }
  async screenshot() { return null; }
}

interface FigNode { id: number; name?: string; type?: string; characters?: string; width?: number; height?: number; children?: FigNode[] }

/**
 * FigCraft: `figcraft --control <port>` (loopback, no token) driven through `figcraft-cli mcp
 * --attach <port>`. The .figcraft file is opened from the library and never written back; saving
 * writes a new .figcraft into the work folder plus a PNG of the current page (the window's own
 * renderer, also available without a window).
 */
export class LiveFigCraft extends LiveAppBase {
  readonly appId = 'figcraft' as const;
  protected exeName = 'figcraft';

  protected guiArgs(port: number) { return ['--control', String(port)]; }
  protected guiEnv() { return {}; }
  protected bridgeArgs(port: number) { return ['mcp', '--attach', String(port)]; }
  protected headlessArgs() { return ['mcp']; }

  async open(absPath: string) {
    await this.client().callTool('open_file', { path: absPath });
    return { name: path.basename(absPath) };
  }
  private async tree(allPages = false): Promise<{ history?: { undo?: string[] }; pages?: Array<{ name?: string; children?: FigNode[] }>; currentPage?: number }> {
    return (await this.client().callTool('inspect_document', { allPages, depth: 40 })) as never;
  }
  private static texts(nodes: FigNode[] | undefined, out: FigNode[] = []): FigNode[] {
    for (const n of nodes ?? []) {
      if (n.type === 'TEXT' && typeof n.characters === 'string') out.push(n);
      LiveFigCraft.texts(n.children, out);
    }
    return out;
  }

  async run(op: AppOperation) {
    if (op.command === 'createcraft.replaceText') {
      const { find, replace } = op.params as { find: string; replace: string };
      const t = await this.tree(true);
      const hits = (t.pages ?? []).flatMap((p) => LiveFigCraft.texts(p.children)).filter((n) => n.characters!.includes(find));
      if (!hits.length) throw new Error(`"${find}" was not found in any text layer.`);
      // One undo step for the whole replacement.
      await this.client().callTool('batch', {
        label: 'Replace text',
        commands: hits.map((n) => ({ command: 'node.set', params: { ids: [n.id], props: { characters: n.characters!.split(find).join(replace) } } })),
      });
      return;
    }
    if (op.command === 'createcraft.addText') {
      const { text, position, size } = op.params as { text: string; position: string; size: number };
      const t = await this.tree(false);
      const page = t.pages?.[(t.currentPage ?? 1) - 1] ?? t.pages?.[0];
      const frame = page?.children?.find((n) => n.type === 'FRAME');
      if (!frame) throw new Error('This design has no frame on the current page to put text in.');
      const h = frame.height ?? 100;
      const y = position === 'top' ? 16 : position === 'bottom' ? Math.max(0, h - size * 1.5 - 16) : Math.max(0, (h - size * 1.2) / 2);
      // Created with its size in one step, so undo removes the whole line.
      await this.client().callTool('run_command', { command: 'node.create', params: { type: 'text', text, parent: frame.id, x: 16, y, props: { fontSize: size } } });
      return;
    }
    await this.client().callTool('run_command', { command: op.command, params: op.params });
  }
  async quickEditSteps(opId: string, values: EditValues): Promise<AppOperation[]> { return figcraftSteps(opId, values); }
  /** Pages, top-level frames and the text on them, so Claude knows what it can replace. */
  async describe() {
    const t = await this.tree(true);
    return {
      pages: (t.pages ?? []).map((p) => ({
        name: p.name,
        frames: (p.children ?? []).map((n) => ({ name: n.name, type: n.type, size: n.width && n.height ? `${n.width}x${n.height}` : undefined })),
        text: LiveFigCraft.texts(p.children).slice(0, 40).map((n) => n.characters!.slice(0, 120)),
      })),
    };
  }
  async history() {
    const t = await this.tree(false);
    return ['Open', ...(t.history?.undo ?? [])];
  }
  async undo() { await this.client().callTool('undo', {}); }
  async writeBaseline(dir: string, base: string) {
    const main = path.join(dir, `${base}.figcraft`);
    await this.client().callTool('save_file', { path: main });
    await waitForFile(main);
    return main;
  }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.figcraft`);
    const preview = path.join(dir, `${base}.png`);
    await this.client().callTool('save_file', { path: main });
    await waitForFile(main);
    const png = imageOf(await this.client().request('tools/call', { name: 'screenshot', arguments: {} }));
    if (png) { await fs.writeFile(preview, png); return { main, preview }; }
    return { main };
  }
  async preview(maxSide: number) {
    return imageOf(await this.client().request('tools/call', { name: 'screenshot', arguments: { maxSize: Math.min(1600, maxSide) } }));
  }
  async screenshot() { return null; }
}

/**
 * CADCraft: `cadcraft --control <port>` (loopback, no token) driven through `cadcraft-cli mcp
 * --connect 127.0.0.1:<port>`. The drawing is opened from the library (DXF or DWG) and never written
 * back; saving writes a new .dxf into the work folder plus a PNG of the drawing (`save` with a .png
 * path exports without renaming the drawing).
 */
export class LiveCadCraft extends LiveAppBase {
  readonly appId = 'cadcraft' as const;
  protected exeName = 'cadcraft';

  protected guiArgs(port: number) { return ['--control', String(port)]; }
  protected guiEnv() { return {}; }
  protected bridgeArgs(port: number) { return ['mcp', '--connect', `127.0.0.1:${port}`]; }
  protected headlessArgs() { return ['mcp']; }

  async open(absPath: string) {
    await this.client().callTool('open', { path: absPath });
    return { name: path.basename(absPath) };
  }
  private exec(command: string, params: Record<string, unknown> = {}) { return this.client().callTool('execute', { command, params }); }
  private async inspect() {
    return (await this.client().callTool('inspect_drawing', {})) as { extents?: [[number, number], [number, number]]; undo?: string[]; counts?: Record<string, number>; layers?: Array<{ name: string }>; currentLayer?: string };
  }

  async run(op: AppOperation) {
    if (op.command === 'find') {
      const r = (await this.exec('find', op.params)) as { total?: number };
      if (!r?.total) {
        await this.exec('undo').catch(() => {}); // the empty search leaves an undo entry
        throw new Error(`"${String(op.params.find)}" was not found in the drawing.`);
      }
      return;
    }
    if (op.command === 'createcraft.addNote') {
      const { text, position } = op.params as { text: string; position: string };
      const ext = (await this.inspect()).extents;
      if (!ext) throw new Error('The drawing is empty, so there is nowhere to put a note.');
      const [[x0, y0], [, y1]] = ext;
      const h = Math.max(y1 - y0, 1);
      const height = Math.round(h * 0.03 * 1000) / 1000 || 0.1;
      const y = position === 'above' ? y1 + h * 0.05 : y0 - h * 0.05 - height;
      await this.exec('text', { at: [x0, y], text, height });
      return;
    }
    await this.exec(op.command, op.params);
  }
  async quickEditSteps(opId: string, values: EditValues): Promise<AppOperation[]> { return cadcraftSteps(opId, values); }
  /** Entity counts, layers, extents and the texts, so Claude knows what it can replace. */
  async describe() {
    const d = await this.inspect();
    const t = (await this.exec('texts', { limit: 40 })) as { texts?: Array<{ text: string }> };
    return {
      entities: d.counts, layers: (d.layers ?? []).map((l) => l.name), currentLayer: d.currentLayer,
      extents: d.extents, text: (t.texts ?? []).map((x) => x.text.slice(0, 120)),
    };
  }
  async history() {
    // The drawing lists its undo steps newest first.
    return ['Open', ...[...((await this.inspect()).undo ?? [])].reverse()];
  }
  async undo() { await this.exec('undo'); }
  async writeBaseline(dir: string, base: string) {
    const main = path.join(dir, `${base}.dxf`);
    await this.client().callTool('save', { path: main });
    await waitForFile(main);
    return main;
  }
  async writeVersion(dir: string, base: string) {
    const main = path.join(dir, `${base}.dxf`);
    const preview = path.join(dir, `${base}.png`);
    await this.client().callTool('save', { path: main });
    await waitForFile(main);
    await this.client().callTool('save', { path: preview });
    await waitForFile(preview);
    return { main, preview };
  }
  async preview(maxSide: number) {
    const size = Math.max(200, Math.min(1600, Math.round(maxSide)));
    return imageOf(await this.client().request('tools/call', { name: 'render', arguments: { width: size, height: Math.round(size * 0.66) } }));
  }
  async screenshot() { return null; }
}

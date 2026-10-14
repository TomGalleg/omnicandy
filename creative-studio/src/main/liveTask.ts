// Runs automated edit steps against a LIVE app document under the collaboration lock.
//
//  - Steps run one at a time; between steps there is a short, visible gap where Pause / Take
//    Control land (the "safe boundary"). A step already in progress always finishes first.
//  - Before every step the document version (its undo history) is compared with what automation
//    last saw. If someone else changed it, automation pauses instead of editing on top.
//  - While you hold control, automation refuses to run. When you hand control back, resuming
//    re-reads the document; if it changed, the remaining steps wait for your explicit go-ahead.
//  - Quick edits (one click, from src/shared/appEditors.ts) run straight in the open app window.
//  - Saving writes the app's files (PhotoCraft .pcraft + .png, VectorCraft .svg + .png, SoundCraft
//    .wav mix) into the app's work folder and registers them as new read-only versions; the opened
//    asset is never overwritten.
//  Works with every live ArtCraft app (see LIVE_APPS); multi-step automation is PhotoCraft-only.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collabReducer, initialCollabState, type CollabEvent, type CollabState } from '@shared/collaboration';
import type { LiveSnapshot, LiveStatus, LiveStep, TimelineDto } from '@shared/live';
import { checkEditValues, EDITOR_APPS, editorFor, type EditorAppId } from '@shared/appEditors';
import { appThemeValue } from '@shared/appTheme';
import type { AppOperation } from '@shared/contracts';
import type { ThemePalette } from '@shared/types';
import { checkPhotoCraftOp, presetLabel } from '@shared/photocraftOps';
import { versionOf, type LiveDoc } from './photocraftLive';
import type { ProjectStore } from './projectStore';

const LIVE_APPS: EditorAppId[] = ['photocraft', 'vectorcraft', 'soundcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'designcraft'];
/** Version name tag per app tab (photo-live1, photo-color1, clip-fx1). */
const TAG: Partial<Record<EditorAppId, string>> = { lightcraft: 'color', effectcraft: 'fx' };
/** Opened as shape layers; flattened on open so pixel adjustments and filters apply. */
const VECTOR = new Set(['svg']);

export interface LiveTaskDeps {
  /** Starts/reuses the app and returns the document API. */
  connect: (app: EditorAppId) => Promise<LiveDoc>;
  store: ProjectStore;
  emit: (s: LiveSnapshot) => void;
  /** Pause between steps so you can see each change and intervene. */
  stepDelayMs?: number;
  writeDir: (app: EditorAppId) => Promise<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveTaskController {
  private status: LiveStatus = 'stopped';
  private error: string | null = null;
  private doc: LiveDoc | null = null;
  private asset: { id: string; name: string } | null = null;
  private parentForNextSave: string | null = null;
  private history: string[] = [];
  private collab: CollabState = initialCollabState;
  private steps: LiveStep[] = [];
  private stepIndex = 0;
  private savedVersionIds: string[] = [];
  private message: string | null = null;
  private looping = false;
  private poppedOut = false;
  /** True while Claude (the Creative Partner) holds the automation side of the lock. */
  private claudeActive = false;
  private appId: EditorAppId = 'photocraft';
  private appTheme: { app: EditorAppId; value: string } | null = null;
  private openedBy: 'user' | 'claude' = 'user';
  private saveCount = 0;

  constructor(private readonly d: LiveTaskDeps) {}

  snapshot(): LiveSnapshot {
    return {
      appId: this.appId,
      status: this.status,
      error: this.error,
      asset: this.asset,
      history: this.history,
      collab: this.collab,
      steps: this.steps,
      stepIndex: this.stepIndex,
      needsReplanConfirm: this.collab.phase === 'planning' && this.stepIndex < this.steps.length,
      savedVersionIds: this.savedVersionIds,
      message: this.message,
      poppedOut: this.poppedOut,
      appTheme: this.appTheme,
      openedBy: this.openedBy,
    };
  }

  private publish() { this.d.emit(this.snapshot()); }

  private dispatch(e: CollabEvent): boolean {
    const r = collabReducer(this.collab, e);
    this.collab = r.state;
    if (!r.ok) this.message = r.reason;
    else if (r.state.lastMessage) this.message = r.state.lastMessage;
    this.publish();
    return r.ok;
  }

  private requireDoc(): LiveDoc {
    if (!this.doc || !this.asset) throw new Error('Open a file in the Edit tab first.');
    return this.doc;
  }

  private async currentVersion(): Promise<string> {
    this.history = await this.requireDoc().history();
    return versionOf(this.history);
  }

  private fail(err: unknown) {
    this.message = err instanceof Error ? err.message : String(err);
    this.publish();
  }

  /** Launches the matching app if needed and opens a library asset in its window (read-only source). */
  async open(assetId: string, appOverride?: EditorAppId, openedBy: 'user' | 'claude' = 'user'): Promise<LiveSnapshot> {
    // Claude handing off to another file/app ends its task on the current one first.
    if (openedBy === 'claude') this.claudeDone();
    if (this.collab.activeOperation || this.collab.phase === 'running' || this.collab.phase === 'pausing') {
      throw new Error('Pause or cancel the running task before opening another document.');
    }
    const a = (await this.d.store.loadManifest()).assets.find((x) => x.id === assetId);
    if (!a) throw new Error('Unknown asset.');
    const appId = appOverride ?? editorFor(a.sourceFormat)?.id;
    if (!appId || !LIVE_APPS.includes(appId)) throw new Error(`No app can open ${a.sourceFormat.toUpperCase()} files live yet.`);
    if (!EDITOR_APPS[appId].formats.includes(a.sourceFormat.toLowerCase())) throw new Error(`${EDITOR_APPS[appId].name} can't open ${a.sourceFormat.toUpperCase()} files.`);
    const appName = EDITOR_APPS[appId].name;
    const abs = await this.d.store.resolveAssetPath(a.id);

    this.status = 'starting';
    this.error = null;
    this.appId = appId;
    this.message = `Starting ${appName}…`;
    this.publish();
    try {
      this.doc = await this.d.connect(appId);
      await this.doc.open(abs);
      if (appId === 'photocraft' && VECTOR.has(a.sourceFormat)) await this.doc.run({ command: 'layer.flattenImage', params: {} });
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.doc = null;
      this.publish();
      throw err;
    }
    this.asset = { id: a.id, name: a.name };
    this.openedBy = openedBy;
    this.parentForNextSave = a.id;
    this.steps = [];
    this.stepIndex = 0;
    this.savedVersionIds = [];
    this.saveCount = 0;
    this.collab = initialCollabState;
    this.collab = { ...this.collab, knownVersion: await this.currentVersion() };
    this.message = `${a.name} is open in ${appName}${appId === 'photocraft' && VECTOR.has(a.sourceFormat) ? ' (vector shapes flattened to pixels so adjustments apply)' : ''}. Your library file stays as it is; save to create a new version.`;
    this.publish();
    return this.snapshot();
  }

  /** Plans and starts running `steps` live. */
  async run(steps: Array<{ command: string; params: Record<string, unknown> }>): Promise<LiveSnapshot> {
    this.requireDoc();
    if (this.appId !== 'photocraft') throw new Error('Multi-step automation is available for PhotoCraft only.');
    if (!steps.length) throw new Error('Add at least one step.');
    if (!['idle', 'completed', 'cancelled', 'failed'].includes(this.collab.phase)) {
      throw new Error('A task is already in progress. Cancel it first.');
    }
    const checked: LiveStep[] = steps.map((s) => {
      const r = checkPhotoCraftOp(s.command, s.params);
      if (!r.ok) throw new Error(r.reason);
      return { command: s.command, params: r.params, label: presetLabel(s.command) };
    });
    this.steps = checked;
    this.stepIndex = 0;
    this.dispatch({ type: 'plan' });
    this.dispatch({ type: 'planReady', version: await this.currentVersion() });
    this.dispatch({ type: 'start' });
    this.message = `Running ${checked.length} step(s) in PhotoCraft: ${checked.map((s) => s.label).join(' → ')}.`;
    this.publish();
    void this.loop();
    return this.snapshot();
  }

  private async loop() {
    if (this.looping) return;
    this.looping = true;
    try {
      while (this.collab.phase === 'running' && this.stepIndex < this.steps.length) {
        const doc = this.requireDoc();
        const before = await this.currentVersion();
        if (before !== this.collab.knownVersion) {
          this.dispatch({ type: 'requestPause' });
          this.message = 'PhotoCraft shows a change automation did not make, so it paused instead of editing on top. Take a look, then Resume.';
          this.publish();
          break;
        }
        const step = this.steps[this.stepIndex]!;
        const opId = `step-${this.stepIndex}-${randomUUID().slice(0, 6)}`;
        if (!this.dispatch({ type: 'beginOperation', opId })) break;
        try {
          await doc.run({ command: step.command, params: step.params });
          this.stepIndex++;
          this.dispatch({ type: 'endOperation', opId, ok: true, version: await this.currentVersion() });
        } catch (err) {
          this.dispatch({ type: 'endOperation', opId, ok: false });
          this.fail(new Error(`${step.label} failed: ${err instanceof Error ? err.message : String(err)}`));
          break;
        }
        if (this.stepIndex < this.steps.length) await sleep(this.d.stepDelayMs ?? 1200);
      }
      if (this.collab.phase === 'running' && this.stepIndex >= this.steps.length && !this.collab.activeOperation) {
        this.dispatch({ type: 'complete' });
        this.message = `Done: ${this.steps.length} step(s) applied in PhotoCraft. Save to keep them as a new version.`;
        this.publish();
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.looping = false;
    }
  }

  pause() { this.dispatch({ type: 'requestPause' }); return this.snapshot(); }

  takeControl() {
    this.requireDoc();
    // With no task, taking control is a no-op lock grab so automation can't start under you.
    this.dispatch({ type: 'takeControl' });
    return this.snapshot();
  }

  releaseControl() { this.dispatch({ type: 'releaseControl' }); return this.snapshot(); }

  async resume(): Promise<LiveSnapshot> {
    const v = await this.currentVersion();
    if (this.dispatch({ type: 'resume', diskVersion: v }) && this.collab.phase === 'running') void this.loop();
    if (this.collab.phase === 'planning' && this.stepIndex >= this.steps.length) {
      // Nothing left to run: accept the changed document as the new baseline and finish.
      this.dispatch({ type: 'planReady', version: v });
      if (this.dispatch({ type: 'start' })) void this.loop();
      return this.snapshot();
    }
    if (this.collab.phase === 'planning') {
      this.message = `The document changed (${this.history.at(-1) ?? 'edited'}). Continue the remaining ${this.steps.length - this.stepIndex} step(s) on top of it?`;
      this.publish();
    }
    return this.snapshot();
  }

  /** Go-ahead after a replan: continue remaining steps on the changed document. */
  async confirmReplan(): Promise<LiveSnapshot> {
    if (this.collab.phase !== 'planning') throw new Error('Nothing to confirm.');
    this.dispatch({ type: 'planReady', version: await this.currentVersion() });
    if (this.dispatch({ type: 'start' })) void this.loop();
    return this.snapshot();
  }

  cancel() {
    if (this.collab.phase === 'manual') this.dispatch({ type: 'releaseControl' });
    this.dispatch({ type: 'cancel' });
    return this.snapshot();
  }

  /** Saves the live document as new .pcraft + .png versions in the library. */
  async saveVersion(): Promise<LiveSnapshot> {
    const doc = this.requireDoc();
    if (this.collab.activeOperation) throw new Error('Wait for the current step to finish.');
    const dir = await this.d.writeDir(this.appId);
    const files = await doc.writeVersion(dir, randomUUID().slice(0, 8));
    const appName = EDITOR_APPS[this.appId].name;
    const tag = TAG[this.appId] ?? 'live';
    const base = this.asset!.name.replace(/\.[^.]+$/, '').replace(/-(live|color|fx)\d*$/, '');
    const n = this.saveCount + 1;
    const steps = this.history.slice(1).join(' → ') || 'no edits';
    const mainExt = path.extname(files.main).slice(1);
    const known = new Set((await this.d.store.loadManifest()).assets.map((x) => x.id));
    const main = await this.d.store.addDerivedFile(files.main, {
      name: `${base}-${tag}${n}.${mainExt}`,
      parentId: this.parentForNextSave ?? this.asset!.id,
      provenance: { origin: 'generated', source: `Saved from the live ${appName} window. History: ${steps}` },
    });
    if (known.has(main.id)) {
      // Byte-identical to a file already in the library: nothing new to keep.
      if (files.preview) await fs.rm(files.preview, { force: true });
      this.message = `Nothing changed since ${main.name}, so no new version was made.`;
      this.publish();
      return this.snapshot();
    }
    const saved = [main.id];
    if (files.preview) {
      const png = await this.d.store.addDerivedFile(files.preview, {
        name: `${base}-${tag}${n}.png`,
        parentId: main.id,
        provenance: { origin: 'generated', source: `PNG export of ${main.name} from the live ${appName} window` },
      });
      saved.push(png.id);
    }
    this.saveCount = n;
    this.parentForNextSave = main.id;
    this.savedVersionIds = [...this.savedVersionIds, ...saved];
    const v = await this.currentVersion();
    this.dispatch({ type: 'syncVersion', version: v }); // refused (harmlessly) if a manual edit is pending
    this.message = `Saved ${main.name}${saved.length > 1 ? ' (+ PNG preview)' : ''} to the library.`;
    this.publish();
    return this.snapshot();
  }

  /** One-click edit from the Edit tab, applied straight in the open app window. */
  async quickEdit(opId: string, rawValues: Record<string, unknown>): Promise<LiveSnapshot> {
    const doc = this.requireDoc();
    if (this.collab.activeOperation || ['running', 'pausing'].includes(this.collab.phase)) {
      throw new Error('An automation task is running. Pause or cancel it first.');
    }
    const app = EDITOR_APPS[this.appId];
    const op = app.quickEdits.find((o) => o.id === opId);
    if (!op) throw new Error(`${app.name} has no quick edit "${opId}".`);
    if (op.copyOnly) throw new Error(`${op.label} makes a new file; use it from "Make a copy".`);
    const check = checkEditValues(op, rawValues);
    if (!check.ok) throw new Error(check.reason);
    if (!doc.quickEditSteps) throw new Error(`${app.name} can't apply quick edits live.`);
    const steps = await doc.quickEditSteps(op.id, check.values);
    if (this.appId === 'photocraft') {
      for (const s of steps) { const c = checkPhotoCraftOp(s.command, s.params); if (!c.ok) throw new Error(c.reason); }
    }
    for (const s of steps) await doc.run(s);
    const v = await this.currentVersion();
    if (this.collab.phase !== 'manual' && !this.collab.needsSync) this.dispatch({ type: 'syncVersion', version: v });
    this.message = `${op.label} applied in ${app.name}. Save to keep it as a new version.`;
    this.publish();
    return this.snapshot();
  }

  async undo(): Promise<LiveSnapshot> {
    const doc = this.requireDoc();
    if (this.collab.activeOperation || ['running', 'pausing'].includes(this.collab.phase)) throw new Error('Wait for the running task to pause first.');
    if (!doc.undo) throw new Error('Undo is not available.');
    await doc.undo();
    const v = await this.currentVersion();
    if (this.collab.phase !== 'manual' && !this.collab.needsSync) this.dispatch({ type: 'syncVersion', version: v });
    this.message = 'Undone.';
    this.publish();
    return this.snapshot();
  }

  // ---- Claude (Creative Partner) actions: same lock, allowlist and versioning as everything else ----

  /** Called before each Claude tool call that changes the document. Throws a plain reason when Claude must not act. */
  private async claudeGate(): Promise<LiveDoc> {
    const doc = this.requireDoc();
    const p = this.collab.phase;
    if (p === 'manual') throw new Error('The user has taken control of the document. Stop and wait; do not retry.');
    if (p === 'pausing' || p === 'paused') throw new Error('The user paused you. Stop and wait for them to resume; do not retry.');
    if (this.looping || (p === 'running' && !this.claudeActive)) throw new Error('An automation task is running in the app. Wait for it to finish.');
    if (p === 'awaiting_approval') throw new Error('Waiting for the user to approve.');
    if (p !== 'running') {
      // Start a Claude task: plan -> ready -> running with the lock held by automation.
      this.dispatch({ type: 'plan' });
      this.dispatch({ type: 'planReady', version: await this.currentVersion() });
      if (!this.dispatch({ type: 'start' })) throw new Error(this.message ?? 'Could not start.');
      this.claudeActive = true;
      this.steps = [];
      this.stepIndex = 0;
    }
    // Someone edited by hand without taking control: don't edit on top of it.
    const v = await this.currentVersion();
    if (v !== this.collab.knownVersion) {
      this.dispatch({ type: 'requestPause' });
      this.message = 'The document changed in the app outside of Claude, so Claude paused. Resume when ready.';
      this.publish();
      throw new Error('The user changed the document by hand, so you were paused. Stop and wait.');
    }
    return doc;
  }

  private async claudeRun(label: string, steps: AppOperation[]): Promise<string> {
    const doc = await this.claudeGate();
    const opId = `claude-${randomUUID().slice(0, 6)}`;
    if (!this.dispatch({ type: 'beginOperation', opId })) throw new Error(this.message ?? 'Could not start the edit.');
    try {
      for (const s of steps) await doc.run(s);
    } catch (err) {
      this.dispatch({ type: 'endOperation', opId, ok: false });
      this.claudeActive = false;
      throw err;
    }
    this.dispatch({ type: 'endOperation', opId, ok: true, version: await this.currentVersion() });
    this.message = `Claude: ${label}`;
    this.publish();
    const p = this.collab.phase;
    return p === 'running' ? `${label} applied.` : `${label} applied. The user has now ${p === 'manual' ? 'taken control' : 'paused you'}; stop and wait.`;
  }

  /** Claude applies one of the app's quick edits (src/shared/appEditors.ts). */
  async claudeQuickEdit(opId: string, rawValues: Record<string, unknown>): Promise<string> {
    const doc = this.requireDoc();
    const app = EDITOR_APPS[this.appId];
    const op = app.quickEdits.find((o) => o.id === opId);
    if (!op || op.copyOnly) throw new Error(`${app.name} has no live edit "${opId}". Use get_status to see the available edits.`);
    const check = checkEditValues(op, rawValues);
    if (!check.ok) throw new Error(check.reason);
    if (!doc.quickEditSteps) throw new Error(`${app.name} can't apply edits live.`);
    const steps = await doc.quickEditSteps(op.id, check.values);
    if (this.appId === 'photocraft') for (const s of steps) { const c = checkPhotoCraftOp(s.command, s.params); if (!c.ok) throw new Error(c.reason); }
    return this.claudeRun(`${op.label} (${app.name})`, steps);
  }

  /** Claude runs one allowlisted PhotoCraft engine command (adjustments, filters, rotations, fill). */
  async claudePhotoCraftCommand(command: string, params: Record<string, unknown>): Promise<string> {
    if (this.appId !== 'photocraft') throw new Error('Engine commands are only available while PhotoCraft is open.');
    const c = checkPhotoCraftOp(command, params);
    if (!c.ok) throw new Error(c.reason);
    return this.claudeRun(`${presetLabel(command)} (PhotoCraft)`, [{ command, params: c.params }]);
  }

  async claudeUndo(): Promise<string> {
    const doc = await this.claudeGate();
    if (!doc.undo) throw new Error('Undo is not available.');
    const opId = `claude-undo-${randomUUID().slice(0, 6)}`;
    this.dispatch({ type: 'beginOperation', opId });
    await doc.undo();
    this.dispatch({ type: 'endOperation', opId, ok: true, version: await this.currentVersion() });
    return 'Undone.';
  }

  /** A picture of the open document, for Claude to look at. */
  async preview(maxSide: number): Promise<Buffer | null> {
    const doc = this.requireDoc();
    return doc.preview ? doc.preview(maxSide) : doc.screenshot ? doc.screenshot(maxSide) : null;
  }

  /** Claude's turn is over: finish its task (unless the user paused or took control). */
  claudeDone() {
    if (!this.claudeActive) return;
    this.claudeActive = false;
    if (this.collab.phase === 'running' && !this.collab.activeOperation) this.dispatch({ type: 'complete' });
  }

  /** What Claude needs to know about the current state. */
  async statusForClaude() {
    const app = EDITOR_APPS[this.appId];
    const ready = this.status === 'ready' && !!this.asset && !!this.doc;
    const details = ready && this.doc!.describe ? await this.doc!.describe().catch(() => undefined) : undefined;
    return {
      open: this.asset ? { file: this.asset.name, app: app.name, tab: app.tab, ...(details ? { details } : {}) } : null,
      // Every app a file can be handed to with open_file (app id, CreateCraft tab, file types).
      apps: LIVE_APPS.map((id) => ({ app: id, name: EDITOR_APPS[id].name, tab: EDITOR_APPS[id].tab, for: EDITOR_APPS[id].blurb, fileTypes: EDITOR_APPS[id].formats })),
      history: this.history,
      lock: this.collab.lockOwner === 'user' ? 'the user has control (do not edit)' : this.collab.phase === 'paused' || this.collab.phase === 'pausing' ? 'paused by the user (do not edit)' : 'free',
      edits: this.asset ? app.quickEdits.filter((o) => !o.copyOnly).map((o) => ({
        id: o.id, label: o.label, group: o.group,
        settings: o.params.map((p) => p.type === 'number'
          ? { key: p.key, label: p.label, min: p.min, max: p.max, default: p.default, unit: p.unit }
          : p.type === 'text'
            ? { key: p.key, label: p.label, text: true, maxLength: p.maxLength, default: p.default }
            : { key: p.key, label: p.label, choices: p.options.map((x) => x.value), default: p.default }),
      })) : [],
    };
  }

  /**
   * Matches the open app's interface theme to CreateCraft's (official app control only). Never
   * touches the document: it changes the app's chrome, not the artwork or its history.
   */
  async applyAppTheme(palette: ThemePalette): Promise<void> {
    const doc = this.doc;
    const value = appThemeValue(this.appId, palette);
    if (!doc?.applyTheme || !value || this.status !== 'ready') return;
    try {
      const now = await doc.applyTheme(value);
      this.appTheme = { app: this.appId, value: now ?? value };
    } catch {
      this.appTheme = null; // app left as it was
    }
    this.publish();
  }

  setPoppedOut(v: boolean) { this.poppedOut = v; this.publish(); }

  /** The open video's timeline (FilmCraft); null for apps without one. */
  async timeline(): Promise<TimelineDto | null> {
    if (!this.doc?.timeline || !this.asset || this.status !== 'ready') return null;
    return this.doc.timeline();
  }

  /** Moves the playhead / selects a clip in the app's timeline (no change to the document). */
  async setPlayhead(seconds: number): Promise<void> {
    const doc = this.requireDoc();
    if (!doc.setPlayhead) throw new Error('This app has no timeline.');
    await doc.setPlayhead(seconds);
  }
  async selectClip(clipId: number): Promise<void> {
    const doc = this.requireDoc();
    if (!doc.selectClip) throw new Error('This app has no timeline.');
    await doc.selectClip(clipId);
  }

  /** Re-reads the document history (e.g. after you edit by hand). */
  async refresh(): Promise<LiveSnapshot> {
    if (this.doc && this.asset) {
      try { await this.currentVersion(); } catch (err) { this.status = 'error'; this.error = err instanceof Error ? err.message : String(err); }
    }
    this.publish();
    return this.snapshot();
  }
}

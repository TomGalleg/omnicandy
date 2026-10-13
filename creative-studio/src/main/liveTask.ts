// Runs automated edit steps against a LIVE app document under the collaboration lock.
//
//  - Steps run one at a time; between steps there is a short, visible gap where Pause / Take
//    Control land (the "safe boundary"). A step already in progress always finishes first.
//  - Before every step the document version (its undo history) is compared with what automation
//    last saw. If someone else changed it, automation pauses instead of editing on top.
//  - While you hold control, automation refuses to run. When you hand control back, resuming
//    re-reads the document; if it changed, the remaining steps wait for your explicit go-ahead.
//  - Saving writes a .pcraft + .png into work/live (PhotoCraft's only write root) and registers
//    them as new read-only versions; the opened asset is never overwritten.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { collabReducer, initialCollabState, type CollabEvent, type CollabState } from '@shared/collaboration';
import type { LiveSnapshot, LiveStatus, LiveStep } from '@shared/live';
import { checkPhotoCraftOp, presetLabel } from '@shared/photocraftOps';
import { versionOf, type LiveDoc } from './photocraftLive';
import type { ProjectStore } from './projectStore';

const OPENABLE = new Set(['pcraft', 'psd', 'psb', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'bmp', 'gif', 'exr', 'tga', 'svg']);
/** Opened as shape layers; flattened on open so pixel adjustments and filters apply. */
const VECTOR = new Set(['svg']);

export interface LiveTaskDeps {
  /** Starts/reuses the app and returns the document API. */
  connect: () => Promise<LiveDoc>;
  store: ProjectStore;
  emit: (s: LiveSnapshot) => void;
  /** Pause between steps so you can see each change and intervene. */
  stepDelayMs?: number;
  writeDir: () => Promise<string>;
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

  constructor(private readonly d: LiveTaskDeps) {}

  snapshot(): LiveSnapshot {
    return {
      appId: 'photocraft',
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
    if (!this.doc || !this.asset) throw new Error('Open an asset in PhotoCraft first.');
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

  /** Launches PhotoCraft if needed and opens a library asset in its window (read-only source). */
  async open(assetId: string): Promise<LiveSnapshot> {
    if (this.collab.activeOperation || this.collab.phase === 'running' || this.collab.phase === 'pausing') {
      throw new Error('Pause or cancel the running task before opening another document.');
    }
    const a = (await this.d.store.loadManifest()).assets.find((x) => x.id === assetId);
    if (!a) throw new Error('Unknown asset.');
    if (!OPENABLE.has(a.sourceFormat)) throw new Error(`PhotoCraft can't open ${a.sourceFormat.toUpperCase()} files.`);
    const abs = await this.d.store.resolveAssetPath(a.id);

    this.status = 'starting';
    this.error = null;
    this.message = 'Starting PhotoCraft…';
    this.publish();
    try {
      this.doc = await this.d.connect();
      await this.doc.open(abs);
      if (VECTOR.has(a.sourceFormat)) await this.doc.run({ command: 'layer.flattenImage', params: {} });
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.doc = null;
      this.publish();
      throw err;
    }
    this.asset = { id: a.id, name: a.name };
    this.parentForNextSave = a.id;
    this.steps = [];
    this.stepIndex = 0;
    this.savedVersionIds = [];
    this.collab = initialCollabState;
    this.collab = { ...this.collab, knownVersion: await this.currentVersion() };
    this.message = `${a.name} is open in PhotoCraft${VECTOR.has(a.sourceFormat) ? ' (vector shapes flattened to pixels so adjustments apply)' : ''}. Your library file is read-only; save to create a new version.`;
    this.publish();
    return this.snapshot();
  }

  /** Plans and starts running `steps` live. */
  async run(steps: Array<{ command: string; params: Record<string, unknown> }>): Promise<LiveSnapshot> {
    this.requireDoc();
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
    const dir = await this.d.writeDir();
    const tmp = randomUUID().slice(0, 8);
    const docPath = path.join(dir, `${tmp}.pcraft`);
    const pngPath = path.join(dir, `${tmp}.png`);
    await doc.saveNative(docPath);
    await doc.exportPng(pngPath);
    const base = this.asset!.name.replace(/\.[^.]+$/, '').replace(/-live\d*$/, '');
    const n = this.savedVersionIds.length / 2 + 1;
    const steps = this.history.slice(1).join(' → ') || 'no edits';
    const pcraft = await this.d.store.addDerivedFile(docPath, {
      name: `${base}-live${n}.pcraft`,
      parentId: this.parentForNextSave ?? this.asset!.id,
      provenance: { origin: 'generated', source: `Saved from the live PhotoCraft window. History: ${steps}` },
    });
    const png = await this.d.store.addDerivedFile(pngPath, {
      name: `${base}-live${n}.png`,
      parentId: pcraft.id,
      provenance: { origin: 'generated', source: `PNG export of ${pcraft.name} from the live PhotoCraft window` },
    });
    this.parentForNextSave = pcraft.id;
    this.savedVersionIds = [...this.savedVersionIds, pcraft.id, png.id];
    const v = await this.currentVersion();
    this.dispatch({ type: 'syncVersion', version: v }); // refused (harmlessly) if a manual edit is pending
    this.message = `Saved ${pcraft.name} and ${png.name} to the library.`;
    this.publish();
    return this.snapshot();
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

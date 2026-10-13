// Live PhotoCraft UI pieces shared by the main window (Edit workspace, right panel) and the
// pop-out panel docked next to the PhotoCraft window.

import { useEffect, useState } from 'react';
import { PHASE_LABEL } from '@shared/collaboration';
import { checkPhotoCraftOp, PHOTOCRAFT_PRESETS } from '@shared/photocraftOps';
import type { LiveApi } from '../../useLive';

interface DraftStep { command: string; params: string }

const presetStep = (id: string): DraftStep => {
  const p = PHOTOCRAFT_PRESETS.find((x) => x.id === id)!;
  return { command: p.id, params: JSON.stringify(p.params) };
};
const DEFAULT_STEPS = [
  presetStep('image.adjustments.photoFilter'),
  presetStep('image.adjustments.vibrance'),
  presetStep('filter.sharpen.unsharpMask'),
];
const DRAFT_KEY = 'cs-live-steps';

/** Step draft shared between the main window and the pop-out panel (same origin → same storage). */
function useSharedSteps(): [DraftStep[], (f: (s: DraftStep[]) => DraftStep[]) => void] {
  const read = (): DraftStep[] => {
    try {
      const v = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
      return Array.isArray(v) && v.every((x) => typeof x?.command === 'string' && typeof x?.params === 'string') ? v : DEFAULT_STEPS;
    } catch { return DEFAULT_STEPS; }
  };
  const [steps, setSteps] = useState<DraftStep[]>(read);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === DRAFT_KEY) setSteps(read()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const update = (f: (s: DraftStep[]) => DraftStep[]) => setSteps((s) => {
    const next = f(s);
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(next)); } catch { /* storage unavailable: keep in memory */ }
    return next;
  });
  return [steps, update];
}

export function isTaskActive(phase: string) {
  return ['planning', 'ready', 'running', 'pausing', 'paused', 'manual', 'awaiting_approval'].includes(phase);
}

export function LiveSteps({ liveApi, compact }: { liveApi: LiveApi; compact?: boolean }) {
  const { live, busy, act } = liveApi;
  const [steps, setSteps] = useSharedSteps();
  const taskActive = isTaskActive(live?.collab.phase ?? 'idle');
  const checks = steps.map((s) => checkPhotoCraftOp(s.command, s.params));
  const stepsValid = checks.every((c) => c.ok);

  return (
    <section className={`panel-card${compact ? ' compact' : ''}`}>
      <h2 style={{ fontSize: 14 }}>Automation steps</h2>
      {!compact && <p className="asset-meta">Applied one at a time in the PhotoCraft window, with a short pause between steps. Use <strong>Pause</strong> or <strong>Take Control</strong> at any time.</p>}
      {steps.map((s, i) => (
        <div className={`live-step${compact ? ' compact' : ''}`} key={i}>
          <span className="live-step-n">{i + 1}</span>
          <select value={PHOTOCRAFT_PRESETS.some((p) => p.id === s.command) ? s.command : ''} disabled={taskActive} aria-label={`Step ${i + 1} operation`}
            onChange={(e) => setSteps((all) => all.map((x, j) => (j === i ? presetStep(e.target.value) : x)))}>
            {PHOTOCRAFT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <input className="mono" value={s.params} disabled={taskActive} spellCheck={false} aria-label={`Step ${i + 1} parameters`}
            onChange={(e) => { const v = e.target.value; setSteps((all) => all.map((x, j) => (j === i ? { ...x, params: v } : x))); }} />
          <button className="btn small ghost" aria-label={`Remove step ${i + 1}`} disabled={taskActive || steps.length === 1}
            onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>✕</button>
          {!checks[i]!.ok && <small className="wf-msg error live-step-err">{(checks[i] as { reason: string }).reason}</small>}
          {live && live.steps.length > 0 && taskActive && (
            <small className="asset-meta live-step-err">{i < live.stepIndex ? '✓ applied' : i === live.stepIndex ? (live.collab.activeOperation ? '● applying…' : 'next') : ''}</small>
          )}
        </div>
      ))}
      <div className="btn-row">
        <button className="btn small" disabled={taskActive || steps.length >= 12} onClick={() => setSteps((all) => [...all, presetStep('image.adjustments.hueSaturation')])}>+ Add step</button>
        <span className="spacer" />
        <button className="btn small primary" disabled={busy || taskActive || !stepsValid || live?.status !== 'ready'}
          onClick={() => void act('Run steps', () => window.studio.live.run(steps.map((s, i) => ({ command: s.command, params: (checks[i] as { params: Record<string, unknown> }).params }))))}>
          Run {steps.length} step{steps.length > 1 ? 's' : ''} in PhotoCraft
        </button>
      </div>
    </section>
  );
}

export function LiveDocument({ liveApi, onSaved, compact }: { liveApi: LiveApi; onSaved?: () => void; compact?: boolean }) {
  const { live, busy, act } = liveApi;
  if (!live?.asset) return null;
  return (
    <section className={`panel-card${compact ? ' compact' : ''}`}>
      <h2 style={{ fontSize: 14 }}>Document</h2>
      <div className="asset-meta">History in PhotoCraft (includes your own edits):</div>
      <ol className="live-history">
        {live.history.map((h, i) => <li key={i}>{h}</li>)}
      </ol>
      <div className="btn-row">
        <button className="btn small primary" disabled={busy || !!live.collab.activeOperation}
          onClick={() => void act('Save version', async () => { const s = await window.studio.live.saveVersion(); onSaved?.(); return s; })}>
          Save as new version
        </button>
      </div>
      {live.savedVersionIds.length > 0 && <small className="asset-meta">{live.savedVersionIds.length / 2} version(s) saved to the library this session.</small>}
    </section>
  );
}

export function TaskControls({ liveApi }: { liveApi: LiveApi }) {
  const { live, busy, act } = liveApi;
  const L = window.studio.live;
  const open = live?.status === 'ready' && !!live.asset;
  if (!open) return <div className="asset-meta">No live document. Open an image from <strong>Edit</strong> to run steps in PhotoCraft.</div>;
  const p = live!.collab.phase;
  const total = live!.steps.length;
  return (
    <>
      <div className="phase"><span className={`phase-dot ${p}`} />{PHASE_LABEL[p]}
        {live!.collab.activeOperation && <span className="asset-meta"> · {live!.steps[live!.stepIndex]?.label ?? ''}</span>}
      </div>
      <div className="asset-meta">
        Edit lock: {live!.collab.lockOwner === 'user' ? 'you' : live!.collab.lockOwner === 'claude' ? 'automation' : 'free'}
        {total > 0 && <> · Step {Math.min(live!.stepIndex, total)}/{total}</>}
      </div>
      <div className="btn-row">
        {p === 'running' && <button className="btn small" disabled={busy} onClick={() => void act('Pause', L.pause)}>Pause</button>}
        {p !== 'manual' && p !== 'pausing' && <button className="btn small" disabled={busy} onClick={() => void act('Take control', L.takeControl)}>Take Control</button>}
        {p === 'manual' && <button className="btn small primary" disabled={busy} onClick={() => void act('Hand back control', L.releaseControl)}>I'm done, hand back</button>}
        {p === 'paused' && <button className="btn small primary" disabled={busy} onClick={() => void act('Resume', L.resume)}>Resume</button>}
        {live!.needsReplanConfirm && <button className="btn small primary" disabled={busy} onClick={() => void act('Continue', L.confirmReplan)}>Continue on changed document</button>}
        {['running', 'pausing', 'paused', 'planning', 'ready'].includes(p) && <button className="btn small danger" disabled={busy} onClick={() => void act('Cancel', L.cancel)}>Cancel task</button>}
      </div>
      {p === 'manual' && <div className="notice">You have control. Edit freely in the PhotoCraft window; automation won't touch the document until you hand it back.</div>}
      {live!.message && p !== 'manual' && <div className="asset-meta">{live!.message}</div>}
    </>
  );
}

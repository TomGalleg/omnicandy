import { useState } from 'react';
import { PHASE_LABEL } from '@shared/collaboration';
import { checkPhotoCraftOp, PHOTOCRAFT_PRESETS } from '@shared/photocraftOps';
import type { Asset } from '@shared/types';
import type { LiveApi } from '../useLive';

const OPENABLE = new Set(['pcraft', 'psd', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'bmp', 'gif', 'svg']);

interface DraftStep { command: string; params: string }

const presetStep = (id: string): DraftStep => {
  const p = PHOTOCRAFT_PRESETS.find((x) => x.id === id)!;
  return { command: p.id, params: JSON.stringify(p.params) };
};

/** Edit workspace: drive the real PhotoCraft window. Task controls (pause / take control) live in the right panel. */
export function LivePanel({ selected, liveApi, onProjectChanged }: { selected: Asset | null; liveApi: LiveApi; onProjectChanged: () => void }) {
  const { live, busy, act } = liveApi;
  const [steps, setSteps] = useState<DraftStep[]>([
    presetStep('image.adjustments.photoFilter'),
    presetStep('image.adjustments.vibrance'),
    presetStep('filter.sharpen.unsharpMask'),
  ]);

  const openable = !!selected && OPENABLE.has(selected.sourceFormat);
  const isOpen = live?.status === 'ready' && !!live.asset;
  const phase = live?.collab.phase ?? 'idle';
  const taskActive = ['planning', 'ready', 'running', 'pausing', 'paused', 'manual', 'awaiting_approval'].includes(phase);
  const checks = steps.map((s) => checkPhotoCraftOp(s.command, s.params));
  const stepsValid = checks.every((c) => c.ok);

  return (
    <div className="live">
      <div className="live-bar">
        <span className={`chip ${isOpen ? 'real' : live?.status === 'error' ? 'warn' : 'off'}`}>
          <span className="dot" />
          {live?.status === 'starting' ? 'Starting PhotoCraft…' : isOpen ? `PhotoCraft live · ${live!.asset!.name}` : live?.status === 'error' ? 'PhotoCraft: error' : 'PhotoCraft live: not started'}
        </span>
        {isOpen && <span className="chip">{PHASE_LABEL[phase]}{live!.collab.lockOwner ? ` · lock: ${live!.collab.lockOwner === 'user' ? 'you' : 'automation'}` : ''}</span>}
        <span className="spacer" />
        <button className="btn small" disabled={!openable || busy || taskActive}
          title={!selected ? 'Select an image in the media browser' : !openable ? `${selected.sourceFormat.toUpperCase()} can't be opened in PhotoCraft` : ''}
          onClick={() => void act('Open in PhotoCraft', () => window.studio.live.open(selected!.id))}>
          {isOpen && live!.asset!.id === selected?.id ? 'Re-open in PhotoCraft' : `Open ${selected ? selected.name : 'selection'} in PhotoCraft`}
        </button>
      </div>

      {live?.status === 'error' && <div className="notice" role="alert">{live.error}</div>}

      {!isOpen ? (
        <div className="empty-state">
          <div className="empty-card">
            <h2>Edit in the real PhotoCraft window</h2>
            <p>Select an image on the left, then press <strong>Open … in PhotoCraft</strong>. PhotoCraft opens in its own window. Creative Studio drives it over a token-protected local connection and can only read your project and write to its <span className="mono">work/live</span> folder.</p>
            <p>Your library file is never changed. Use <strong>Save as new version</strong> to keep results.</p>
            <p className="asset-meta">Showing the PhotoCraft window inside this app is the next step. For now, arrange the two windows side by side.</p>
          </div>
        </div>
      ) : (
        <div className="live-grid">
          <section className="panel-card">
            <h2 style={{ fontSize: 14 }}>Automation steps</h2>
            <p className="asset-meta">Applied one at a time in the PhotoCraft window, with a short pause between steps. Use <strong>Pause</strong> or <strong>Take Control</strong> in the right panel at any time.</p>
            {steps.map((s, i) => (
              <div className="live-step" key={i}>
                <span className="live-step-n">{i + 1}</span>
                <select value={PHOTOCRAFT_PRESETS.some((p) => p.id === s.command) ? s.command : ''} disabled={taskActive}
                  onChange={(e) => setSteps((all) => all.map((x, j) => (j === i ? presetStep(e.target.value) : x)))}>
                  {PHOTOCRAFT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <input className="mono" value={s.params} disabled={taskActive} spellCheck={false} aria-label={`Step ${i + 1} parameters`}
                  onChange={(e) => setSteps((all) => all.map((x, j) => (j === i ? { ...x, params: e.target.value } : x)))} />
                <button className="btn small ghost" aria-label={`Remove step ${i + 1}`} disabled={taskActive || steps.length === 1}
                  onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>✕</button>
                {!checks[i]!.ok && <small className="wf-msg error live-step-err">{(checks[i] as { reason: string }).reason}</small>}
                {live!.steps.length > 0 && taskActive && (
                  <small className="asset-meta live-step-err">{i < live!.stepIndex ? '✓ applied' : i === live!.stepIndex ? (live!.collab.activeOperation ? '● applying…' : 'next') : ''}</small>
                )}
              </div>
            ))}
            <div className="btn-row">
              <button className="btn small" disabled={taskActive || steps.length >= 12} onClick={() => setSteps((all) => [...all, presetStep('image.adjustments.hueSaturation')])}>+ Add step</button>
              <span className="spacer" />
              <button className="btn small primary" disabled={busy || taskActive || !stepsValid}
                onClick={() => void act('Run steps', () => window.studio.live.run(steps.map((s, i) => ({ command: s.command, params: (checks[i] as { params: Record<string, unknown> }).params }))))}>
                Run {steps.length} step{steps.length > 1 ? 's' : ''} in PhotoCraft
              </button>
            </div>
          </section>

          <section className="panel-card">
            <h2 style={{ fontSize: 14 }}>Document</h2>
            <div className="asset-meta">History in PhotoCraft (includes your own edits):</div>
            <ol className="live-history">
              {live!.history.map((h, i) => <li key={i}>{h}</li>)}
            </ol>
            <div className="btn-row">
              <button className="btn small primary" disabled={busy || !!live!.collab.activeOperation}
                onClick={() => void act('Save version', async () => { const s = await window.studio.live.saveVersion(); onProjectChanged(); return s; })}>
                Save as new version
              </button>
            </div>
            {live!.savedVersionIds.length > 0 && <small className="asset-meta">{live!.savedVersionIds.length / 2} version(s) saved to the library this session.</small>}
            {live!.message && <small className="asset-meta">{live!.message}</small>}
          </section>
        </div>
      )}
    </div>
  );
}

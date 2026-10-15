import { useState } from 'react';
import { MOTION_ASPECTS, MOTION_FORMATS, MOTION_FPS, MOTION_INTENSITIES, MOTION_MAX_SECONDS, MOTION_MIN_SECONDS, MOTION_PRESETS, MOTION_RESOLUTIONS, type MotionJob } from '@shared/motionEffects';
import type { Asset, WorkspaceId } from '@shared/types';

interface Props {
  selected: Asset | null;
  onGoto: (w: WorkspaceId, assetId?: string) => void;
  log: (source: string, msg: string) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Free Motion Effects: a camera move on one picture, rendered by FilmCraft. Not AI, no key, no cost. */
export function MotionPanel({ selected, onGoto, log }: Props) {
  const [preset, setPreset] = useState<MotionJob['preset']>('zoom-in');
  const [intensity, setIntensity] = useState<MotionJob['intensity']>('medium');
  const [aspect, setAspect] = useState<MotionJob['aspectRatio']>('16:9');
  const [resolution, setResolution] = useState<MotionJob['resolution']>('720p');
  const [fps, setFps] = useState<MotionJob['fps']>(24);
  const [seconds, setSeconds] = useState(6);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ assetId: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const usable = !!selected && MOTION_FORMATS.includes(selected.sourceFormat);

  const make = async () => {
    if (!selected) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const r = await window.studio.generate.motionRender({ assetId: selected.id, preset, intensity, aspectRatio: aspect, resolution, fps, durationSeconds: seconds });
      setDone({ assetId: r.assetId, text: r.message });
      log('motion', r.message);
    } catch (e) {
      const t = errText(e);
      if (!/cancelled/i.test(t)) setErr(t);
    } finally { setBusy(false); }
  };

  return (
    <div className="panel-card" aria-label="Motion Effects">
      <h3>Motion Effects <span className="chip off"><span className="dot" />Free · not AI</span></h3>
      <div className="asset-meta">Adds a camera move (zoom or pan) to one picture and saves a short video. It is ordinary editing done on this PC with FilmCraft, not AI-generated video. No key, no cost.</div>
      <div className="field">Picture
        {selected && usable ? <span>{selected.name}</span> : <span className="asset-meta">Select a PNG, JPEG or WebP in the library.</span>}
      </div>
      <div className="gen-settings">
        <label className="field">Movement
          <select value={preset} onChange={(e) => setPreset(e.target.value as MotionJob['preset'])}>{MOTION_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </label>
        <label className="field">Strength
          <select value={intensity} onChange={(e) => setIntensity(e.target.value as MotionJob['intensity'])}>{MOTION_INTENSITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </label>
        <label className="field">Aspect
          <select value={aspect} onChange={(e) => setAspect(e.target.value as MotionJob['aspectRatio'])}>{MOTION_ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}</select>
        </label>
        <label className="field">Resolution
          <select value={resolution} onChange={(e) => setResolution(e.target.value as MotionJob['resolution'])}>{MOTION_RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select>
        </label>
        <label className="field">Frame rate
          <select value={fps} onChange={(e) => setFps(Number(e.target.value) as MotionJob['fps'])}>{MOTION_FPS.map((r) => <option key={r} value={r}>{r} fps</option>)}</select>
        </label>
        <label className="field">Length (s)
          <input type="number" min={MOTION_MIN_SECONDS} max={MOTION_MAX_SECONDS} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
        </label>
      </div>
      <div className="btn-row">
        <button className="btn primary" disabled={!usable || busy} onClick={() => void make()}>{busy ? 'Making video…' : 'Make motion video'}</button>
        {busy && <button className="btn" onClick={() => void window.studio.generate.motionCancel()}>Cancel</button>}
      </div>
      {err && <div className="wf-msg error" role="status">{err}</div>}
      {done && (
        <div className="wf-msg" role="status">
          {done.text}
          <div className="btn-row">
            <button className="btn small primary" onClick={() => onGoto('media', done.assetId)}>Show in library</button>
            <button className="btn small" onClick={() => onGoto('edit', done.assetId)}>Open in Edit</button>
          </div>
        </div>
      )}
    </div>
  );
}

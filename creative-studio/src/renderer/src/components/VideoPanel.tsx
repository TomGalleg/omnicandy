import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '@shared/generation';
import { ACTIVE_VIDEO_STATES, estimateVideoCost, VIDEO_MODELS, videoModelById, type VideoJobRecord } from '@shared/video';
import type { ProviderStatusDto } from '@shared/ipc';
import type { Asset, WorkspaceId } from '@shared/types';

interface Props {
  providers: ProviderStatusDto[] | null;
  selected: Asset | null;
  onGoto: (w: WorkspaceId, assetId?: string) => void;
  log: (source: string, msg: string) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const REF_FORMATS = ['png', 'jpg', 'jpeg', 'webp'];
const STATE_LABEL: Record<VideoJobRecord['state'], string> = {
  submitted: 'Sending', running: 'Making video', downloading: 'Downloading', done: 'Ready', failed: 'Failed', cancelled: 'Stopped',
};

/** AI video (Google Veo with the Gemini key): text or a starting picture, approval, background job list. */
export function VideoPanel({ providers, selected, onGoto, log }: Props) {
  const [jobs, setJobs] = useState<VideoJobRecord[]>([]);
  const [modelId, setModelId] = useState(VIDEO_MODELS[0]!.id);
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [duration, setDuration] = useState(8);
  const [resolution, setResolution] = useState('720p');
  const [refAsset, setRefAsset] = useState<Asset | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    void window.studio.generate.videoJobs().then(setJobs);
    return window.studio.generate.onVideo((r) => {
      setJobs((cur) => [r, ...cur.filter((j) => j.id !== r.id)]);
      if (r.state === 'done' || r.state === 'failed') log('video', r.message);
    });
  }, [log]);

  const model = videoModelById(modelId)!;
  const ready = !!providers?.find((p) => p.id === 'gemini')?.configured;
  // Keep settings valid when the model changes.
  useEffect(() => {
    if (!model.resolutions.includes(resolution)) setResolution(model.resolutions[0]!);
  }, [model, resolution]);
  useEffect(() => { if (resolution !== '720p' && duration !== 8) setDuration(8); }, [resolution, duration]);

  const job = { modelId, prompt, referenceAssetId: refAsset?.id ?? null, aspectRatio: aspect, durationSeconds: duration, resolution };
  const estimate = useMemo(() => {
    try { return estimateVideoCost({ ...job, prompt: job.prompt || 'x' }); } catch { return null; }
  }, [modelId, aspect, duration, resolution]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await window.studio.generate.videoSubmit(job);
      setMsg({ text: r.message });
      log('video', 'Video job started.');
    } catch (e) {
      const t = errText(e);
      setMsg({ text: t, error: !/cancelled/i.test(t) });
    } finally { setBusy(false); }
  };

  const cancel = (id: string) => {
    if (!window.confirm('Google does not offer a way to cancel a running video. CreateCraft will stop waiting and will not import it, but Google may still finish it and bill your account. Stop waiting?')) return;
    void window.studio.generate.videoCancel(id).catch((e: unknown) => setMsg({ text: errText(e), error: true }));
  };

  return (
    <div className="panel-card" aria-label="AI video">
      <h3>Video (Google Veo)</h3>
      {!ready && <div className="notice">Veo uses your Gemini key. Add it under Providers above to make videos.</div>}
      <label className="field">Model
        <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
          {VIDEO_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      <div className="asset-meta">{model.note} · {model.id}</div>
      <div className="field">Starting picture (optional)
        {refAsset ? (
          <div className="ref-pick"><span className="thumb"><img src={window.studio.assetUrl(refAsset.id)} alt="" /></span><span>{refAsset.name}</span><button className="btn small ghost" onClick={() => setRefAsset(null)}>Clear</button></div>
        ) : <span className="asset-meta">Text only. Select a PNG, JPEG or WebP in the library to start from a picture.</span>}
        {selected && selected.id !== refAsset?.id && REF_FORMATS.includes(selected.sourceFormat) && <button className="btn small" onClick={() => setRefAsset(selected)}>Use selected: {selected.name}</button>}
      </div>
      <label className="field">Prompt<textarea aria-label="Describe the shot" value={prompt} maxLength={2000} placeholder="Describe the shot: subject, motion, camera, mood…" onChange={(e) => setPrompt(e.target.value)} /></label>
      <div className="gen-settings">
        <label className="field">Aspect
          <select value={aspect} onChange={(e) => setAspect(e.target.value)}>{model.aspectRatios.map((a) => <option key={a} value={a}>{a}</option>)}</select>
        </label>
        <label className="field">Length
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={resolution !== '720p'}>
            {model.durations.map((s) => <option key={s} value={s}>{s} s</option>)}
          </select>
        </label>
        <label className="field">Resolution
          <select value={resolution} onChange={(e) => setResolution(e.target.value)}>{model.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}</select>
        </label>
      </div>
      {resolution !== '720p' && <div className="asset-meta">1080p and 4k are only available for 8-second clips.</div>}
      {estimate && (
        <div className="estimate" aria-label="Veo price">
          <strong>≈ {formatUsd(estimate.amount)}</strong>
          <span className="asset-meta">{estimate.basis} An estimate, not a confirmed charge.</span>
        </div>
      )}
      <button className="btn primary" disabled={!ready || !prompt.trim() || busy} onClick={() => void submit()}>
        {busy ? 'Waiting for approval…' : 'Make video… (asks you to approve)'}
      </button>
      {msg && <div className={`wf-msg${msg.error ? ' error' : ''}`} role="status">{msg.text}</div>}

      {jobs.length > 0 && (
        <div className="video-jobs" aria-label="Video jobs">
          <h4>Video jobs</h4>
          {jobs.slice(0, 12).map((j) => (
            <div key={j.id} className="provider-row">
              <div className="provider-head">
                <strong title={j.job.prompt}>{j.job.prompt.slice(0, 50)}{j.job.prompt.length > 50 ? '…' : ''}</strong>
                <span className={`chip ${j.state === 'done' ? 'ok' : j.state === 'failed' ? 'warn' : 'off'}`}><span className="dot" />{STATE_LABEL[j.state]}</span>
              </div>
              <div className="asset-meta">{videoModelById(j.job.modelId)?.label} · {j.job.aspectRatio} · {j.job.durationSeconds} s · {j.job.resolution} · est. {formatUsd(j.estimateUsd)}</div>
              <div className={`asset-meta${j.state === 'failed' ? ' err' : ''}`}>{j.message}</div>
              <div className="btn-row">
                {j.state === 'done' && j.assetId && <button className="btn small primary" onClick={() => onGoto('media', j.assetId!)}>Show in library</button>}
                {j.state === 'done' && j.assetId && <button className="btn small" onClick={() => onGoto('edit', j.assetId!)}>Open in Edit</button>}
                {ACTIVE_VIDEO_STATES.includes(j.state) && <button className="btn small danger" onClick={() => cancel(j.id)}>Stop waiting</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

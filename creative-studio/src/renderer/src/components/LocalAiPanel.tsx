import { useEffect, useState } from 'react';
import { clipSeconds, LOCAL_PRESETS, type LocalPreset } from '@shared/localVideo';
import { totalBytes, type DownloadState, type LocalAiStatus } from '@shared/localAi';

const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

/** Free local AI setup (stage C: compatibility check only; download and generation come later). */
export function LocalAiPanel() {
  const [st, setSt] = useState<LocalAiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dl, setDl] = useState<Record<string, DownloadState>>({});
  const [prompt, setPrompt] = useState('');
  const [preset, setPreset] = useState<Exclude<LocalPreset, 'custom'>>('experimental');
  const [making, setMaking] = useState(false);
  const [progress, setProgress] = useState<{ fraction: number | null; line: string } | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const fail = (e: unknown) => setErr((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));

  const check = async () => {
    setBusy(true); setErr(null);
    try { setSt(await window.studio.generate.localAiStatus()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  useEffect(() => {
    void check();
    void window.studio.generate.localAiDownloads().then((l) => setDl(Object.fromEntries(l.map((x) => [x.modelId, x]))));
    const off2 = window.studio.generate.onLocalVideoProgress(setProgress);
    const off1 = window.studio.generate.onLocalAi((x) => setDl((c) => ({ ...c, [x.modelId]: x })));
    return () => { off1(); off2(); };
  }, []);

  const gpu = st?.report.gpus ?? [];
  return (
    <div className="panel-card" aria-label="Free local AI video">
      <h3>Free local AI video <span className="chip off"><span className="dot" />Setup in progress</span></h3>
      <div className="asset-meta">Makes video on this PC with no account and no cost. Download the engine and a small model here, then make short clips. Nothing is tested on this PC until a clip comes out; Motion Effects always works.</div>
      <div className="btn-row"><button className="btn small" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check this PC again'}</button></div>
      {err && <div className="wf-msg error" role="status">{err}</div>}
      {st && (
        <>
          <div className="estimate"><strong>{st.tierLabel}</strong><span className="asset-meta">A memory-based ceiling, not a promise that a model runs.</span></div>
          <div className="asset-meta">
            {st.report.os} · {st.report.cpu.model} ({st.report.cpu.cores} threads) · {st.report.ramGb} GB memory · {st.report.freeDiskGb ?? '?'} GB free for models
          </div>
          <ul className="asset-meta">
            {gpu.length === 0 && <li>No graphics card detected.</li>}
            {gpu.map((g) => <li key={g.name}>{g.name}: {g.vramGb === null ? 'memory unknown' : `${g.vramGb} GB`}{g.integrated ? ' (shared with system memory)' : ''}</li>)}
          </ul>
          {st.warnings.map((w) => <div key={w} className="notice">{w}</div>)}
          <h4>Backends found (none tested yet)</h4>
          <ul className="asset-meta">{st.report.backends.map((b) => <li key={b.id}>{b.label}: {b.found ? 'found' : 'not found'} · {b.detail}</li>)}</ul>
          <h4>Engine and models</h4>
          {st.models.map((m) => (
            <div key={m.model.id} className="provider-row">
              <div className="provider-head"><strong>{m.model.name} {m.model.version}</strong><span className={`chip ${m.offered ? 'ok' : 'off'}`}><span className="dot" />{m.offered ? 'Could be tried' : 'Not offered here'}</span></div>
              <div className="asset-meta">About {m.model.downloadGb} GB download · {m.model.minVramGb} GB video memory · {m.model.license}. {m.model.note}</div>
              {m.reasons.map((r) => <div key={r} className="asset-meta err">{r}</div>)}
              <ModelActions id={m.model.id} files={m.model.files.length} bytes={totalBytes(m.model)} offered={m.offered} state={dl[m.model.id]} onError={fail} />
              <div className="asset-meta">Verified on this PC: {m.verifiedHere ? 'yes' : 'no (nothing has been run)'}. {m.model.licenseNote}</div>
            </div>
          ))}
          {st.generationAvailable && dl['wan-2.1-t2v-1.3b']?.state === 'installed' && (
            <div className="provider-row">
              <h4>Make a clip (free, on this PC)</h4>
              <label className="field">Prompt<textarea value={prompt} maxLength={1000} placeholder="Describe the shot…" onChange={(e) => setPrompt(e.target.value)} /></label>
              <label className="field">Quality
                <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
                  {Object.entries(LOCAL_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}: {p.width}x{p.height}, {clipSeconds(p)} s{p.proven ? '' : ' (not proven on this PC)'}</option>)}
                </select>
              </label>
              <div className="asset-meta">{LOCAL_PRESETS[preset].note} Not tested on this PC until a clip comes out; it may fail or run out of memory.</div>
              <div className="btn-row">
                <button className="btn primary" disabled={making || !prompt.trim()} onClick={() => {
                  setMaking(true); setErr(null); setMade(null); setProgress(null);
                  void window.studio.generate.localVideoRender({ modelId: 'wan-2.1-t2v-1.3b', prompt, preset, width: 0, height: 0, frames: 0, steps: 0 })
                    .then((r) => setMade(r.message)).catch((e: unknown) => { if (!/cancelled/i.test(String(e))) fail(e); }).finally(() => setMaking(false));
                }}>{making ? 'Making…' : 'Make local video'}</button>
                {making && <button className="btn" onClick={() => void window.studio.generate.localVideoCancel()}>Cancel</button>}
              </div>
              {making && <div className="asset-meta" role="status">{progress?.fraction != null ? `${Math.round(progress.fraction * 100)}%` : 'Working…'} {progress?.line.slice(0, 80)}</div>}
              {made && <div className="wf-msg" role="status">{made}</div>}
            </div>
          )}
          <div className="asset-meta">Models are stored in: {st.report.modelDir}
            <button className="btn small ghost" onClick={() => void window.studio.generate.localAiPickDir().then((d) => { if (d) void check(); }).catch(fail)}>Change folder…</button>
          </div>
          <div className="asset-meta">{st.note}</div>
        </>
      )}
    </div>
  );
}

function ModelActions({ id, files, bytes, offered, state, onError }: { id: string; files: number; bytes: number; offered: boolean; state?: DownloadState; onError: (e: unknown) => void }) {
  const s = state?.state ?? 'idle';
  if (!files) return <div className="asset-meta">Not downloadable through OmniCandy yet.</div>;
  const busy = s === 'downloading' || s === 'verifying';
  const pct = state && state.totalBytes ? Math.min(100, Math.round((state.doneBytes / state.totalBytes) * 100)) : 0;
  return (
    <div>
      {busy && <div className="asset-meta" role="status">{s === 'verifying' ? 'Checking' : 'Downloading'} {state?.file ?? ''}: {gb(state?.doneBytes ?? 0)} of {gb(bytes)} GB ({pct}%)<progress value={pct} max={100} /></div>}
      {state?.message && !busy && <div className={`asset-meta${s === 'failed' ? ' err' : ''}`} role="status">{state.message}</div>}
      <div className="btn-row">
        {s !== 'installed' && !busy && <button className="btn small primary" disabled={!offered} title={offered ? '' : 'This PC does not meet the needs of this model'} onClick={() => void window.studio.generate.localAiDownload(id).catch(onError)}>{s === 'cancelled' || s === 'failed' ? 'Resume download…' : `Download ${gb(bytes)} GB…`}</button>}
        {busy && <button className="btn small danger" onClick={() => void window.studio.generate.localAiCancel(id)}>Cancel</button>}
        {(s === 'installed' || s === 'cancelled' || s === 'failed') && !busy && <button className="btn small" onClick={() => void window.studio.generate.localAiRemove(id).catch(onError)}>Remove files…</button>}
      </div>
    </div>
  );
}

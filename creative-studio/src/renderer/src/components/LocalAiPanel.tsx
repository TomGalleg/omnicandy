import { useEffect, useState } from 'react';
import type { LocalAiStatus } from '@shared/localAi';

/** Free local AI setup (stage C: compatibility check only; download and generation come later). */
export function LocalAiPanel() {
  const [st, setSt] = useState<LocalAiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const check = async () => {
    setBusy(true); setErr(null);
    try { setSt(await window.studio.generate.localAiStatus()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  useEffect(() => { void check(); }, []);

  const gpu = st?.report.gpus ?? [];
  return (
    <div className="panel-card" aria-label="Free local AI video">
      <h3>Free local AI video <span className="chip off"><span className="dot" />Setup in progress</span></h3>
      <div className="asset-meta">Makes video on this PC with no account and no cost. Model download and generation are not available yet; this checks whether your PC could run it. Until then, use Motion Effects.</div>
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
          <h4>Models</h4>
          {st.models.map((m) => (
            <div key={m.model.id} className="provider-row">
              <div className="provider-head"><strong>{m.model.name} {m.model.version}</strong><span className={`chip ${m.offered ? 'ok' : 'off'}`}><span className="dot" />{m.offered ? 'Could be tried' : 'Not offered here'}</span></div>
              <div className="asset-meta">About {m.model.downloadGb} GB download · {m.model.minVramGb} GB video memory · {m.model.license}. {m.model.note}</div>
              {m.reasons.map((r) => <div key={r} className="asset-meta err">{r}</div>)}
              <div className="asset-meta">Verified on this PC: {m.verifiedHere ? 'yes' : 'no (nothing has been run)'}. {m.model.licenseNote}</div>
            </div>
          ))}
          <div className="asset-meta">{st.note}</div>
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { EDITOR_APPS } from '@shared/appEditors';
import { deliverGroupFor, laterVersions, lineage, presetsFor, type DeliverJob, type DeliverRecord } from '@shared/deliver';
import type { Asset, ProjectManifest } from '@shared/types';
import { formatBytes, formatDims } from '../format';
import type { LiveApi } from '../useLive';
import { AssetThumb } from './AssetBrowser';

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  liveApi: LiveApi;
  onSelectAsset: (id: string) => void;
  log: (source: string, msg: string) => void;
}

const STATUS_LABEL: Record<DeliverJob['status'], string> = { queued: 'Waiting', running: 'Exporting…', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Deliver: turn library files into finished files. The ArtCraft apps' own command-line tools do
 * the work in the background (no app window opens); results land in the project's exports folder
 * with a record of the source version, preset and checksum.
 */
export function DeliverWorkspace({ manifest, selected, liveApi, onSelectAsset, log }: Props) {
  const assets = useMemo(() => manifest?.assets ?? [], [manifest]);
  const [jobs, setJobs] = useState<DeliverJob[]>([]);
  const [history, setHistory] = useState<DeliverRecord[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    void window.studio.deliver.jobs().then(setJobs);
    return window.studio.deliver.onJobs(setJobs);
  }, []);
  const doneCount = jobs.filter((j) => j.status === 'done').length;
  const loadHistory = useCallback(() => { void window.studio.deliver.history().then(setHistory); }, []);
  useEffect(() => { loadHistory(); }, [loadHistory, doneCount]);
  const running = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [running]);

  const presets = selected ? presetsFor(selected.sourceFormat) : [];
  const group = selected ? deliverGroupFor(selected.sourceFormat) : null;
  useEffect(() => { setPicked(new Set(presets.slice(0, 1).map((p) => p.id))); setError(null); }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const chain = selected ? lineage(assets, selected.id) : [];
  const newer = selected ? laterVersions(assets, selected.id) : [];
  const family = new Set([...chain, ...newer].map((a) => a.id));
  const familyHistory = history.filter((r) => family.has(r.source.assetId));
  const live = liveApi.live;
  const unsaved = !!selected && live?.status === 'ready' && live.asset?.id === selected.id && live.history.length > 1 && !live.savedVersionIds.length;

  const exportNow = async () => {
    if (!selected) return;
    setError(null);
    try {
      const added = await window.studio.deliver.enqueue(selected.id, [...picked]);
      log('deliver', `Queued ${added.length} export${added.length === 1 ? '' : 's'} of ${selected.name}: ${added.map((j) => j.presetLabel).join(', ')}`);
    } catch (e) { setError(errText(e)); }
  };

  const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const finishedRecent = jobs.filter((j) => !(j.status === 'queued' || j.status === 'running'));
  const total = jobs.length;
  const finished = total - activeJobs.length;

  return (
    <div className="deliver">
      <div className="deliver-main">
        {!selected && <div className="panel-card"><h2>Pick a file to deliver</h2><p className="asset-meta">Choose a file on the left. Deliver turns it into finished files (JPEG, PNG, PDF, MP4, WAV and more) with the right ArtCraft app, in the background.</p></div>}
        {selected && (
          <div className="panel-card">
            <div className="deliver-source">
              <div className="deliver-thumb"><AssetThumb asset={selected} rendition={assets.find((x) => x.parentId === selected.id && x.kind === 'image' && ['pcraft', 'designcraft', 'docx', 'pdf'].includes(selected.sourceFormat))} /></div>
              <div>
                <h2 className="deliver-title" title={selected.name}>{selected.name}</h2>
                <p className="asset-meta">{selected.kind} · {selected.sourceFormat.toUpperCase()} · {formatDims(selected) || formatBytes(selected.bytes)}</p>
                <p className="asset-meta" aria-label="Version history">
                  {chain.length > 1 ? <>Version history: {chain.map((a, i) => (
                    <span key={a.id}>{i > 0 && ' → '}{a.id === selected.id ? <strong>{a.name}</strong> : <button className="link" onClick={() => onSelectAsset(a.id)}>{a.name}</button>}</span>
                  ))}</> : 'Original file'}
                </p>
                {newer.length > 0 && (
                  <p className="asset-meta">Newer versions: {newer.slice(0, 6).map((a, i) => (
                    <span key={a.id}>{i > 0 && ', '}<button className="link" onClick={() => onSelectAsset(a.id)}>{a.name}</button></span>
                  ))}</p>
                )}
              </div>
            </div>
            {unsaved && (
              <div className="notice" role="status">
                {selected.name} is open in {EDITOR_APPS[live!.appId].name} with changes that are not saved. Exports use the saved file; save a new version first to include them.
                {' '}<button className="btn small" disabled={liveApi.busy} onClick={() => void liveApi.act('Save', async () => {
                  const s = await window.studio.live.saveVersion();
                  const id = s.savedVersionIds[0];
                  if (id) onSelectAsset(id);
                  return s;
                })}>Save as new version</button>
              </div>
            )}
            {!group && <p className="asset-meta">{selected.sourceFormat.toUpperCase()} files can't be delivered yet.</p>}
            {group && (
              <>
                <h3>Export as</h3>
                <div className="preset-list" role="group" aria-label="Export formats">
                  {presets.map((p) => (
                    <label key={p.id} className={`preset${picked.has(p.id) ? ' on' : ''}`}>
                      <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                      <span className="preset-text"><strong>{p.label}</strong><span className="asset-meta">{p.note} · .{p.ext} · {EDITOR_APPS[p.app].name}</span></span>
                    </label>
                  ))}
                </div>
                <div className="btn-row">
                  <button className="btn primary" disabled={!picked.size} onClick={() => void exportNow()}>
                    Export {picked.size} file{picked.size === 1 ? '' : 's'}
                  </button>
                  <button className="btn" onClick={() => void window.studio.deliver.openFolder()}>Open exports folder</button>
                </div>
                {error && <p className="asset-meta err" role="alert">{error}</p>}
              </>
            )}
          </div>
        )}

        {selected && (
          <div className="panel-card">
            <h3>Exports of this file and its versions</h3>
            {!familyHistory.length && <p className="asset-meta">None yet.</p>}
            {familyHistory.map((r) => <RecordRow key={r.jobId} r={r} />)}
          </div>
        )}
      </div>

      <div className="deliver-side">
        <div className="panel-card" aria-label="Export queue">
          <div className="row-between">
            <h3>Export queue</h3>
            {finishedRecent.length > 0 && <button className="btn small ghost" onClick={() => void window.studio.deliver.clearFinished()}>Clear finished</button>}
          </div>
          {total > 0 && (
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={finished} aria-label="Exports finished">
              <span style={{ width: `${(finished / total) * 100}%` }} />
              {running && <span className="progress-run" />}
            </div>
          )}
          {total > 0 && <p className="asset-meta">{finished} of {total} finished{activeJobs.length ? ` · ${activeJobs.length} to go` : ''}</p>}
          {!jobs.length && <p className="asset-meta">Nothing queued. Exports run one at a time in the background, without opening any app.</p>}
          {[...jobs].reverse().map((j) => (
            <div className={`job ${j.status}`} key={j.id} data-status={j.status}>
              <div className="job-top">
                <span className="job-name" title={`${j.assetName} → ${j.presetLabel}`}>{j.presetLabel}</span>
                <span className={`chip ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'warn' : 'off'}`}><span className="dot" />{STATUS_LABEL[j.status]}</span>
              </div>
              <span className="asset-meta">
                {j.assetName}{j.requestedBy === 'claude' ? ' · asked by Claude' : ''}
                {j.status === 'running' && j.startedAt ? ` · ${Math.round((Date.now() - Date.parse(j.startedAt)) / 1000)} s` : ''}
                {j.status === 'done' && j.output ? ` · ${j.output} · ${formatBytes(j.bytes ?? 0)}` : ''}
              </span>
              {j.error && <span className="asset-meta err">{j.error}</span>}
              {j.note && <span className="asset-meta">{j.note}</span>}
              <div className="btn-row">
                {(j.status === 'queued' || j.status === 'running') && <button className="btn small" onClick={() => void window.studio.deliver.cancel(j.id)}>Cancel</button>}
                {j.status === 'done' && j.output && <button className="btn small" onClick={() => void window.studio.revealExport(j.output!)}>Show in folder</button>}
                {j.status === 'done' && j.output && /.(pdf|docx|png|jpe?g|svg|wav|flac|mp4)$/i.test(j.output) && (
                  <button className="btn small" title="Copy this export into the library so you can open it in another app" onClick={() => void window.studio.deliver.addToLibrary(j.id).then((id) => { log('deliver', `Added ${j.output} to the library`); onSelectAsset(id); }).catch((e: unknown) => setError(errText(e)))}>Add to library</button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="panel-card">
          <h3>All exports</h3>
          <p className="asset-meta">Recorded in exports/manifest.json with the source version and a checksum.</p>
          {!history.length && <p className="asset-meta">None yet.</p>}
          {history.slice(0, 30).map((r) => <RecordRow key={r.jobId} r={r} showSource />)}
        </div>
      </div>
    </div>
  );
}

function RecordRow({ r, showSource }: { r: DeliverRecord; showSource?: boolean }) {
  return (
    <div className="export-row">
      <span>
        {r.output.file}
        <span className="asset-meta"> · {r.presetLabel} · {formatBytes(r.output.bytes)} · from {showSource ? r.source.versions.join(' → ') : r.source.name} · {new Date(r.at).toLocaleString()} · <span className="mono" title={`SHA-256 ${r.output.sha256}`}>{r.output.sha256.slice(0, 10)}</span></span>
      </span>
      <button className="btn small" onClick={() => void window.studio.revealExport(r.output.file)}>Show in folder</button>
    </div>
  );
}

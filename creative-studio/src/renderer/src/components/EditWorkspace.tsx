import { useEffect, useMemo, useState } from 'react';
import { EDITOR_APPS, editorFor, type EditorApp, type QuickEdit } from '@shared/appEditors';
import type { EditResultDto, ExternalEditDto } from '@shared/ipc';
import type { Asset, ProjectManifest } from '@shared/types';
import type { LiveApi } from '../useLive';
import { isTaskActive, LiveDocument, LiveSteps } from './live/LiveParts';

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  liveApi: LiveApi;
  onProjectChanged: () => void;
  onSelectAsset: (id: string) => void;
  log: (source: string, msg: string) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Edit tab: edits the selected file with the ArtCraft app that owns its type. */
export function EditWorkspace({ manifest, selected, liveApi, onProjectChanged, onSelectAsset, log }: Props) {
  const app = selected ? editorFor(selected.sourceFormat) : null;

  if (!selected) {
    return <Empty title="Choose something to edit"><p>Select a file in the media browser. CreateCraft picks the right ArtCraft app for it: photos go to PhotoCraft, vectors to VectorCraft, audio to SoundCraft, video to FilmCraft.</p></Empty>;
  }
  if (!app) {
    return <Empty title={`No editor for ${selected.sourceFormat.toUpperCase()} files`}><p>None of the installed ArtCraft apps is set up to edit this file type yet.</p></Empty>;
  }
  return (
    <div className="live">
      <div className="live-bar">
        <span className="chip real"><span className="dot" />Editing with {app.name}</span>
        <span className="asset-meta">{selected.name} · {app.blurb}</span>
        <span className="spacer" />
        <span className="asset-meta">Your file is never changed: every edit is saved as a new version.</span>
      </div>
      <div className="live-grid">
        <QuickEdits key={`${selected.id}-${app.id}`} app={app} asset={selected} manifest={manifest} onProjectChanged={onProjectChanged} onSelectAsset={onSelectAsset} log={log} />
        {app.open === 'live' && <PhotoCraftLive selected={selected} liveApi={liveApi} onProjectChanged={onProjectChanged} />}
        {app.open === 'working-copy' && <WorkingCopy app={app} asset={selected} onProjectChanged={onProjectChanged} onSelectAsset={onSelectAsset} log={log} />}
        {app.open === 'none' && (
          <section className="panel-card">
            <h2 style={{ fontSize: 14 }}>Open in {app.name}</h2>
            <p className="asset-meta">{app.note}</p>
          </section>
        )}
      </div>
    </div>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-card"><h2>{title}</h2>{children}</div></div>;
}

function defaults(op: QuickEdit) {
  return Object.fromEntries(op.params.map((p) => [p.key, p.default])) as Record<string, number | string>;
}

function QuickEdits({ app, asset, manifest, onProjectChanged, onSelectAsset, log }: {
  app: EditorApp; asset: Asset; manifest: ProjectManifest | null; onProjectChanged: () => void; onSelectAsset: (id: string) => void; log: Props['log'];
}) {
  const [opId, setOpId] = useState(app.quickEdits[0]?.id ?? '');
  const op = app.quickEdits.find((o) => o.id === opId);
  const [values, setValues] = useState<Record<string, number | string>>(op ? defaults(op) : {});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EditResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!app.quickEdits.length) {
    return <section className="panel-card"><h2 style={{ fontSize: 14 }}>Quick edits</h2><p className="asset-meta">{app.note ?? `No quick edits for ${app.name} yet.`}</p></section>;
  }

  const apply = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await window.studio.edit.apply(asset.id, opId, values);
      setResult(r);
      log(app.id, `${r.message} (${asset.name})`);
      onProjectChanged();
    } catch (e) {
      setError(errText(e));
      log(app.id, `${op?.label} failed: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const created = result ? result.assetIds.map((id) => manifest?.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a) : [];
  const preview = created.find((a) => a.kind === 'image') ?? created.find((a) => a.kind === 'vector');
  const audio = created.find((a) => a.kind === 'audio');

  return (
    <section className="panel-card">
      <h2 style={{ fontSize: 14 }}>Quick edits · {app.name}</h2>
      <div className="op-list" role="radiogroup" aria-label="Edit">
        {app.quickEdits.map((o) => (
          <button key={o.id} role="radio" aria-checked={o.id === opId} className={`op${o.id === opId ? ' active' : ''}`} disabled={busy}
            onClick={() => { setOpId(o.id); setValues(defaults(o)); setResult(null); setError(null); }}>{o.label}</button>
        ))}
      </div>
      {op && op.params.length > 0 && (
        <div className="op-params">
          {op.params.map((p) => (
            <label className="field" key={p.key}>
              <span>{p.label}{p.type === 'number' && <strong> {values[p.key]}{p.unit ? ` ${p.unit}` : ''}</strong>}</span>
              {p.type === 'number'
                ? <input type="range" min={p.min} max={p.max} step={p.step} value={Number(values[p.key])} disabled={busy}
                    onChange={(e) => setValues((v) => ({ ...v, [p.key]: Number(e.target.value) }))} />
                : <select value={String(values[p.key])} disabled={busy} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}>
                    {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>}
            </label>
          ))}
        </div>
      )}
      <div className="btn-row">
        <span className="spacer" />
        <button className="btn primary" disabled={busy || !op} onClick={() => void apply()}>{busy ? `${app.name} is working…` : `Apply ${op?.label ?? ''}`}</button>
      </div>
      {error && <div className="wf-msg error" role="alert">{error}</div>}
      {result && (
        <div className="op-result">
          {preview && <img src={window.studio.assetUrl(preview.id)} alt={`Result: ${preview.name}`} />}
          {audio && <audio controls src={window.studio.assetUrl(audio.id)} />}
          <div className="asset-meta">{result.message} New: {created.map((a) => a.name).join(', ')}</div>
          <div className="btn-row">
            {created[0] && <button className="btn small" onClick={() => onSelectAsset(created[0]!.id)}>Select the new version</button>}
          </div>
        </div>
      )}
    </section>
  );
}

function WorkingCopy({ app, asset, onProjectChanged, onSelectAsset, log }: {
  app: EditorApp; asset: Asset; onProjectChanged: () => void; onSelectAsset: (id: string) => void; log: Props['log'];
}) {
  const [copies, setCopies] = useState<ExternalEditDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => { void window.studio.edit.list().then(setCopies); }, []);
  const mine = useMemo(() => copies.filter((c) => c.assetId === asset.id), [copies, asset.id]);

  const wrap = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { const text = await fn(); setMsg({ text }); log(app.id, text); } catch (e) { setMsg({ text: errText(e), error: true }); } finally { setBusy(false); }
  };

  return (
    <section className="panel-card">
      <h2 style={{ fontSize: 14 }}>Open in {app.name}</h2>
      <p className="asset-meta">
        Opens a working copy in the {app.name} window so you can edit by hand with all its tools.
        {app.id === 'soundcraft' && ' Audio opens as a SoundCraft session with your file imported.'}
        {' '}Save in {app.name} (Ctrl+S), then press <strong>Bring back</strong> to add it to the library as a new version.
      </p>
      <div className="btn-row">
        <button className="btn primary" disabled={busy} onClick={() => void wrap(async () => {
          const c = await window.studio.edit.openWorkingCopy(asset.id);
          setCopies(await window.studio.edit.list());
          return `Opened a working copy of ${c.assetName} in ${app.name}.`;
        })}>Open {asset.name} in {app.name}</button>
      </div>
      {mine.map((c) => (
        <div className="export-row" key={c.id}>
          <span>Working copy opened {new Date(c.openedAt).toLocaleTimeString()}</span>
          <button className="btn small" disabled={busy} onClick={() => void wrap(async () => {
            const r = await window.studio.edit.bringBack(c.id);
            onProjectChanged();
            if (r.assetIds[0]) onSelectAsset(r.assetIds[0]);
            return r.message;
          })}>Bring back as new version</button>
        </div>
      ))}
      {msg && <div className={msg.error ? 'wf-msg error' : 'asset-meta'}>{msg.text}</div>}
    </section>
  );
}

const OPENABLE = new Set(EDITOR_APPS.photocraft.formats);

function PhotoCraftLive({ selected, liveApi, onProjectChanged }: { selected: Asset; liveApi: LiveApi; onProjectChanged: () => void }) {
  const { live, busy, act } = liveApi;
  const isOpen = live?.status === 'ready' && !!live.asset;
  const taskActive = isTaskActive(live?.collab.phase ?? 'idle');
  return (
    <>
      <section className="panel-card">
        <h2 style={{ fontSize: 14 }}>Open in PhotoCraft (live)</h2>
        <p className="asset-meta">Opens the real PhotoCraft window with the controls docked to its left edge: run automation steps, take control to edit by hand, then save a new version.</p>
        {live?.status === 'error' && <div className="notice" role="alert">{live.error}</div>}
        <div className="btn-row">
          <button className="btn primary" disabled={!OPENABLE.has(selected.sourceFormat) || busy || taskActive}
            onClick={() => void act('Open in PhotoCraft', () => window.studio.live.open(selected.id))}>
            {live?.status === 'starting' ? 'Starting PhotoCraft…' : isOpen && live!.asset!.id === selected.id ? 'Re-open in PhotoCraft' : `Open ${selected.name} in PhotoCraft`}
          </button>
          {isOpen && (live!.poppedOut
            ? <button className="btn" disabled={busy} onClick={() => void act('Dock controls', window.studio.live.dock)}>Dock controls here</button>
            : <button className="btn" disabled={busy} onClick={() => void act('Pop out controls', window.studio.live.popOut)}>Pop out next to PhotoCraft</button>)}
        </div>
        {isOpen && <div className="asset-meta">Live: {live!.asset!.name}{live!.poppedOut ? ' · controls are next to the PhotoCraft window' : ''}</div>}
      </section>
      {isOpen && !live!.poppedOut && (
        <>
          <LiveSteps liveApi={liveApi} />
          <LiveDocument liveApi={liveApi} onSaved={onProjectChanged} />
        </>
      )}
    </>
  );
}

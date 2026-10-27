import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd, modelById } from '@shared/generation';
import type { HfJobRecord, HiggsfieldJob } from '@shared/higgsfield';
import type { ProviderStatusDto } from '@shared/ipc';
import type { Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import { addJob, cardState, mergeJobs, parseDraft, updateJob, type JobView, type StudioJob } from '@shared/aiStudio';
import { recraftModel } from '@shared/recraft';
import { findModels, STUDIO_PROVIDERS, type StudioModel, type StudioProviderId } from '@shared/providerCapabilities';
import { isShown, parseFavs, toggleFav } from '@shared/studioCatalog';
import { CreateWorkspace, type CreateSeed, type RunFn } from './CreateWorkspace';
import { ModelGallery } from './ModelGallery';
import { importDropped, isFileDrag, LIBRARY_CHANGED, uploadWithPicker } from '../importFiles';
import { PROVIDERS_CHANGED } from './ProvidersCard';
import './aiStudio.css';
import './aiStudioWorkspace.css';

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  onGoto: (w: WorkspaceId, assetId?: string) => void;
  log: (source: string, msg: string) => void;
  onProjectChanged?: () => void;
}

type Tab = 'explore' | 'create' | 'assets' | 'jobs';
const DRAFT_KEY = 'cs-studio-draft';
const FAV_KEY = 'cs-studio-favs';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const STATE_LABEL: Record<JobView['state'], string> = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', canceled: 'Cancelled', moderated: 'Blocked by the content check' };

/** AI Studio: browse models across providers, create with the ready ones, see results and jobs.
 *  Generation goes through the same main-process services as the classic tab (approval dialog, spending limit,
 *  keys that never reach this window). Providers that are only documented, not connected, cannot generate. */
export function AiStudio({ manifest, selected, onGoto, log, onProjectChanged }: Props) {
  const [tab, setTab] = useState<Tab>('explore');
  const [providers, setProviders] = useState<ProviderStatusDto[] | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [hf, setHf] = useState<HfJobRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [seed, setSeed] = useState<CreateSeed>({ key: 0 });
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const depth = useRef(0);
  const [favs, setFavs] = useState<string[]>(() => { try { return parseFavs(localStorage.getItem(FAV_KEY)); } catch { return []; } });

  useEffect(() => {
    const load = () => { void window.studio.generate.providers().then(setProviders); };
    load();
    window.addEventListener(PROVIDERS_CHANGED, load);
    return () => window.removeEventListener(PROVIDERS_CHANGED, load);
  }, []);

  // A draft handed over by another screen (provider/model/prompt/reference) is used once.
  useEffect(() => {
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(DRAFT_KEY); sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
    const d = parseDraft(raw);
    if (!d) return;
    const m = d.providerId && d.modelId ? findModels({}).find((x) => x.providerId === d.providerId && x.id === d.modelId) : undefined;
    setSeed({
      key: 1, ...(m ? { model: m } : {}), ...(d.prompt ? { prompt: d.prompt } : {}), ...(d.referenceAssetId ? { refId: d.referenceAssetId } : {}),
      ...(m && m.providerId === 'higgsfield' ? { hf: { modelId: m.id, prompt: d.prompt ?? '', params: {}, inputs: d.hfInputs ?? {} } } : {}),
    });
    if (d.from) setMsg({ text: `Opened from ${d.from === 'photocraft' ? 'PhotoCraft' : d.from === 'filmcraft' ? 'FilmCraft' : d.from}'s Quick AI with your prompt, model and files. Adjust anything, then generate.` });
    setTab('create');
  }, []);

  // Files added from here (button or drop) or from a slot in Create: reload the project's list so they appear everywhere.
  useEffect(() => {
    const reload = () => { onProjectChanged?.(); };
    window.addEventListener(LIBRARY_CHANGED, reload);
    return () => window.removeEventListener(LIBRARY_CHANGED, reload);
  }, [onProjectChanged]);

  const report = (r: { text: string; error: boolean; result: { imported: Array<{ name: string }> } }) => {
    setNote({ text: r.text, error: r.error });
    for (const a of r.result.imported) log('import', `Imported ${a.name} (AI Studio).`);
  };
  const upload = () => { void uploadWithPicker().then(report).catch((e: unknown) => setNote({ text: errText(e), error: true })); };

  // Jobs are saved in the project (main process), so they survive restarts. Higgsfield jobs resume polling when listed.
  useEffect(() => { void window.studio.generate.studioJobs().then(setJobs).catch(() => undefined); }, []);
  useEffect(() => {
    void window.studio.generate.higgsfieldJobs().then(setHf).catch(() => undefined);
    return window.studio.generate.onHiggsfield((r) => setHf((cur) => (cur.some((x) => x.id === r.id) ? cur.map((x) => (x.id === r.id ? r : x)) : [r, ...cur])));
  }, []);
  const saveJobs = useCallback((next: StudioJob[]) => {
    setJobs(next);
    void window.studio.generate.studioJobsSave(next).catch(() => undefined);
  }, []);

  const configured = useMemo(() => new Set((providers ?? []).filter((p) => p.configured).map((p) => p.id as string)), [providers]);
  const views = useMemo(() => mergeJobs(jobs, hf), [jobs, hf]);

  const toggleFavourite = (k: string) => setFavs((cur) => { const n = toggleFav(cur, k); try { localStorage.setItem(FAV_KEY, JSON.stringify(n)); } catch { /* storage unavailable */ } return n; });
  const create = (m: StudioModel) => { setSeed((s) => ({ key: s.key + 1, model: m })); setMsg(null); setTab('create'); };

  const run: RunFn = async (j, label, providerId, exec) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const rec: StudioJob = { id, at: new Date().toISOString(), providerId, modelId: j.modelId, modelLabel: label, prompt: j.prompt, settings: j.settings, count: j.count, referenceAssetIds: j.referenceAssetIds, state: 'running' };
    let list = addJob(jobs, rec);
    saveJobs(list);
    setBusy(true); setMsg(null);
    try {
      const r = await exec();
      list = updateJob(list, id, { state: 'done', message: r.message, assetIds: r.assetIds, estimateUsd: r.estimate.amount });
      setMsg({ text: r.message });
      log('generate', r.message);
    } catch (e) {
      const t = errText(e);
      const cancelled = /cancelled/i.test(t);
      list = updateJob(list, id, { state: cancelled ? 'canceled' : 'failed', message: t });
      setMsg({ text: t, error: !cancelled });
      log('generate', t);
    } finally { setBusy(false); saveJobs(list); }
  };

  // Higgsfield is asynchronous: this resolves once Higgsfield accepted the request (after the approval card); the rest arrives as events.
  const submitHiggsfield = async (job: HiggsfieldJob) => {
    setBusy(true); setMsg(null);
    try {
      const r = await window.studio.generate.higgsfieldRun(job);
      setHf((cur) => (cur.some((x) => x.id === r.id) ? cur : [r, ...cur]));
      setMsg({ text: 'Sent to Higgsfield. It runs in the background: follow it in History or Jobs. The result is saved to your library when it finishes.' });
      log('generate', 'Higgsfield request accepted.');
    } catch (e) {
      const t = errText(e);
      setMsg({ text: t, error: !/cancelled/i.test(t) });
      log('generate', t);
    } finally { setBusy(false); }
  };

  const cancelJob = (v: JobView) => {
    if (v.source !== 'higgsfield') return;
    void window.studio.generate.higgsfieldCancel(v.id.slice(3)).then((r) => setHf((cur) => cur.map((x) => (x.id === r.id ? r : x)))).catch((e: unknown) => setMsg({ text: errText(e), error: true }));
  };

  const retry = (v: JobView) => {
    const m = findModels({ providerId: v.providerId as StudioProviderId }).find((x) => x.id === v.modelId);
    if (!m) return;
    const rec = v.source === 'higgsfield' ? hf.find((x) => `hf-${x.id}` === v.id) : undefined;
    setSeed((s) => ({ key: s.key + 1, model: m, prompt: v.prompt, settings: v.settings, count: v.count, refId: v.referenceAssetIds[0] ?? null, ...(rec ? { hf: rec.job } : {}) }));
    setMsg(null); setTab('create');
  };

  const made = (manifest?.assets ?? []).filter((a) => a.provenance.origin === 'generated' && (a.kind === 'image' || a.kind === 'vector' || a.kind === 'video')).slice().reverse();
  const readyCount = findModels({ wiredOnly: true }).filter(isShown).filter((m) => cardState(m, configured) === 'ready').length;
  const activeJobs = views.filter((v) => v.state === 'queued' || v.state === 'running').length;
  const finished = views.some((v) => v.state !== 'queued' && v.state !== 'running');

  return (
    <div
      className="aistudio"
      onDragEnter={(e) => { if (isFileDrag(e)) { depth.current++; setDragging(true); } }}
      onDragOver={(e) => { if (isFileDrag(e)) e.preventDefault(); }}
      onDragLeave={(e) => { if (isFileDrag(e) && --depth.current <= 0) { depth.current = 0; setDragging(false); } }}
      onDropCapture={() => { depth.current = 0; setDragging(false); }}
      onDrop={(e) => { if (!isFileDrag(e)) return; e.preventDefault(); void importDropped(e.dataTransfer.files).then(report).catch((err: unknown) => setNote({ text: errText(err), error: true })); }}
    >
      {dragging && <div className="as-drop" aria-hidden="true"><strong>Drop to add to your library</strong><span>Pictures, videos and sounds are copied in. Your originals are never changed.</span></div>}
      <div className="as-hero">
        <h2>AI Studio</h2>
        <span className="asset-meta">One place for every AI model: explore what each can do, pick one, and make pictures, real SVG art and video. {readyCount} model{readyCount === 1 ? ' is' : 's are'} ready to use right now; the others are shown so you can see what is coming. {favs.length ? `${favs.length} favourite${favs.length === 1 ? '' : 's'} saved.` : ''}</span>
        <div className="as-tabs" role="tablist" aria-label="AI Studio">
          {([['explore', 'Explore'], ['create', 'Create'], ['assets', 'Assets'], ['jobs', 'Jobs']] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className="as-tab" onClick={() => setTab(id)}>
              {label}{id === 'assets' && made.length ? <span className="as-count">{made.length}</span> : null}{id === 'jobs' && views.length ? <span className="as-count">{activeJobs ? `${activeJobs} running` : views.length}</span> : null}
            </button>
          ))}
          <button className="as-tab as-upload" onClick={upload} title="Choose files from your computer (you can also drag and drop them anywhere on this screen)">⬆ Upload media</button>
          <a className="as-tab as-link" href="https://www.recraft.ai/app/api" target="_blank" rel="noreferrer" title="Opens your Recraft API page in your browser">Recraft dashboard ↗</a>
          <a className="as-tab as-link" href="https://open.higgsfield.ai/dashboard" target="_blank" rel="noreferrer" title="Opens your Higgsfield dashboard in your browser">Higgsfield dashboard ↗</a>
        </div>
      </div>

      {note && <div className={`wf-msg${note.error ? ' error' : ''}`} role="status">{note.text} <button className="btn small ghost" onClick={() => setNote(null)}>Dismiss</button></div>}

      {tab === 'explore' && <ModelGallery assets={manifest?.assets ?? []} configured={configured} favs={favs} onToggleFav={toggleFavourite} onCreate={create} />}

      {/* Create stays mounted while you look at other tabs, so a half-written prompt or a running job is not lost. */}
      <div hidden={tab !== 'create'}>
        <CreateWorkspace manifest={manifest} selected={selected} configured={configured} seed={seed} jobs={views} busy={busy} msg={msg} run={run} submitHiggsfield={submitHiggsfield} cancelJob={cancelJob} onExplore={() => setTab('explore')} onGoto={onGoto} />
      </div>

      {tab === 'assets' && (
        <>
          {made.length === 0 && <div className="asset-meta">Nothing yet. New pictures, SVG and videos land here and in the library as originals, with their prompt, model and settings.</div>}
          <div className="gen-grid">
            {made.map((a) => (
              <article key={a.id} className="gen-card">
                <button className="gen-thumb" onClick={() => onGoto('media', a.id)} aria-label={`View ${a.name}`}>
                  {a.kind === 'video' ? <video src={window.studio.assetUrl(a.id)} muted preload="metadata" /> : <img src={window.studio.assetUrl(a.id)} alt="" />}
                </button>
                <div className="gen-body">
                  <div className="gen-prompt" title={a.provenance.prompt}>{a.provenance.prompt}</div>
                  <div className="asset-meta">{STUDIO_PROVIDERS.find((p) => p.id === a.provenance.provider)?.label ?? a.provenance.provider} · {modelById(a.provenance.model ?? '')?.label ?? recraftModel(a.provenance.model ?? '')?.label ?? a.provenance.model}{a.provenance.requestedBy === 'claude' ? ' · asked by Claude' : ''}</div>
                  <div className="asset-meta">{Object.values(a.provenance.settings ?? {}).join(' · ')}{a.width ? ` · ${a.width}×${a.height}` : ''}</div>
                  <div className="btn-row">
                    <button className="btn small primary" onClick={() => onGoto(a.kind === 'video' ? 'media' : 'edit', a.id)}>{a.kind === 'video' ? 'Open in Media' : 'Open in Edit'}</button>
                    <button className="btn small" onClick={() => { setSeed((s) => ({ ...s, key: s.key + 1, prompt: a.provenance.prompt ?? '', refId: a.kind === 'image' ? a.id : null })); setTab('create'); }}>Reuse in Create</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {tab === 'jobs' && (
        <div className="as-jobs">
          {views.length === 0 && <div className="asset-meta">No jobs yet. Every generation you start appears here with its result.</div>}
          {views.map((j) => (
            <div key={j.id} className={`as-job ${j.state}`}>
              <div className="as-state">{j.state === 'running' || j.state === 'queued' ? <span className="as-spin" /> : null}{STATE_LABEL[j.state]} · {j.modelLabel}</div>
              <div className="gen-prompt" title={j.prompt}>{j.prompt || '(no prompt)'}</div>
              <div className="asset-meta">{new Date(j.at).toLocaleString()}{j.source === 'studio' ? ` · ${j.count} image${j.count === 1 ? '' : 's'}` : ''}{j.estimateUsd ? ` · est. ${formatUsd(j.estimateUsd)}` : ''}</div>
              {j.message && <div className="asset-meta">{j.message}</div>}
              <div className="btn-row">
                {j.assetIds[0] && <button className="btn small" onClick={() => onGoto('media', j.assetIds[0])}>Show result</button>}
                {j.cancellable && <button className="btn small" onClick={() => cancelJob(j)}>Cancel (only while queued)</button>}
                {j.state !== 'running' && j.state !== 'queued' && <button className="btn small" onClick={() => retry(j)}>Edit and try again</button>}
              </div>
            </div>
          ))}
          {views.length > 0 && <div className="asset-meta">“Edit and try again” opens the form with the same choices; you approve the price again. A paid request is never re-sent by itself. Gemini, OpenAI and Recraft cannot be stopped once sent. Higgsfield can only be cancelled while still queued.</div>}
          {finished && <button className="btn small ghost" onClick={() => saveJobs(jobs.filter((j) => j.state === 'running'))}>Clear finished (this list only; Higgsfield records stay in the project)</button>}
        </div>
      )}
    </div>
  );
}


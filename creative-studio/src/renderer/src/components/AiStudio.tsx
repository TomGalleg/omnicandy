import { useCallback, useEffect, useMemo, useState } from 'react';
import { estimateCost, formatUsd, modelById } from '@shared/generation';
import type { ProviderStatusDto } from '@shared/ipc';
import type { Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import { addJob, cardState, loadJobs, parseDraft, SURPRISE_PROMPTS, updateJob, type StudioJob } from '@shared/aiStudio';
import {
  findModels, STUDIO_PROVIDERS, studioProvider, type OutputKind, type StudioModel, type StudioOperation, type StudioProviderId,
} from '@shared/providerCapabilities';
import { PROVIDERS_CHANGED } from './ProvidersCard';
import './aiStudio.css';

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  onGoto: (w: WorkspaceId, assetId?: string) => void;
  log: (source: string, msg: string) => void;
}

type Tab = 'explore' | 'create' | 'assets' | 'jobs';
const JOBS_KEY = 'cs-studio-jobs';
const DRAFT_KEY = 'cs-studio-draft';
const REF_FORMATS = ['png', 'jpg', 'jpeg', 'webp'];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const HUES: Record<StudioProviderId, string> = { gemini: '#4f8bff', openai: '#16a37f', higgsfield: '#ff5f8a', recraft: '#c04fff', local: '#d99a1f', mock: '#7a8699' };
const OP_LABEL: Partial<Record<StudioOperation, string>> = {
  'text-to-image': 'Text → image', 'image-to-image': 'From a picture', 'reference-images': 'References', styles: 'Styles', 'color-palette': 'Palette',
  inpaint: 'Inpaint', outpaint: 'Outpaint', 'replace-background': 'New background', 'remove-background': 'Cut out', upscale: 'Upscale', vectorize: 'Vectorize', 'erase-region': 'Erase',
};
const OUTPUTS: Array<{ id: OutputKind; label: string }> = [{ id: 'raster', label: 'Pictures' }, { id: 'svg', label: 'Real SVG' }, { id: 'video', label: 'Video' }];
const FILTER_OPS: StudioOperation[] = ['text-to-image', 'image-to-image', 'styles', 'remove-background', 'upscale', 'vectorize'];

function readJobs(): StudioJob[] {
  try { return loadJobs(localStorage.getItem(JOBS_KEY)); } catch { return []; }
}

/** AI Studio: browse models across providers, create with the ready ones, see results and jobs.
 *  Generation goes through the same main-process service as the classic tab (approval dialog, spending limit,
 *  keys that never reach this window). Providers that are only documented, not connected, cannot generate. */
export function AiStudio({ manifest, selected, onGoto, log }: Props) {
  const [tab, setTab] = useState<Tab>('explore');
  const [providers, setProviders] = useState<ProviderStatusDto[] | null>(null);
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState<StudioProviderId | null>(null);
  const [output, setOutput] = useState<OutputKind | null>(null);
  const [op, setOp] = useState<StudioOperation | null>(null);
  const [pick, setPick] = useState<StudioModel | null>(null);
  const [prompt, setPrompt] = useState('');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [count, setCount] = useState(1);
  const [refId, setRefId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>(readJobs);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

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
    if (m) setPick(m);
    if (d.prompt) setPrompt(d.prompt);
    if (d.referenceAssetId) setRefId(d.referenceAssetId);
    setTab('create');
  }, []);

  const saveJobs = useCallback((next: StudioJob[]) => {
    setJobs(next);
    try { localStorage.setItem(JOBS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  }, []);

  const configured = useMemo(() => new Set((providers ?? []).filter((p) => p.configured).map((p) => p.id as string)), [providers]);
  const models = useMemo(() => findModels({
    ...(provider ? { providerId: provider } : {}), ...(output ? { output } : {}), ...(op ? { operation: op } : {}), search,
  }), [provider, output, op, search]);

  const legacy = pick && pick.availability === 'wired' ? modelById(pick.id) : undefined;
  const refAsset = manifest?.assets.find((a) => a.id === refId) ?? null;
  const job = legacy ? { modelId: legacy.id, prompt, referenceAssetIds: refAsset ? [refAsset.id] : [], settings, count: Math.min(count, legacy.maxCount) } : null;
  const estimate = useMemo(() => {
    if (!job) return null;
    try { return estimateCost({ ...job, prompt: job.prompt || 'x' }); } catch { return null; }
  }, [job?.modelId, job?.prompt, JSON.stringify(job?.settings), job?.count, job?.referenceAssetIds.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = pick ? cardState(pick, configured) : null;
  const free = legacy?.provider === 'mock';

  const choose = (m: StudioModel) => { setPick(m); setSettings({}); setCount(1); setMsg(null); setTab('create'); };

  const run = async (j: NonNullable<typeof job>, label: string, providerId: string) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const rec: StudioJob = { id, at: new Date().toISOString(), providerId, modelId: j.modelId, modelLabel: label, prompt: j.prompt, settings: j.settings, count: j.count, referenceAssetIds: j.referenceAssetIds, state: 'running' };
    let list = addJob(jobs, rec);
    saveJobs(list);
    setBusy(true); setMsg(null);
    try {
      const r = await window.studio.generate.run(j);
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

  const surprise = () => setPrompt(SURPRISE_PROMPTS[Math.floor(Math.random() * SURPRISE_PROMPTS.length)]!);
  const assets = (manifest?.assets ?? []).filter((a) => a.provenance.origin === 'generated' && a.kind !== 'video').slice().reverse();
  const readyCount = findModels({ wiredOnly: true }).filter((m) => cardState(m, configured) === 'ready').length;

  return (
    <div className="aistudio">
      <div className="as-hero">
        <h2>AI Studio</h2>
        <span className="asset-meta">Browse models, pick one that fits, and make something. {readyCount} model{readyCount === 1 ? ' is' : 's are'} ready to use right now; the rest are shown so you can see what is coming.</span>
        <div className="as-tabs" role="tablist" aria-label="AI Studio">
          {([['explore', 'Explore'], ['create', 'Create'], ['assets', 'Assets'], ['jobs', 'Jobs']] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className="as-tab" onClick={() => setTab(id)}>
              {label}{id === 'assets' && assets.length ? <span className="as-count">{assets.length}</span> : null}{id === 'jobs' && jobs.length ? <span className="as-count">{jobs.length}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {tab === 'explore' && (
        <>
          <div className="as-filters">
            <input className="as-search" aria-label="Search models" placeholder="Search models, e.g. vector, banana, soul…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {STUDIO_PROVIDERS.filter((p) => p.id !== 'local').map((p) => (
              <button key={p.id} className={`chip chip-btn${provider === p.id ? ' on' : ''}`} aria-pressed={provider === p.id} onClick={() => setProvider(provider === p.id ? null : p.id)}>{p.label}</button>
            ))}
          </div>
          <div className="as-filters">
            {OUTPUTS.map((o) => <button key={o.id} className={`chip chip-btn${output === o.id ? ' on' : ''}`} aria-pressed={output === o.id} onClick={() => setOutput(output === o.id ? null : o.id)}>{o.label}</button>)}
            {FILTER_OPS.map((o) => <button key={o} className={`chip chip-btn${op === o ? ' on' : ''}`} aria-pressed={op === o} onClick={() => setOp(op === o ? null : o)}>{OP_LABEL[o]}</button>)}
          </div>
          {models.length === 0 && <div className="asset-meta">No model matches. Clear a filter to see more.</div>}
          <div className="as-grid">
            {models.map((m) => {
              const st = cardState(m, configured);
              const p = studioProvider(m.providerId)!;
              return (
                <article key={`${m.providerId}/${m.id}`} className={`as-card ${st}`} style={{ ['--hue' as string]: HUES[m.providerId] }}>
                  <div className="as-art"><span>{m.label}</span><small>{p.label}</small></div>
                  <div className="as-body">
                    <div className="as-badges">
                      <span className={`as-badge${m.output === 'svg' ? ' svg' : ''}`}>{m.output === 'svg' ? 'Real SVG' : m.output === 'video' ? 'Video' : 'Picture'}</span>
                      <span className={`as-badge ${st === 'ready' ? 'ready' : 'warn'}`}>{st === 'ready' ? 'Ready' : st === 'needs-key' ? 'Needs a key' : 'Coming soon'}</span>
                      {m.fromUsd !== undefined && <span className="as-badge">from {formatUsd(m.fromUsd)}</span>}
                    </div>
                    <div className="as-badges">{m.operations.map((o) => OP_LABEL[o] && <span key={o} className="as-badge">{OP_LABEL[o]}</span>)}</div>
                    {m.note && <div className="asset-meta">{m.note}</div>}
                    <button className="btn small primary" disabled={st === 'soon'} onClick={() => choose(m)}>{st === 'soon' ? 'Not connected yet' : 'Create with this'}</button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {tab === 'create' && (
        <div className="as-create">
          <div className="panel-card">
            <h3>Create</h3>
            {!pick ? <div className="notice">Pick a model in <button className="btn small" onClick={() => setTab('explore')}>Explore</button> first.</div> : (
              <>
                <div><strong>{pick.label}</strong> <span className="asset-meta">{studioProvider(pick.providerId)?.label}</span> <button className="btn small ghost" onClick={() => setTab('explore')}>Change</button></div>
                {state === 'needs-key' && <div className="notice">Add your {studioProvider(pick.providerId)?.label} key in Settings → Integrations to use this model.</div>}
                {state === 'soon' && <div className="notice">{studioProvider(pick.providerId)?.label} is verified in its official docs but not connected yet, so nothing can be sent. {studioProvider(pick.providerId)?.costInfo}</div>}
                <label className="field">Prompt
                  <textarea aria-label="Prompt" value={prompt} maxLength={4000} placeholder="Describe the picture…" onChange={(e) => setPrompt(e.target.value)} />
                </label>
                <button className="btn small" onClick={surprise}>Surprise me</button>
                {legacy?.capabilities.includes('image-edit') && (
                  <div className="field">Reference picture (optional)
                    {refAsset ? <div className="ref-pick"><span className="thumb"><img src={window.studio.assetUrl(refAsset.id)} alt="" /></span><span>{refAsset.name}</span><button className="btn small ghost" onClick={() => setRefId(null)}>Clear</button></div> : <span className="asset-meta">Select a PNG, JPEG or WebP in the library, then use it here.</span>}
                    {selected && selected.id !== refAsset?.id && REF_FORMATS.includes(selected.sourceFormat) && <button className="btn small" onClick={() => setRefId(selected.id)}>Use selected: {selected.name}</button>}
                  </div>
                )}
                {legacy && (
                  <div className="gen-settings">
                    {legacy.settings.map((s) => (
                      <label key={s.key} className="field">{s.label}
                        <select value={settings[s.key] ?? s.default} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })}>
                          {s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                    ))}
                    <label className="field">Images
                      <select aria-label="Number of images" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                        {Array.from({ length: legacy.maxCount }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                      </select>
                    </label>
                  </div>
                )}
                {estimate && (
                  <div className="estimate" aria-label="Cost estimate">
                    <strong>{free ? 'Free' : `${estimate.approximate ? '≈ ' : ''}${formatUsd(estimate.amount)}`}</strong>
                    <span className="asset-meta">{free ? 'Offline test pattern. No network, no cost.' : `${job!.count} × ${formatUsd(estimate.perImage)} · ${estimate.basis}`}</span>
                  </div>
                )}
                <button className="btn primary" disabled={!job || state !== 'ready' || !prompt.trim() || busy} onClick={() => job && legacy && void run(job, legacy.label, legacy.provider)}>
                  {busy ? 'Generating…' : free ? 'Generate (free)' : 'Generate… (asks you to approve)'}
                </button>
                {!free && state === 'ready' && <div className="asset-meta">You will see the price and must approve before anything is sent. Charges go to your own provider account. A failed paid request is never retried by itself.</div>}
                {msg && <div className={`wf-msg${msg.error ? ' error' : ''}`} role="status">{msg.text}</div>}
              </>
            )}
          </div>
          <div className="as-preview">
            {busy ? <div><span className="as-spin" />Working… the picture will appear in Assets.</div>
              : assets[0] ? <div style={{ display: 'grid', gap: 8 }}><img src={window.studio.assetUrl(assets[0].id)} alt="" style={{ maxWidth: '100%', maxHeight: 420, borderRadius: 10 }} /><span className="asset-meta">Latest: {assets[0].provenance.prompt}</span></div>
              : <span className="asset-meta">Your latest picture shows up here.</span>}
          </div>
        </div>
      )}

      {tab === 'assets' && (
        <>
          {assets.length === 0 && <div className="asset-meta">Nothing yet. New pictures land here and in the library as originals, with their prompt, model and settings.</div>}
          <div className="gen-grid">
            {assets.map((a) => (
              <article key={a.id} className="gen-card">
                <button className="gen-thumb" onClick={() => onGoto('media', a.id)} aria-label={`View ${a.name}`}><img src={window.studio.assetUrl(a.id)} alt="" /></button>
                <div className="gen-body">
                  <div className="gen-prompt" title={a.provenance.prompt}>{a.provenance.prompt}</div>
                  <div className="asset-meta">{STUDIO_PROVIDERS.find((p) => p.id === a.provenance.provider)?.label ?? a.provenance.provider} · {modelById(a.provenance.model ?? '')?.label ?? a.provenance.model}{a.provenance.requestedBy === 'claude' ? ' · asked by Claude' : ''}</div>
                  <div className="asset-meta">{Object.values(a.provenance.settings ?? {}).join(' · ')}{a.width ? ` · ${a.width}×${a.height}` : ''}</div>
                  <div className="btn-row">
                    <button className="btn small primary" onClick={() => onGoto('edit', a.id)}>Open in Edit</button>
                    <button className="btn small" onClick={() => { setRefId(a.id); setTab('create'); }}>Use as reference</button>
                    <button className="btn small" onClick={() => { setPrompt(a.provenance.prompt ?? ''); setTab('create'); }}>Reuse prompt</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {tab === 'jobs' && (
        <div className="as-jobs">
          {jobs.length === 0 && <div className="asset-meta">No jobs yet. Every generation you start appears here with its result.</div>}
          {jobs.map((j) => (
            <div key={j.id} className={`as-job ${j.state}`}>
              <div className="as-state">{j.state === 'running' ? <><span className="as-spin" />Running</> : j.state === 'done' ? 'Done' : j.state === 'canceled' ? 'Canceled (nothing was sent)' : 'Failed'} · {j.modelLabel}</div>
              <div className="gen-prompt" title={j.prompt}>{j.prompt}</div>
              <div className="asset-meta">{new Date(j.at).toLocaleString()} · {j.count} image{j.count === 1 ? '' : 's'}{j.estimateUsd ? ` · est. ${formatUsd(j.estimateUsd)}` : ''}</div>
              {j.message && <div className="asset-meta">{j.message}</div>}
              <div className="btn-row">
                {j.assetIds?.[0] && <button className="btn small" onClick={() => onGoto('media', j.assetIds![0])}>Show result</button>}
                {j.state !== 'running' && <button className="btn small" onClick={() => {
                  const m = findModels({ providerId: j.providerId as StudioProviderId }).find((x) => x.id === j.modelId);
                  if (m) { setPick(m); setPrompt(j.prompt); setSettings(j.settings); setCount(j.count); setRefId(j.referenceAssetIds[0] ?? null); setTab('create'); }
                }}>Edit and try again</button>}
              </div>
            </div>
          ))}
          {jobs.length > 0 && <div className="asset-meta">Try again opens the form with the same choices; you approve the price again. A paid request is never re-sent by itself. A running request cannot be stopped from here once sent; it ends by itself or times out.</div>}
          {jobs.some((j) => j.state !== 'running') && <button className="btn small ghost" onClick={() => saveJobs(jobs.filter((j) => j.state === 'running'))}>Clear finished</button>}
        </div>
      )}
    </div>
  );
}

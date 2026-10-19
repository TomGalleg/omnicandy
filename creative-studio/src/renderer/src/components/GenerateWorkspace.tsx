import { useEffect, useMemo, useState } from 'react';
import { estimateCost, formatUsd, IMAGE_MODELS, PROVIDERS, type GenCapability, type ImageModel } from '@shared/generation';
import type { ProviderStatusDto } from '@shared/ipc';
import type { Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import { PROVIDERS_CHANGED } from './ProvidersCard';
import { VideoPanel } from './VideoPanel';
import { MotionPanel } from './MotionPanel';
import { LocalAiPanel } from './LocalAiPanel';

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  onGoto: (w: WorkspaceId, assetId?: string) => void;
  log: (source: string, msg: string) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const REF_FORMATS = ['png', 'jpg', 'jpeg', 'webp'];

/** AI Generate: bring-your-own-key providers, cost estimate, approval in main, results as new originals. */
export function GenerateWorkspace({ manifest, selected, onGoto, log }: Props) {
  // Free sources first: nothing paid is the default, and the choice is remembered per viewer.
  const [videoSource, setVideoSource] = useState<'cloud' | 'local' | 'motion'>(() => {
    try { const v = localStorage.getItem('cs-video-source'); if (v === 'cloud' || v === 'local' || v === 'motion') return v; } catch { /* storage unavailable */ }
    return 'motion';
  });
  const chooseVideoSource = (v: 'cloud' | 'local' | 'motion') => {
    setVideoSource(v);
    try { localStorage.setItem('cs-video-source', v); } catch { /* storage unavailable */ }
  };
  const [providers, setProviders] = useState<ProviderStatusDto[] | null>(null);
  const [capability, setCapability] = useState<GenCapability>('text-to-image');
  const [modelId, setModelId] = useState<string>('');
  const [prompt, setPrompt] = useState(() => {
    // Set by Home when Claude proposed a starting picture; used once.
    try { const p = window.sessionStorage.getItem('cs-generate-prompt'); if (p) { window.sessionStorage.removeItem('cs-generate-prompt'); return p; } } catch { /* storage unavailable */ }
    return '';
  });
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [count, setCount] = useState(1);
  const [refId, setRefId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    const load = () => { void window.studio.generate.providers().then(setProviders); };
    load();
    window.addEventListener(PROVIDERS_CHANGED, load); // keys are managed in Settings
    return () => window.removeEventListener(PROVIDERS_CHANGED, load);
  }, []);
  const [spend, setSpend] = useState<{ limitUsd: number | null; spentUsd: number; count: number } | null>(null);
  const [limitText, setLimitText] = useState('');
  useEffect(() => { void window.studio.generate.spending().then((s) => { setSpend(s); setLimitText(s.limitUsd === null ? '' : String(s.limitUsd)); }); }, [manifest?.assets.length]);
  const saveLimit = () => {
    const v = limitText.trim() === '' ? null : Number(limitText);
    if (v !== null && (!Number.isFinite(v) || v < 0)) { setMsg({ text: 'Enter a limit in dollars, or leave it empty for none.', error: true }); return; }
    void window.studio.generate.setSpendingLimit(v).then((s) => { setSpend(s); setMsg({ text: v === null ? 'No spending limit for this project.' : `Spending limit set to $${v.toFixed(2)} for this project.` }); }).catch((e: unknown) => setMsg({ text: String(e instanceof Error ? e.message : e), error: true }));
  };

  // Only models whose provider is ready (key saved; listed for that key once tested) and that can do the chosen job.
  const models = useMemo(() => IMAGE_MODELS.filter((m) => {
    const p = providers?.find((x) => x.id === m.provider);
    if (!p?.configured || !m.capabilities.includes(capability)) return false;
    const listed = p.lastTest?.ok ? p.lastTest.models : undefined;
    return !listed?.length || listed.includes(m.id);
  }), [providers, capability]);
  const model: ImageModel | undefined = models.find((m) => m.id === modelId) ?? models.find((m) => m.provider !== 'mock') ?? models[0];
  useEffect(() => { if (model && model.id !== modelId) { setModelId(model.id); setSettings({}); } }, [model, modelId]);

  const refAsset = capability === 'image-edit' ? manifest?.assets.find((a) => a.id === refId) ?? null : null;
  useEffect(() => {
    if (capability === 'image-edit' && !refId && selected && REF_FORMATS.includes(selected.sourceFormat)) setRefId(selected.id);
  }, [capability, refId, selected]);

  const job = model ? { modelId: model.id, prompt, referenceAssetIds: refAsset ? [refAsset.id] : [], settings, count: Math.min(count, model.maxCount) } : null;
  const estimate = useMemo(() => {
    if (!job) return null;
    try { return estimateCost({ ...job, prompt: job.prompt || 'x' }); } catch { return null; }
  }, [job?.modelId, job?.prompt, JSON.stringify(job?.settings), job?.count, job?.referenceAssetIds.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    if (!job || !model) return;
    setBusy('generate'); setMsg(null);
    try {
      const r = await window.studio.generate.run(job);
      setMsg({ text: r.message });
      log('generate', r.message);
    } catch (e) {
      const t = errText(e);
      setMsg({ text: t, error: !/cancelled/i.test(t) });
      log('generate', t);
    } finally { setBusy(null); }
  };

  const results = (manifest?.assets ?? []).filter((a) => a.provenance.origin === 'generated' && a.kind !== 'video').slice().reverse();
  const isMock = model?.provider === 'mock';
  const configuredReal = providers?.some((p) => p.billable && p.configured);

  return (
    <div className="generate">
      <div className="gen-side">
        <div className="panel-card">
          <h3>Generate</h3>
          <div className="btn-row" role="radiogroup" aria-label="What to do">
            {(['text-to-image', 'image-edit'] as const).map((c) => (
              <button key={c} role="radio" aria-checked={capability === c} className={`chip chip-btn${capability === c ? ' on' : ''}`} onClick={() => setCapability(c)}>
                {c === 'text-to-image' ? 'New image from text' : 'From a reference picture'}
              </button>
            ))}
          </div>
          <label className="field">Model
            <select value={model?.id ?? ''} onChange={(e) => { setModelId(e.target.value); setSettings({}); }} disabled={!models.length}>
              {PROVIDERS.map((p) => {
                const ms = models.filter((m) => m.provider === p.id);
                return ms.length ? <optgroup key={p.id} label={p.label}>{ms.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup> : null;
              })}
            </select>
          </label>
          {model && <div className="asset-meta">{model.note}{isMock ? '' : ` · ${model.id}`}</div>}
          {!configuredReal && <div className="notice">Add an OpenAI or Gemini key in Settings → Integrations to generate real images. Until then only the free offline <strong>Mock</strong> model is available.</div>}
          {capability === 'image-edit' && (
            <div className="field">Reference picture
              {refAsset ? (
                <div className="ref-pick"><span className="thumb"><img src={window.studio.assetUrl(refAsset.id)} alt="" /></span><span>{refAsset.name}</span><button className="btn small ghost" onClick={() => setRefId(null)}>Clear</button></div>
              ) : <span className="asset-meta">Select a PNG, JPEG or WebP file in the library, then click “Use selected”.</span>}
              {selected && selected.id !== refAsset?.id && REF_FORMATS.includes(selected.sourceFormat) && <button className="btn small" onClick={() => setRefId(selected.id)}>Use selected: {selected.name}</button>}
            </div>
          )}
          <label className="field">Prompt<textarea aria-label="Prompt" value={prompt} maxLength={4000} placeholder={capability === 'image-edit' ? 'Describe what to change or create from the reference…' : 'Describe the picture…'} onChange={(e) => setPrompt(e.target.value)} /></label>
          {model && (
            <div className="gen-settings">
              {model.settings.map((s) => (
                <label key={s.key} className="field">{s.label}
                  <select value={settings[s.key] ?? s.default} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })}>
                    {s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
              ))}
              <label className="field">Images
                <select aria-label="Number of images" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {Array.from({ length: model.maxCount }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                </select>
              </label>
            </div>
          )}
          {estimate && (
            <div className="estimate" aria-label="Cost estimate">
              <strong>{isMock ? 'Free' : `${estimate.approximate ? '≈ ' : ''}${formatUsd(estimate.amount)}`}</strong>
              <span className="asset-meta">{isMock ? 'Offline test pattern. No network, no cost.' : `${job!.count} × ${formatUsd(estimate.perImage)} · ${estimate.basis}`}</span>
            </div>
          )}
          <button className="btn primary" disabled={!job || !prompt.trim() || !!busy || (capability === 'image-edit' && !refAsset)} onClick={() => void generate()}>
            {busy === 'generate' ? 'Generating…' : isMock ? 'Generate (free)' : 'Generate… (asks you to approve)'}
          </button>
          <div className="estimate" aria-label="Spending limit">
            <label className="field">Project spending limit (USD, empty = none)
              <input inputMode="decimal" value={limitText} onChange={(e) => setLimitText(e.target.value)} onBlur={saveLimit} onKeyDown={(e) => { if (e.key === 'Enter') saveLimit(); }} placeholder="e.g. 5.00" />
            </label>
            <span className="asset-meta">{spend ? `About ${formatUsd(spend.spentUsd)} estimated so far in this project (${spend.count} paid request${spend.count === 1 ? '' : 's'}). These are estimates from OmniCandy's price tables, not confirmed charges; check your provider's billing for the actual amount.` : ''}</span>
          </div>
          {!isMock && <div className="asset-meta">You'll see the price and must approve before anything is sent. Charges go to your own provider account.</div>}
          {msg && <div className={`wf-msg${msg.error ? ' error' : ''}`} role="status">{msg.text}</div>}
        </div>

        <div className="panel-card" role="group" aria-label="Video source">
          <h3>Make video</h3>
          <div className="btn-row">
            {([['cloud', 'Cloud AI (paid)'], ['local', 'Free Local AI'], ['motion', 'Motion Effects (free, not AI)']] as const).map(([id, label]) => (
              <button key={id} className={`btn small${videoSource === id ? ' primary' : ''}`} aria-pressed={videoSource === id} onClick={() => chooseVideoSource(id)}>{label}</button>
            ))}
          </div>
          <div className="asset-meta">
            {videoSource === 'cloud' ? 'Google Veo or Runway with your own key. Costs money; you approve each price.'
              : videoSource === 'local' ? 'AI video made on this PC. Free; slower and lower quality. Needs a one-time model download.'
              : 'A camera move on one picture. Free, instant, not AI-generated.'}
          </div>
        </div>
        {videoSource === 'cloud' && <VideoPanel providers={providers} selected={selected} onGoto={onGoto} log={log} />}
        {videoSource === 'motion' && <MotionPanel selected={selected} onGoto={onGoto} log={log} />}
        {videoSource === 'local' && <LocalAiPanel />}
      </div>

      <div className="gen-results">
        <h3>Generated in this project</h3>
        {results.length === 0 && <div className="asset-meta">Nothing yet. New images land here and in the library as new originals, with their prompt and settings.</div>}
        <div className="gen-grid">
          {results.map((a) => (
            <article key={a.id} className="gen-card">
              <button className="gen-thumb" onClick={() => onGoto('media', a.id)} aria-label={`View ${a.name}`}><img src={window.studio.assetUrl(a.id)} alt="" /></button>
              <div className="gen-body">
                <div className="gen-prompt" title={a.provenance.prompt}>{a.provenance.prompt}</div>
                <div className="asset-meta">{PROVIDERS.find((p) => p.id === a.provenance.provider)?.label ?? a.provenance.provider} · {IMAGE_MODELS.find((m) => m.id === a.provenance.model)?.label ?? a.provenance.model}{a.provenance.requestedBy === 'claude' ? ' · asked by Claude' : ''}</div>
                <div className="asset-meta">{Object.values(a.provenance.settings ?? {}).filter((v) => v !== `${a.width}x${a.height}`).join(' · ')}{a.width ? ` · ${a.width}×${a.height}` : ''}{a.provenance.estimatedCostUsd ? ` · est. ${formatUsd(a.provenance.estimatedCostUsd)} for the request` : ''}</div>
                <div className="btn-row">
                  <button className="btn small primary" onClick={() => onGoto('edit', a.id)}>Open in Edit</button>
                  <button className="btn small" onClick={() => { setCapability('image-edit'); setRefId(a.id); }}>Use as reference</button>
                  <button className="btn small" onClick={() => setPrompt(a.provenance.prompt ?? '')}>Reuse prompt</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

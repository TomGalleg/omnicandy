import { useEffect, useMemo, useRef, useState } from 'react';
import { estimateCost, formatUsd, modelById } from '@shared/generation';
import { hfModel, normalizeHiggsfieldJob, type HfParamValue, type HiggsfieldJob } from '@shared/higgsfield';
import { cardState, SURPRISE_PROMPTS, type JobView } from '@shared/aiStudio';
import { estimateRecraft, recraftModel, RECRAFT_ASPECTS, RECRAFT_MAX_COUNT, type RecraftJob } from '@shared/recraft';
import { studioProvider, type StudioModel } from '@shared/providerCapabilities';
import { BRAND, CATEGORIES, categoriesOf, describeModel, modelsForTask, OP_LABEL, outputLabel, priceInfo, settingsSummary, task, taskFor, TASKS } from '@shared/studioCatalog';
import type { Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import { estimateTool, normalizeToolJob, recraftToolByModelId, type RecraftToolJob } from '@shared/recraftTools';
import { ASSET_MIME, HiggsfieldForm, MediaSlot } from './HiggsfieldForm';

export interface CreateSeed { key: number; model?: StudioModel; prompt?: string; settings?: Record<string, string>; count?: number; refId?: string | null; hf?: HiggsfieldJob }

export type RunFn = (
  j: { modelId: string; prompt: string; settings: Record<string, string>; count: number; referenceAssetIds: string[] },
  label: string, providerId: string,
  exec: () => Promise<{ assetIds: string[]; message: string; estimate: { amount: number } }>,
) => Promise<void>;

interface Props {
  manifest: ProjectManifest | null;
  selected: Asset | null;
  configured: ReadonlySet<string>;
  seed: CreateSeed;
  jobs: JobView[];
  busy: boolean;
  msg: { text: string; error?: boolean } | null;
  run: RunFn;
  submitHiggsfield: (job: HiggsfieldJob) => Promise<void>;
  cancelJob: (v: JobView) => void;
  onExplore: () => void;
  onGoto: (w: WorkspaceId, assetId?: string) => void;
}

const REF_FORMATS = ['png', 'jpg', 'jpeg', 'webp'];
const PANEL_KEY = 'cs-studio-panels';

interface Panels { left: boolean; right: boolean; lw: number; rw: number }
function loadPanels(): Panels {
  const d: Panels = { left: true, right: true, lw: 380, rw: 320 };
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_KEY) ?? 'null') as Partial<Panels> | null;
    if (v) return { left: v.left !== false, right: v.right !== false, lw: Math.min(560, Math.max(280, Number(v.lw) || d.lw)), rw: Math.min(520, Math.max(240, Number(v.rw) || d.rw)) };
  } catch { /* storage unavailable */ }
  return d;
}

function BeforeAfter({ before, after }: { before: Asset; after: Asset }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="cw-ba">
      <div className="cw-ba-stage">
        <img src={window.studio.assetUrl(before.id)} alt={`Before: ${before.name}`} />
        <img className="after" style={{ clipPath: `inset(0 0 0 ${pos}%)` }} src={window.studio.assetUrl(after.id)} alt={`After: ${after.name}`} />
        <span className="cw-ba-line" style={{ left: `${pos}%` }} />
      </div>
      <input type="range" min={0} max={100} value={pos} aria-label="Before and after" onChange={(e) => setPos(Number(e.target.value))} />
      <div className="asset-meta">Left: original · Right: result</div>
    </div>
  );
}

function Viewer({ asset }: { asset: Asset }) {
  const url = window.studio.assetUrl(asset.id);
  if (asset.kind === 'video') return <video key={asset.id} className="cw-media" src={url} controls loop playsInline />;
  if (asset.kind === 'audio') return <audio key={asset.id} src={url} controls />;
  return <img key={asset.id} className="cw-media" src={url} alt={asset.provenance.prompt ?? asset.name} />;
}

/** Create: a three-panel workspace (what you want to do and its settings / a large preview / model info and history). */
export function CreateWorkspace(p: Props) {
  const { manifest, selected, configured, seed, jobs, busy, msg } = p;
  const [taskId, setTaskId] = useState('image');
  const [showAll, setShowAll] = useState(false);
  const [pick, setPick] = useState<StudioModel | null>(null);
  const [prompt, setPrompt] = useState('');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [count, setCount] = useState(1);
  const [refId, setRefId] = useState<string | null>(null);
  const [aspect, setAspect] = useState('auto');
  const [colorsText, setColorsText] = useState('');
  const [bgText, setBgText] = useState('');
  const [strength, setStrength] = useState(0.5);
  const [stacking, setStacking] = useState<'hierarchical' | 'cut_out'>('hierarchical');
  const [hfParams, setHfParams] = useState<Record<string, HfParamValue>>({});
  const [hfInputs, setHfInputs] = useState<Record<string, string[]>>({});
  const [viewId, setViewId] = useState<string | null>(null);
  const [showBefore, setShowBefore] = useState(false);
  const [panels, setPanels] = useState<Panels>(loadPanels);
  const drag = useRef<{ side: 'l' | 'r'; x: number; w: number } | null>(null);

  const savePanels = (n: Panels) => { setPanels(n); try { localStorage.setItem(PANEL_KEY, JSON.stringify(n)); } catch { /* storage unavailable */ } };

  // A model, prompt or job handed over from Explore, Assets, Jobs or another screen replaces the form once.
  useEffect(() => {
    if (!seed.key) return;
    if (seed.model) { setPick(seed.model); setTaskId(taskFor(seed.model).id); }
    setSettings(seed.settings ?? {}); setCount(seed.count ?? 1);
    setPrompt(seed.prompt ?? ''); setRefId(seed.refId ?? null);
    setHfParams(seed.hf?.params ?? {}); setHfInputs(seed.hf?.inputs ?? {});
  }, [seed.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const assets = useMemo(() => manifest?.assets ?? [], [manifest]);
  const made = useMemo(() => assets.filter((a) => a.provenance.origin === 'generated' && (a.kind === 'image' || a.kind === 'vector' || a.kind === 'video')).slice().reverse(), [assets]);
  const latestId = made[0]?.id ?? null;
  useEffect(() => { if (latestId) setViewId(latestId); }, [latestId]);
  const viewed = assets.find((a) => a.id === viewId) ?? null;
  const original = viewed?.provenance.referenceAssetIds?.[0] ? assets.find((a) => a.id === viewed.provenance.referenceAssetIds![0]) ?? null : null;
  const canCompare = !!(viewed && original && original.kind === 'image' && viewed.kind === 'image');

  const tk = task(taskId) ?? TASKS[0]!;
  const forTask = useMemo(() => modelsForTask(tk), [tk]);
  const everything = useMemo(() => modelsForTask({ ...tk, filter: () => true }).wired, [tk]);
  const choices = showAll ? everything : forTask.wired;
  const model = pick && (showAll || forTask.wired.some((m) => m.providerId === pick.providerId && m.id === pick.id)) ? pick : null;
  const state = model ? cardState(model, configured) : null;

  const legacy = model && model.availability === 'wired' ? modelById(model.id) : undefined;
  const rmodel = model?.providerId === 'recraft' ? recraftModel(model.id) : undefined;
  const hf = model?.providerId === 'higgsfield' ? hfModel(model.id) : undefined;
  const refAsset = assets.find((a) => a.id === refId) ?? null;
  const free = legacy?.provider === 'mock';

  const lj = legacy ? { modelId: legacy.id, prompt, referenceAssetIds: refAsset ? [refAsset.id] : [], settings, count: Math.min(count, legacy.maxCount) } : null;
  const lest = useMemo(() => { if (!lj) return null; try { return estimateCost({ ...lj, prompt: lj.prompt || 'x' }); } catch { return null; } }, [lj?.modelId, lj?.prompt, JSON.stringify(lj?.settings), lj?.count, lj?.referenceAssetIds.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const rj: RecraftJob | null = rmodel ? { modelId: rmodel.id, prompt, count: Math.min(count, RECRAFT_MAX_COUNT), aspect, colors: colorsText.split(/[\s,]+/).filter(Boolean), background: bgText.trim() } : null;
  const rcheck = useMemo(() => { if (!rj) return { estimate: null, error: null as string | null }; try { return { estimate: estimateRecraft({ ...rj, prompt: rj.prompt || 'x' }), error: null }; } catch (e) { return { estimate: null, error: e instanceof Error ? e.message : String(e) }; } }, [rj?.modelId, rj?.count, rj?.aspect, colorsText, bgText]); // eslint-disable-line react-hooks/exhaustive-deps
  const rtool = model?.providerId === 'recraft' ? recraftToolByModelId(model.id) : undefined;
  const tj: RecraftToolJob | null = rtool ? { toolId: rtool.id, assetId: refId ?? '', prompt, strength, count: Math.min(count, 4), shapeStacking: stacking } : null;
  const tcheck = useMemo(() => {
    if (!tj) return { estimate: null, error: null as string | null };
    try { normalizeToolJob({ ...tj, assetId: tj.assetId || 'x', prompt: tj.prompt || (rtool!.needsPrompt ? '' : 'x') }); return { estimate: estimateTool({ ...tj, assetId: tj.assetId || 'x', prompt: tj.prompt || 'x' }), error: null }; } catch (e) { return { estimate: null, error: e instanceof Error ? e.message : String(e) }; }
  }, [tj?.toolId, tj?.prompt, tj?.strength, tj?.count, tj?.shapeStacking]); // eslint-disable-line react-hooks/exhaustive-deps
  const hj: HiggsfieldJob | null = hf ? { modelId: hf.id, prompt, params: hfParams, inputs: hfInputs } : null;
  const hcheck = useMemo(() => { if (!hj) return null; try { normalizeHiggsfieldJob(hj); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } }, [hj?.modelId, prompt, hfParams, hfInputs]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseModel = (m: StudioModel) => { setPick(m); setSettings({}); setCount(1); setHfParams({}); setHfInputs({}); };
  const chooseTask = (id: string) => {
    setTaskId(id);
    const t = task(id)!;
    const w = modelsForTask(t).wired;
    if (!showAll && !(pick && w.some((m) => m.providerId === pick.providerId && m.id === pick.id))) { const first = w.find((m) => cardState(m, configured) === 'ready') ?? w[0]; if (first) chooseModel(first); else setPick(null); }
  };

  const promptOk = hf ? hf.prompt === 'optional' || prompt.trim().length > 0 : rtool ? !rtool.needsPrompt || prompt.trim().length > 0 : prompt.trim().length > 0;
  const ready = state === 'ready' && promptOk && !busy && (lj ? true : rj ? !rcheck.error : tj ? !!refId && !tcheck.error : hj ? !hcheck : false);
  const generate = () => {
    if (lj && legacy) void p.run(lj, legacy.label, legacy.provider, () => window.studio.generate.run(lj));
    else if (rj && rmodel) {
      const r = rj;
      void p.run({ modelId: r.modelId, prompt: r.prompt, count: r.count, referenceAssetIds: [], settings: { shape: r.aspect, ...(r.colors.length ? { colors: r.colors.join(' ') } : {}), ...(r.background ? { background: r.background } : {}) } }, rmodel.label, 'recraft', () => window.studio.generate.recraftRun(r));
    } else if (tj && rtool) {
      const t = tj;
      void p.run({ modelId: model!.id, prompt: t.prompt || rtool.blurb, count: rtool.perImage ? t.count : 1, referenceAssetIds: [t.assetId], settings: { tool: rtool.label, ...(rtool.hasStrength ? { strength: String(t.strength) } : {}) } }, rtool.label, 'recraft', () => window.studio.generate.recraftToolRun(t));
    } else if (hj) void p.submitHiggsfield(hj);
  };

  const modelJobs = jobs.filter((j) => model && j.providerId === model.providerId && j.modelId === model.id).slice(0, 6);
  const active = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
  const price = model ? priceInfo(model) : null;

  const startDrag = (side: 'l' | 'r') => (e: React.PointerEvent) => { drag.current = { side, x: e.clientX, w: side === 'l' ? panels.lw : panels.rw }; (e.target as HTMLElement).setPointerCapture(e.pointerId); };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.x;
    if (d.side === 'l') savePanels({ ...panels, lw: Math.min(560, Math.max(280, d.w + dx)) }); else savePanels({ ...panels, rw: Math.min(520, Math.max(240, d.w - dx)) });
  };
  const key = (side: 'l' | 'r') => (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0; if (!step) return;
    if (side === 'l') savePanels({ ...panels, lw: Math.min(560, Math.max(280, panels.lw + step)) }); else savePanels({ ...panels, rw: Math.min(520, Math.max(240, panels.rw - step)) });
  };

  const cols = `${panels.left ? `${panels.lw}px 6px` : '34px 0'} minmax(0,1fr) ${panels.right ? `6px ${panels.rw}px` : '0 34px'}`;

  return (
    <div className="cw" style={{ gridTemplateColumns: cols }}>
      {/* ---------- left: what to make, and how ---------- */}
      <section className={`cw-left${panels.left ? '' : ' collapsed'}`} aria-label="Create controls">
        <button className="cw-fold" aria-expanded={panels.left} aria-label={panels.left ? 'Collapse controls' : 'Expand controls'} onClick={() => savePanels({ ...panels, left: !panels.left })}>{panels.left ? '‹' : '›'}</button>
        {panels.left && (
          <div className="cw-scroll">
            <div className="cw-tasks" role="radiogroup" aria-label="What do you want to do?">
              {TASKS.map((t) => {
                const n = modelsForTask(t).wired.length;
                return (
                  <button key={t.id} role="radio" aria-checked={taskId === t.id} className={`cw-task${taskId === t.id ? ' on' : ''}${n === 0 ? ' none' : ''}`} onClick={() => chooseTask(t.id)} title={n === 0 ? `${t.hint} No connected model yet.` : t.hint}>
                    {t.label}{n === 0 && <small>soon</small>}
                  </button>
                );
              })}
            </div>

            <div className="field">Model
              <div className="cw-models">
                {choices.map((m) => {
                  const st = cardState(m, configured);
                  const on = model?.providerId === m.providerId && model.id === m.id;
                  return (
                    <button key={`${m.providerId}/${m.id}`} className={`cw-model${on ? ' on' : ''}`} style={{ ['--hue' as string]: BRAND[m.providerId].hue }} aria-pressed={on} onClick={() => chooseModel(m)}>
                      <i>{BRAND[m.providerId].mark}</i><span><strong>{m.label}</strong><small>{priceInfo(m).text}{st === 'needs-key' ? ' · needs a key' : ''}</small></span>
                    </button>
                  );
                })}
                {choices.length === 0 && (
                  <div className="notice">No connected model does “{tk.label}” yet.{forTask.planned.length > 0 && <> Documented but not connected: {forTask.planned.map((m) => m.label).join(', ')}.</>} <button className="btn small" onClick={p.onExplore}>Browse models</button></div>
                )}
              </div>
              <label className="hf-check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />Show every connected model, whatever the task</label>
            </div>

            {model && state === 'needs-key' && <div className="notice">Add your {studioProvider(model.providerId)?.label} key in Settings → Integrations to use this model.</div>}

            {model && (
              <>
                {rtool && (
                  <>
                    <MediaSlot spec={{ key: 'source', kind: 'image', label: 'Picture to work on', many: false, max: 1, required: true }} accept={rtool.formats} ids={refId ? [refId] : []} assets={assets} selected={selected} onChange={(ids) => setRefId(ids[0] ?? null)} />
                    <div className="asset-meta">Needs {rtool.formats.map((f) => f.toUpperCase()).join(', ')}, each side {rtool.minSide}–{rtool.maxSide} pixels. Your original is never changed: the result is a new file.</div>
                  </>
                )}
                {!(rtool && !rtool.needsPrompt) && (
                  <>
                    <label className="field">{hf?.prompt === 'optional' ? 'Prompt (optional)' : rtool ? 'What should change?' : 'Prompt'}
                      <textarea aria-label="Prompt" value={prompt} maxLength={hf ? 10000 : rtool ? 1000 : 4000} placeholder={model.output === 'video' ? 'Describe the motion and the scene…' : rtool ? 'e.g. make it autumn, golden light…' : 'Describe the picture…'} onChange={(e) => setPrompt(e.target.value)} />
                    </label>
                    {!rtool && <button className="btn small" onClick={() => setPrompt(SURPRISE_PROMPTS[Math.floor(Math.random() * SURPRISE_PROMPTS.length)]!)}>Surprise me</button>}
                  </>
                )}
                {rtool && (
                  <div className="gen-settings">
                    {rtool.hasStrength && <label className="field">How much to change ({Math.round(strength * 100)}%)<input type="range" min={0} max={1} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} /><small className="asset-meta">Low stays close to your picture; high is least similar.</small></label>}
                    {rtool.perImage && <label className="field">Results<select aria-label="Number of results" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>}
                    {rtool.id === 'vectorize' && <label className="field">Shapes<select value={stacking} onChange={(e) => setStacking(e.target.value as 'hierarchical' | 'cut_out')}><option value="hierarchical">Layered (default)</option><option value="cut_out">Not overlapping (cutters, plotters, screen printing)</option></select></label>}
                  </div>
                )}

                {legacy?.capabilities.includes('image-edit') && (
                  <div className="field">Reference picture (optional)
                    {refAsset ? <div className="ref-pick"><span className="thumb"><img src={window.studio.assetUrl(refAsset.id)} alt="" /></span><span>{refAsset.name}</span><button className="btn small ghost" onClick={() => setRefId(null)}>Clear</button></div>
                      : <div className="hf-drop" onDragOver={(e) => { if (e.dataTransfer.types.includes(ASSET_MIME)) e.preventDefault(); }} onDrop={(e) => { const id = e.dataTransfer.getData(ASSET_MIME); const a = assets.find((x) => x.id === id); if (a && REF_FORMATS.includes(a.sourceFormat)) { e.preventDefault(); setRefId(a.id); } }}><span className="asset-meta">Select a PNG, JPEG or WebP in the library, or drag one here from Recent results.</span></div>}
                    {selected && selected.id !== refAsset?.id && REF_FORMATS.includes(selected.sourceFormat) && <button className="btn small" onClick={() => setRefId(selected.id)}>Use selected: {selected.name}</button>}
                  </div>
                )}
                {legacy && (
                  <div className="gen-settings">
                    {legacy.settings.map((s) => (
                      <label key={s.key} className="field">{s.label}
                        <select value={settings[s.key] ?? s.default} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })}>{s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                      </label>
                    ))}
                    <label className="field">Images<select aria-label="Number of images" value={count} onChange={(e) => setCount(Number(e.target.value))}>{Array.from({ length: legacy.maxCount }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
                  </div>
                )}
                {rmodel && rj && (
                  <>
                    <div className="gen-settings">
                      <label className="field">Shape<select value={aspect} onChange={(e) => setAspect(e.target.value)}>{RECRAFT_ASPECTS.map((a) => <option key={a} value={a}>{a === 'auto' ? 'Let Recraft choose' : a}</option>)}</select></label>
                      <label className="field">Images<select aria-label="Number of images" value={count} onChange={(e) => setCount(Number(e.target.value))}>{Array.from({ length: RECRAFT_MAX_COUNT }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
                    </div>
                    <details className="hf-adv"><summary>Colours</summary>
                      <label className="field">Preferred colours (up to 10, like #ff6600 #1a1a1a)<input value={colorsText} onChange={(e) => setColorsText(e.target.value)} placeholder="#ff6600 #1a1a1a" /></label>
                      <label className="field">Background colour (optional)<input value={bgText} onChange={(e) => setBgText(e.target.value)} placeholder="#ffffff" /></label>
                    </details>
                  </>
                )}
                {hf && <HiggsfieldForm model={hf} params={hfParams} inputs={hfInputs} assets={assets} selected={selected} setParams={setHfParams} setInputs={setHfInputs} />}

                {rcheck.error && <div className="wf-msg error">{rcheck.error}</div>}
                {tj && tcheck.error && (refId || prompt.trim()) && <div className="asset-meta">{tcheck.error}</div>}
                {tcheck.estimate && tj && <div className="estimate" aria-label="Cost estimate"><strong>≈ {formatUsd(tcheck.estimate.amount)}</strong><span className="asset-meta">{rtool!.perImage ? `${tj.count} × ${formatUsd(tcheck.estimate.perImage)} · ` : ''}{tcheck.estimate.basis}{rtool!.output === 'svg' ? ' The result is a real, editable SVG.' : ''}</span></div>}
                {hcheck && prompt.trim() && <div className="asset-meta">{hcheck}</div>}
                {rcheck.estimate && rj && <div className="estimate" aria-label="Cost estimate"><strong>≈ {formatUsd(rcheck.estimate.amount)}</strong><span className="asset-meta">{rj.count} × {formatUsd(rcheck.estimate.perImage)} · {rcheck.estimate.basis}{rmodel!.output === 'svg' ? ' The result is a real, editable SVG, not a picture.' : ''}</span></div>}
                {lest && lj && <div className="estimate" aria-label="Cost estimate"><strong>{free ? 'Free' : `${lest.approximate ? '≈ ' : ''}${formatUsd(lest.amount)}`}</strong><span className="asset-meta">{free ? 'Offline test pattern. No network, no cost.' : `${lj.count} × ${formatUsd(lest.perImage)} · ${lest.basis}`}</span></div>}
                {hf && price && <div className="estimate" aria-label="Cost estimate"><strong>Price not published</strong><span className="asset-meta">Higgsfield publishes no price, so OmniCandy cannot show one. You will see this on the approval card; the cost is charged to your Higgsfield balance. A project with a spending limit refuses Higgsfield requests.</span></div>}

                <button className="btn primary cw-go" disabled={!ready} onClick={generate}>{busy ? 'Working…' : free ? 'Generate (free)' : 'Generate… (asks you to approve)'}</button>
                {!free && state === 'ready' && <div className="asset-meta">You will see the price and must approve before anything is sent. Charges go to your own provider account. A failed paid request is never retried by itself.</div>}
                {msg && <div className={`wf-msg${msg.error ? ' error' : ''}`} role="status">{msg.text}</div>}
              </>
            )}
          </div>
        )}
      </section>
      <div className="cw-handle" role="separator" aria-orientation="vertical" aria-label="Resize controls" tabIndex={0} hidden={!panels.left} onPointerDown={startDrag('l')} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onKeyDown={key('l')} />

      {/* ---------- centre: the result ---------- */}
      <section className="cw-center" aria-label="Preview">
        <div className="cw-stage">
          {busy && <div className="cw-working"><span className="as-spin" />Waiting for approval or for the provider…</div>}
          {active.length > 0 && !busy && <div className="cw-working"><span className="as-spin" />{active.length} job{active.length === 1 ? '' : 's'} running. You can keep working; results appear here and in Assets.</div>}
          {viewed
            ? (showBefore && canCompare && original ? <BeforeAfter before={original} after={viewed} /> : <Viewer asset={viewed} />)
            : (
              <div className="cw-empty">
                <div className="cw-orbs" aria-hidden="true"><i /><i /><i /></div>
                <strong>Your creations appear here</strong>
                <span className="asset-meta">Pick what you want to make on the left, write a prompt and press Generate. Pictures, SVG and videos open in this large preview.</span>
              </div>
            )}
        </div>
        {viewed && (
          <div className="cw-viewbar">
            <span className="asset-meta" title={viewed.provenance.prompt}>{viewed.provenance.prompt ? `“${viewed.provenance.prompt.slice(0, 90)}${viewed.provenance.prompt.length > 90 ? '…' : ''}”` : viewed.name}</span>
            {canCompare && <button className={`btn small${showBefore ? ' primary' : ''}`} aria-pressed={showBefore} onClick={() => setShowBefore(!showBefore)}>Before / after</button>}
            <button className="btn small primary" onClick={() => p.onGoto(viewed.kind === 'video' ? 'media' : 'edit', viewed.id)}>{viewed.kind === 'video' ? 'Open in Media' : viewed.kind === 'vector' ? 'Open in VectorCraft' : 'Open in Edit'}</button>
            <button className="btn small" onClick={() => { setPrompt(viewed.provenance.prompt ?? ''); }}>Reuse prompt</button>
            {viewed.kind === 'image' && <button className="btn small" onClick={() => setRefId(viewed.id)}>Use as reference</button>}
          </div>
        )}
        {made.length > 1 && (
          <div className="cw-strip" role="list" aria-label="Recent results">
            {made.slice(0, 24).map((a) => (
              <button key={a.id} role="listitem" className={`cw-thumb${a.id === viewId ? ' on' : ''}`} draggable onDragStart={(e) => e.dataTransfer.setData(ASSET_MIME, a.id)} onClick={() => setViewId(a.id)} title={a.provenance.prompt ?? a.name} aria-label={`Show ${a.name}`}>
                {a.kind === 'video' ? <video src={window.studio.assetUrl(a.id)} muted preload="metadata" /> : <img src={window.studio.assetUrl(a.id)} alt="" loading="lazy" />}
                {a.kind === 'video' && <span className="cw-play">▶</span>}
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="cw-handle" role="separator" aria-orientation="vertical" aria-label="Resize details" tabIndex={0} hidden={!panels.right} onPointerDown={startDrag('r')} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onKeyDown={key('r')} />

      {/* ---------- right: about the model, history, details ---------- */}
      <section className={`cw-right${panels.right ? '' : ' collapsed'}`} aria-label="Model information and history">
        <button className="cw-fold" aria-expanded={panels.right} aria-label={panels.right ? 'Collapse details' : 'Expand details'} onClick={() => savePanels({ ...panels, right: !panels.right })}>{panels.right ? '›' : '‹'}</button>
        {panels.right && (
          <div className="cw-scroll">
            {model ? (
              <>
                <h3>{model.label}</h3>
                <div className="asset-meta">{studioProvider(model.providerId)?.label} · {outputLabel(model.output)}</div>
                <p>{describeModel(model)}</p>
                <div className="as-badges">{model.operations.map((o) => <span key={o} className="as-badge">{OP_LABEL[o]}</span>)}</div>
                <div className="as-badges">{categoriesOf(model).map((c) => <span key={c} className="as-badge">{CATEGORIES.find((x) => x.id === c)!.label}</span>)}</div>
                <p className={price?.known ? '' : 'asset-meta'}>{price?.text}. {studioProvider(model.providerId)?.costInfo}</p>
                <p className="asset-meta">Stopping a job: {studioProvider(model.providerId)?.cancel}</p>
                {studioProvider(model.providerId)?.connection && <p className="asset-meta">{studioProvider(model.providerId)?.connection}</p>}
                {settingsSummary(model).length > 0 && <details className="hf-adv"><summary>What you can change</summary><ul className="mg-list">{settingsSummary(model).map((s) => <li key={s}>{s}</li>)}</ul></details>}
              </>
            ) : <p className="asset-meta">Choose a model to see what it can do, what it costs and how it bills.</p>}

            {viewed && (
              <>
                <h4>This result</h4>
                <div className="asset-meta">{viewed.name}{viewed.width ? ` · ${viewed.width}×${viewed.height}` : ''}</div>
                <div className="asset-meta">{studioProvider(viewed.provenance.provider ?? '')?.label ?? viewed.provenance.provider} · {viewed.provenance.model}</div>
                {viewed.provenance.settings && Object.keys(viewed.provenance.settings).length > 0 && <div className="asset-meta">{Object.entries(viewed.provenance.settings).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>}
                {viewed.provenance.estimatedCostUsd !== undefined && <div className="asset-meta">Estimated cost {formatUsd(viewed.provenance.estimatedCostUsd)}</div>}
              </>
            )}

            <h4>History{model ? ' for this model' : ''}</h4>
            {(modelJobs.length ? modelJobs : jobs.slice(0, 6)).length === 0 && <span className="asset-meta">Nothing yet.</span>}
            {(modelJobs.length ? modelJobs : jobs.slice(0, 6)).map((j) => (
              <div key={j.id} className={`cw-job ${j.state}`}>
                <div><strong>{j.state === 'queued' ? 'Queued' : j.state === 'running' ? 'Running' : j.state === 'done' ? 'Done' : j.state === 'canceled' ? 'Cancelled' : j.state === 'moderated' ? 'Blocked' : 'Failed'}</strong> · {j.modelLabel}</div>
                <div className="gen-prompt" title={j.prompt}>{j.prompt || '(no prompt)'}</div>
                {j.message && <div className="asset-meta">{j.message}</div>}
                <div className="btn-row">
                  {j.assetIds[0] && <button className="btn small" onClick={() => setViewId(j.assetIds[0]!)}>Show</button>}
                  {j.cancellable && <button className="btn small" onClick={() => p.cancelJob(j)}>Cancel (queued only)</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

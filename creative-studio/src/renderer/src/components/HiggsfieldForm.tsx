import { useEffect, useState } from 'react';
import type { Asset } from '@shared/types';
import type { HfInput, HfInputKind, HfModel, HfParam, HfParamValue, HfStyle } from '@shared/higgsfield';
import { importDropped, isFileDrag } from '../importFiles';

export const ASSET_MIME = 'application/x-omnicandy-asset';

const FORMATS: Record<HfInputKind, string[]> = { image: ['png', 'jpg', 'jpeg', 'webp', 'gif'], video: ['mp4'], audio: ['wav'] };
const FORMAT_HELP: Record<HfInputKind, string> = { image: 'PNG, JPEG, WebP or GIF pictures', video: 'MP4 videos', audio: 'WAV sounds' };
export const fitsKind = (a: Asset, kind: HfInputKind) => FORMATS[kind].includes(a.sourceFormat.toLowerCase());

function Thumb({ a, kind }: { a: Asset; kind: HfInputKind }) {
  return kind === 'image'
    ? <span className="thumb"><img src={window.studio.assetUrl(a.id)} alt="" /></span>
    : <span className="thumb hf-file" aria-hidden="true">{kind === 'video' ? '▶' : '♪'}</span>;
}

interface InputProps {
  spec: HfInput;
  /** File extensions this slot takes, when they differ from the kind's usual list (Recraft tools take SVG, not GIF). */
  accept?: string[];
  ids: string[];
  assets: Asset[];
  selected: Asset | null;
  onChange: (ids: string[]) => void;
}

/** One media input (a picture, a video, a sound). Assets are chosen from the project library or dragged in from the strip. */
export function MediaSlot({ spec, accept, ids, assets, selected, onChange }: InputProps) {
  const fits = (a: Asset) => (accept ? accept.includes(a.sourceFormat.toLowerCase()) : fitsKind(a, spec.kind));
  const chosen = ids.map((id) => assets.find((a) => a.id === id)).filter((a): a is Asset => !!a);
  const candidates = assets.filter((a) => fits(a) && !ids.includes(a.id)).slice(-24).reverse();
  const room = ids.length < spec.max;
  const [dropMsg, setDropMsg] = useState('');
  const add = (id: string) => { if (!room || ids.includes(id)) return; onChange(spec.many ? [...ids, id] : [id]); };
  return (
    <div className="field hf-slot">
      <span>{spec.label}{spec.required ? ' *' : ''} <small className="asset-meta">{spec.many ? `${ids.length}/${spec.max}` : ''}</small></span>
      <div className="hf-drop" onDragOver={(e) => { if (e.dataTransfer.types.includes(ASSET_MIME) || isFileDrag(e)) e.preventDefault(); }}
        onDrop={(e) => {
          if (isFileDrag(e)) {
            // Files from the computer: copied into the library, then used right here.
            e.preventDefault(); e.stopPropagation();
            void importDropped(e.dataTransfer.files).then((r) => {
              const found = [...r.result.imported.filter(fits).map((a) => a.id), ...r.result.duplicates.map((d) => d.duplicateOf).filter((id) => { const a = assets.find((x) => x.id === id); return !a || fits(a); })];
              const next = spec.many ? [...ids, ...found.filter((id) => !ids.includes(id))].slice(0, spec.max) : found.slice(0, 1);
              if (next.length) onChange(next);
              setDropMsg(found.length ? r.text : `${r.text} None of them fit "${spec.label}".`);
            }).catch((err: unknown) => setDropMsg(err instanceof Error ? err.message : String(err)));
            return;
          }
          const id = e.dataTransfer.getData(ASSET_MIME); if (id) { e.preventDefault(); const a = assets.find((x) => x.id === id); if (a && fits(a)) add(a.id); }
        }}>
        {chosen.length === 0 && <span className="asset-meta">Drop a file here from your computer or from the strip below, or click one.</span>}
        {chosen.map((a) => (
          <span key={a.id} className="hf-chosen">
            <Thumb a={a} kind={spec.kind} /><span className="hf-name" title={a.name}>{a.name}</span>
            <button className="btn small ghost" aria-label={`Remove ${a.name}`} onClick={() => onChange(ids.filter((x) => x !== a.id))}>×</button>
          </span>
        ))}
      </div>
      {dropMsg && <span className="asset-meta" role="status">{dropMsg}</span>}
      {room && selected && fits(selected) && !ids.includes(selected.id) && <button className="btn small" onClick={() => add(selected.id)}>Use selected: {selected.name}</button>}
      {room && (candidates.length > 0
        ? <div className="hf-strip" role="list" aria-label={`Library files for ${spec.label}`}>
          {candidates.map((a) => (
            <button key={a.id} role="listitem" className="hf-cand" draggable title={`Add ${a.name}`} onDragStart={(e) => e.dataTransfer.setData(ASSET_MIME, a.id)} onClick={() => add(a.id)}>
              <Thumb a={a} kind={spec.kind} />
            </button>
          ))}
        </div>
        : <span className="asset-meta">No {FORMAT_HELP[spec.kind]} in this project yet. Import or generate one first.</span>)}
    </div>
  );
}

const STYLE_CACHE = new Map<string, HfStyle[]>();

/** Soul styles: loaded from Higgsfield with the saved key (free), shown as small pictures. No choice means Higgsfield's default style. */
function StylePicker({ modelId, value, onChange }: { modelId: string; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const [styles, setStyles] = useState<HfStyle[] | null>(STYLE_CACHE.get(modelId) ?? null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (STYLE_CACHE.has(modelId)) { setStyles(STYLE_CACHE.get(modelId)!); return; }
    let live = true;
    setStyles(null); setError('');
    window.studio.generate.higgsfieldStyles(modelId)
      .then((l) => { STYLE_CACHE.set(modelId, l); if (live) setStyles(l); })
      .catch((e: unknown) => { if (live) setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
    return () => { live = false; };
  }, [modelId]);
  return (
    <div className="field">Style
      {error && <span className="asset-meta">Could not load the styles ({error}). Higgsfield's default style will be used.</span>}
      {!error && !styles && <span className="asset-meta"><span className="as-spin" />Loading styles from Higgsfield…</span>}
      {styles && styles.length === 0 && <span className="asset-meta">Higgsfield returned no styles. Its default style will be used.</span>}
      {styles && styles.length > 0 && (
        <div className="hf-styles" role="listbox" aria-label="Style">
          <button role="option" aria-selected={!value} className={`hf-style${!value ? ' on' : ''}`} onClick={() => onChange(undefined)}><span className="hf-style-pic hf-style-none">Default</span><small>Default</small></button>
          {styles.map((s) => (
            <button key={s.id} role="option" aria-selected={value === s.id} className={`hf-style${value === s.id ? ' on' : ''}`} title={s.description || s.name} onClick={() => onChange(s.id)}>
              <span className="hf-style-pic">{s.preview ? <img src={s.preview} alt="" loading="lazy" /> : s.name.slice(0, 2)}</span><small>{s.name}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ParamField({ p, value, modelId, onChange }: { p: HfParam; value: HfParamValue | undefined; modelId: string; onChange: (v: HfParamValue | undefined) => void }) {
  const v = value ?? p.default;
  if (p.type === 'style') return <StylePicker modelId={modelId} value={typeof value === 'string' ? value : undefined} onChange={onChange} />;
  if (p.type === 'bool') return <label className="field hf-check"><input type="checkbox" checked={v === true} onChange={(e) => onChange(e.target.checked)} />{p.label}</label>;
  if (p.type === 'enum') {
    return (
      <label className="field">{p.label}
        <select value={String(v ?? '')} onChange={(e) => { const o = p.options!.find((x) => String(x) === e.target.value); onChange(o); }}>
          {p.default === undefined && <option value="">Default</option>}
          {p.options!.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
        </select>
      </label>
    );
  }
  if (p.type === 'text' || p.type === 'colors' || p.type === 'color') return <label className="field">{p.label}<input value={String(v ?? '')} maxLength={2000} placeholder={p.type === 'colors' ? '#ff6600 #1a1a1a' : p.type === 'color' ? '#ffffff' : undefined} onChange={(e) => onChange(e.target.value)} /></label>;
  return (
    <label className="field">{p.label}{p.min !== undefined && p.max !== undefined ? <small className="asset-meta"> {p.min}–{p.max}</small> : null}
      <input type="number" min={p.min} max={p.max} step={p.step ?? 1} value={v === undefined ? '' : Number(v)} placeholder={p.default === undefined ? 'Default' : undefined}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    </label>
  );
}

interface FormProps {
  model: HfModel;
  params: Record<string, HfParamValue>;
  inputs: Record<string, string[]>;
  assets: Asset[];
  selected: Asset | null;
  setParams: (p: Record<string, HfParamValue>) => void;
  setInputs: (i: Record<string, string[]>) => void;
}

/** Settings and media inputs for a Higgsfield model, built from the model's documented parameters (nothing hand-coded per model). */
export function HiggsfieldForm({ model, params, inputs, assets, selected, setParams, setInputs }: FormProps) {
  const set = (k: string, v: HfParamValue | undefined) => { const n = { ...params }; if (v === undefined) delete n[k]; else n[k] = v; setParams(n); };
  const styleParam = model.params.find((p) => p.type === 'style');
  const others = model.params.filter((p) => p.type !== 'style');
  const basic = others.slice(0, 3);
  const more = others.slice(3);
  return (
    <>
      {model.inputs.map((spec) => (
        <MediaSlot key={spec.key} spec={spec} ids={inputs[spec.key] ?? []} assets={assets} selected={selected} onChange={(ids) => setInputs({ ...inputs, [spec.key]: ids })} />
      ))}
      {model.anyOf && <div className="asset-meta">Add at least one of: {model.anyOf.map((k) => model.inputs.find((i) => i.key === k)!.label.toLowerCase()).join(', ')}.</div>}
      {styleParam && <ParamField p={styleParam} value={params[styleParam.key]} modelId={model.id} onChange={(v) => set(styleParam.key, v)} />}
      <div className="gen-settings">{basic.map((p) => <ParamField key={p.key} p={p} value={params[p.key]} modelId={model.id} onChange={(v) => set(p.key, v)} />)}</div>
      {more.length > 0 && (
        <details className="hf-adv"><summary>Advanced settings</summary>
          <div className="gen-settings">{more.map((p) => <ParamField key={p.key} p={p} value={params[p.key]} modelId={model.id} onChange={(v) => set(p.key, v)} />)}</div>
        </details>
      )}
      {model.note && <div className="asset-meta">{model.note}</div>}
    </>
  );
}

import type { Asset } from '@shared/types';
import type { HfInput, HfInputKind, HfModel, HfParam, HfParamValue } from '@shared/higgsfield';

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
  const add = (id: string) => { if (!room || ids.includes(id)) return; onChange(spec.many ? [...ids, id] : [id]); };
  return (
    <div className="field hf-slot">
      <span>{spec.label}{spec.required ? ' *' : ''} <small className="asset-meta">{spec.many ? `${ids.length}/${spec.max}` : ''}</small></span>
      <div className="hf-drop" onDragOver={(e) => { if (e.dataTransfer.types.includes(ASSET_MIME)) e.preventDefault(); }}
        onDrop={(e) => { const id = e.dataTransfer.getData(ASSET_MIME); if (id) { e.preventDefault(); const a = assets.find((x) => x.id === id); if (a && fits(a)) add(a.id); } }}>
        {chosen.length === 0 && <span className="asset-meta">Drop a file from the strip below, or click one.</span>}
        {chosen.map((a) => (
          <span key={a.id} className="hf-chosen">
            <Thumb a={a} kind={spec.kind} /><span className="hf-name" title={a.name}>{a.name}</span>
            <button className="btn small ghost" aria-label={`Remove ${a.name}`} onClick={() => onChange(ids.filter((x) => x !== a.id))}>×</button>
          </span>
        ))}
      </div>
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

function ParamField({ p, value, onChange }: { p: HfParam; value: HfParamValue | undefined; onChange: (v: HfParamValue | undefined) => void }) {
  const v = value ?? p.default;
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
  const basic = model.params.slice(0, 3);
  const more = model.params.slice(3);
  return (
    <>
      {model.inputs.map((spec) => (
        <MediaSlot key={spec.key} spec={spec} ids={inputs[spec.key] ?? []} assets={assets} selected={selected} onChange={(ids) => setInputs({ ...inputs, [spec.key]: ids })} />
      ))}
      {model.anyOf && <div className="asset-meta">Add at least one of: {model.anyOf.map((k) => model.inputs.find((i) => i.key === k)!.label.toLowerCase()).join(', ')}.</div>}
      <div className="gen-settings">{basic.map((p) => <ParamField key={p.key} p={p} value={params[p.key]} onChange={(v) => set(p.key, v)} />)}</div>
      {more.length > 0 && (
        <details className="hf-adv"><summary>Advanced settings</summary>
          <div className="gen-settings">{more.map((p) => <ParamField key={p.key} p={p} value={params[p.key]} onChange={(v) => set(p.key, v)} />)}</div>
        </details>
      )}
      {model.note && <div className="asset-meta">{model.note}</div>}
    </>
  );
}

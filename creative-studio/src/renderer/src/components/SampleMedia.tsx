import { useEffect, useMemo, useState } from 'react';
import type { ImportResult, SampleDto } from '@shared/ipc';
import { importSummary } from '@shared/importSummary';
import { formatBytes } from '../format';
import './sampleMedia.css';

interface Props {
  onClose: () => void;
  /** Called after samples were copied in, so the screen can reload the project and select the first new file. */
  onAdded: (r: { result: ImportResult; text: string; error: boolean }) => void;
}

const KIND: Record<SampleDto['kind'], { label: string; app: string }> = {
  image: { label: 'Picture', app: 'PhotoCraft' }, vector: { label: 'Real SVG', app: 'VectorCraft' }, video: { label: 'Video', app: 'FilmCraft' },
};
const FILTERS: Array<{ id: 'all' | SampleDto['kind']; label: string }> = [{ id: 'all', label: 'All' }, { id: 'image', label: 'Pictures' }, { id: 'vector', label: 'Real SVG' }, { id: 'video', label: 'Videos' }];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Sample media: pictures, real SVG drawings and clips that ship with OmniCandy, one per AI model card, to add to a project and try the tools on. */
export function SampleMedia({ onClose, onAdded }: Props) {
  const [items, setItems] = useState<SampleDto[] | null>(null);
  const [filter, setFilter] = useState<'all' | SampleDto['kind']>('all');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  useEffect(() => { void window.studio.listSamples().then(setItems).catch((e: unknown) => setError(errText(e))); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const shown = useMemo(() => (items ?? []).filter((s) => filter === 'all' || s.kind === filter), [items, filter]);
  const add = async (ids: string[]) => {
    setBusy(true); setError('');
    try {
      const result = await window.studio.addSamples(ids);
      if (!result.errors.length) setAdded((cur) => new Set([...cur, ...ids]));
      onAdded({ result, ...importSummary(result) });
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const total = shown.reduce((n, s) => n + s.bytes, 0);

  return (
    <div className="sm" role="dialog" aria-modal="true" aria-label="Sample media">
      <div className="sm-head">
        <div>
          <h2>Sample media</h2>
          <span className="asset-meta">Pictures, real SVG drawings and short clips made with the AI models in OmniCandy. Add any of them to your project, then open them in PhotoCraft, VectorCraft or FilmCraft, or use them in AI Generate.</span>
        </div>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <div className="sm-bar">
        <div className="sm-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => <button key={f.id} className={`chip chip-btn${filter === f.id ? ' on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
        <button className="btn primary" disabled={busy || shown.length === 0} onClick={() => void add(shown.map((s) => s.id))}>{busy ? 'Adding…' : `Add all ${shown.length} to my project (${formatBytes(total)})`}</button>
      </div>
      {error && <div className="wf-msg error" role="status">{error}</div>}
      {!items && !error && <div className="asset-meta"><span className="as-spin" />Loading the samples…</div>}
      {items && items.length === 0 && <div className="asset-meta">This copy of OmniCandy has no sample media.</div>}
      <div className="sm-grid">
        {shown.map((s) => (
          <article key={s.id} className="sm-card">
            <div className="sm-pic">
              {s.thumb ? <img src={s.thumb} alt="" loading="lazy" /> : <span className="sm-nopic">{s.format.toUpperCase()}</span>}
              <span className={`sm-kind k-${s.kind}`}>{KIND[s.kind].label}</span>
              {s.kind === 'video' && <span className="sm-play" aria-hidden="true">▶</span>}
            </div>
            <div className="sm-body">
              <strong title={s.prompt || s.name}>{s.name}</strong>
              <span className="asset-meta">{s.model} · {formatBytes(s.bytes)}</span>
              <span className="asset-meta sm-blurb">Open it in {KIND[s.kind].app}, or use it in AI Generate.</span>
              <button className={`btn small${added.has(s.id) ? '' : ' primary'}`} disabled={busy} onClick={() => void add([s.id])}>{added.has(s.id) ? 'Added ✓ (add again)' : 'Add to my project'}</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

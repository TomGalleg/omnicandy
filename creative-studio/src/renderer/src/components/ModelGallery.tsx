import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset } from '@shared/types';
import { cardState, type CardState } from '@shared/aiStudio';
import { previewFor, type ModelPreview } from '@shared/studioPreviews';
import textPoster from '../assets/previews/seedance-text.jpg';
import textClip from '../assets/previews/seedance-text.mp4';
import picturePoster from '../assets/previews/seedance-picture.jpg';
import pictureClip from '../assets/previews/seedance-picture.mp4';
import referencePoster from '../assets/previews/seedance-reference.jpg';
import referenceClip from '../assets/previews/seedance-reference.mp4';
import editPoster from '../assets/previews/seedance-edit.jpg';
import editClip from '../assets/previews/seedance-edit.mp4';
import extendPoster from '../assets/previews/seedance-extend.jpg';
import extendClip from '../assets/previews/seedance-extend.mp4';
import seedance2Poster from '../assets/previews/seedance2.jpg';
import seedance2Clip from '../assets/previews/seedance2.mp4';
import genjutsuPoster from '../assets/previews/genjutsu.jpg';
import genjutsuClip from '../assets/previews/genjutsu.mp4';
import soulPoster from '../assets/previews/soul.jpg';
import gptPoster from '../assets/previews/gpt-image.jpg';
import removeBgPoster from '../assets/previews/recraft-remove-bg.jpg';
import crispPoster from '../assets/previews/recraft-crisp-upscale.jpg';
import editWidePoster from '../assets/previews/recraft-edit-wide.jpg';
import v3VectorPoster from '../assets/previews/recraft-v3-vector.jpg';
import creativePoster from '../assets/previews/recraft-creative-upscale.jpg';
import vectorizePoster from '../assets/previews/recraft-vectorize.jpg';
import { STUDIO_PROVIDERS, studioProvider, type StudioModel, type StudioProviderId } from '@shared/providerCapabilities';
import {
  artSeed, BRAND, CATEGORIES, categoriesOf, compareRows, describeModel, exploreModels, favKey, OP_LABEL, outputLabel, priceInfo, settingsSummary,
  type CategoryId,
} from '@shared/studioCatalog';

interface Props {
  assets: Asset[];
  configured: ReadonlySet<string>;
  favs: string[];
  onToggleFav: (key: string) => void;
  onCreate: (m: StudioModel) => void;
  onOpenSettings?: () => void;
}

// Bundled example media (small copies of files the user supplied), by the file names listed in shared/studioPreviews.ts.
const PREVIEW_FILES: Record<string, string> = {
  'seedance-text.jpg': textPoster, 'seedance-text.mp4': textClip, 'seedance-picture.jpg': picturePoster, 'seedance-picture.mp4': pictureClip,
  'seedance-reference.jpg': referencePoster, 'seedance-reference.mp4': referenceClip, 'seedance-edit.jpg': editPoster, 'seedance-edit.mp4': editClip,
  'seedance-extend.jpg': extendPoster, 'seedance-extend.mp4': extendClip, 'seedance2.jpg': seedance2Poster, 'seedance2.mp4': seedance2Clip,
  'genjutsu.jpg': genjutsuPoster, 'genjutsu.mp4': genjutsuClip, 'soul.jpg': soulPoster, 'gpt-image.jpg': gptPoster, 'recraft-remove-bg.jpg': removeBgPoster, 'recraft-crisp-upscale.jpg': crispPoster, 'recraft-edit-wide.jpg': editWidePoster, 'recraft-v3-vector.jpg': v3VectorPoster, 'recraft-creative-upscale.jpg': creativePoster,
  'recraft-vectorize.jpg': vectorizePoster,
};
const previewUrl = (name: string) => PREVIEW_FILES[name];

const STATE_TEXT: Record<CardState, string> = { ready: 'Ready', 'needs-key': 'Needs a key', soon: 'Coming soon' };
const MAX_COMPARE = 3;

/** The newest thing the user made with this model: a real example from their own project, never an invented one. */
function coverFor(m: StudioModel, assets: Asset[]): Asset | null {
  for (let i = assets.length - 1; i >= 0; i--) {
    const a = assets[i]!;
    if (a.provenance.origin === 'generated' && a.provenance.model === m.id && (a.kind === 'image' || a.kind === 'vector' || a.kind === 'video')) return a;
  }
  return null;
}

/** The card takes the shape of the picture or clip it shows (kept within sensible limits so one extreme file cannot dominate the page). */
function shapeOf(a: Asset): number {
  const r = a.width && a.height ? a.width / a.height : a.kind === 'video' ? 16 / 9 : 4 / 3;
  return Math.min(2.5, Math.max(0.5, r));
}

function Cover({ m, asset, big }: { m: StudioModel; asset: Asset | null; big?: boolean }) {
  const preview: ModelPreview | null = asset ? null : previewFor(m);
  const poster = preview ? previewUrl(preview.poster) : undefined;
  const clip = preview?.video ? previewUrl(preview.video) : undefined;
  // The card's click button covers the picture, so hovering must be read from the whole card, not the picture alone.
  useEffect(() => {
    const v = ref.current;
    const card = v?.closest('.mg-card');
    if (!v || !card) return;
    const start = () => { void v.play().catch(() => undefined); };
    const stop = () => { v.pause(); v.currentTime = 0; };
    card.addEventListener('mouseenter', start); card.addEventListener('mouseleave', stop);
    card.addEventListener('focusin', start); card.addEventListener('focusout', stop);
    return () => { card.removeEventListener('mouseenter', start); card.removeEventListener('mouseleave', stop); card.removeEventListener('focusin', start); card.removeEventListener('focusout', stop); };
  }, [clip, asset]);
  const ref = useRef<HTMLVideoElement>(null);
  const seed = artSeed(`${m.providerId}/${m.id}`);
  const brand = BRAND[m.providerId];
  return (
    <div className={`mg-cover${big ? ' big' : ''}`} style={{ ['--a' as string]: `hsl(${seed.a} 70% 45%)`, ['--b' as string]: `hsl(${seed.b} 75% 35%)`, ['--hue' as string]: brand.hue }}
      onMouseEnter={() => { void ref.current?.play().catch(() => undefined); }} onMouseLeave={() => { if (ref.current) { ref.current.pause(); ref.current.currentTime = 0; } }}>
      {preview && poster && !clip
        ? <img src={poster} alt={`Example for ${m.label}`} loading="lazy" />
        : preview && poster
        ? <video ref={ref} poster={poster} src={clip} muted loop playsInline preload="none" aria-label={`Example for ${m.label}`} />
        : asset?.kind === 'video'
        ? <video ref={ref} src={window.studio.assetUrl(asset.id)} muted loop playsInline preload="metadata" aria-label={`Example made with ${m.label}`} />
        : asset ? <img src={window.studio.assetUrl(asset.id)} alt={`Example made with ${m.label}`} loading="lazy" />
        : <div className="mg-placeholder" aria-hidden="true"><span className="mg-mark">{brand.mark}</span><span className="mg-kind">{outputLabel(m.output)}</span></div>}
      {asset && <span className="mg-yours">Made by you</span>}
      {preview && poster && <span className="mg-yours">{preview.credit}</span>}
    </div>
  );
}

/** Explore: a visual gallery of every model, with categories, search, favourites, a detail panel and side-by-side comparison. */
export function ModelGallery({ assets, configured, favs, onToggleFav, onCreate, onOpenSettings }: Props) {
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [providerId, setProviderId] = useState<StudioProviderId | null>(null);
  const [search, setSearch] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [readyOnly, setReadyOnly] = useState(false);
  const [view, setView] = useState<'grid' | 'list' | 'mosaic'>('mosaic');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);

  const state = (m: StudioModel) => cardState(m, configured);
  const models = useMemo(
    () => exploreModels({ category, providerId, search, favoritesOnly, readyOnly }, favs, (m) => cardState(m, configured) === 'ready'),
    [category, providerId, search, favoritesOnly, readyOnly, favs, configured],
  );
  const all = useMemo(() => exploreModels({ category: null, providerId: null, search: '', favoritesOnly: false, readyOnly: false }, [], () => true), []);
  const open = all.find((m) => favKey(m) === openKey) ?? null;
  const compared = compare.map((k) => all.find((m) => favKey(m) === k)).filter((m): m is StudioModel => !!m);
  const activeCat = category ? CATEGORIES.find((c) => c.id === category)! : null;
  const toggleCompare = (k: string) => setCompare((c) => (c.includes(k) ? c.filter((x) => x !== k) : c.length >= MAX_COMPARE ? c : [...c, k]));

  return (
    <div className="mg">
      <div className="mg-bar">
        <input className="as-search" aria-label="Search models" placeholder="Search models, e.g. vector, banana, seedance, kling…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className={`chip chip-btn${favoritesOnly ? ' on' : ''}`} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>♥ Favourites{favs.length ? ` (${favs.length})` : ''}</button>
        <button className={`chip chip-btn${readyOnly ? ' on' : ''}`} aria-pressed={readyOnly} onClick={() => setReadyOnly(!readyOnly)}>Ready to use</button>
        <span className="mg-views" role="group" aria-label="View">
          {(['mosaic', 'grid', 'list'] as const).map((v) => <button key={v} className={`chip chip-btn${view === v ? ' on' : ''}`} aria-pressed={view === v} onClick={() => setView(v)}>{v === 'mosaic' ? 'Mosaic' : v === 'grid' ? 'Grid' : 'List'}</button>)}
        </span>
      </div>

      <div className="mg-cats" role="tablist" aria-label="Categories">
        <button role="tab" aria-selected={category === null} className="mg-cat" onClick={() => setCategory(null)}>All<span>{all.length}</span></button>
        {CATEGORIES.map((c) => (
          <button key={c.id} role="tab" aria-selected={category === c.id} className="mg-cat" onClick={() => setCategory(category === c.id ? null : c.id)}>
            {c.label}<span>{all.filter(c.match).length}</span>
          </button>
        ))}
      </div>
      <div className="mg-bar">
        {STUDIO_PROVIDERS.filter((p) => p.id !== 'local').map((p) => (
          <button key={p.id} className={`chip chip-btn mg-prov${providerId === p.id ? ' on' : ''}`} style={{ ['--hue' as string]: BRAND[p.id].hue }} aria-pressed={providerId === p.id} onClick={() => setProviderId(providerId === p.id ? null : p.id)}>
            <i>{BRAND[p.id].mark}</i>{p.label}
          </button>
        ))}
      </div>
      {activeCat && <div className="asset-meta">{activeCat.blurb}</div>}

      <div className={`mg-layout${open ? ' with-detail' : ''}`}>
        <div className={`mg-grid${view === 'list' ? ' list' : view === 'mosaic' ? ' mosaic' : ''}`}>
          {models.length === 0 && (
            <div className="mg-empty">
              <strong>{activeCat && all.filter(activeCat.match).length === 0 ? activeCat.empty : favoritesOnly && !favs.length ? 'No favourites yet. Tap ♥ on a model to keep it here.' : 'No model matches.'}</strong>
              <span className="asset-meta">Clear a filter to see more models.</span>
              <button className="btn small" onClick={() => { setCategory(null); setProviderId(null); setSearch(''); setFavoritesOnly(false); setReadyOnly(false); }}>Clear filters</button>
            </div>
          )}
          {models.map((m) => {
            const k = favKey(m);
            const st = state(m);
            const cover = coverFor(m, assets);
            const price = priceInfo(m);
            return (
              <article key={k} className={`mg-card ${st}${openKey === k ? ' open' : ''}`} style={{ ['--hue' as string]: BRAND[m.providerId].hue, ...(cover ? { ['--ar' as string]: shapeOf(cover) } : previewFor(m) ? { ['--ar' as string]: previewFor(m)!.aspect } : {}) }}>
                <button className="mg-hit" onClick={() => setOpenKey(openKey === k ? null : k)} aria-label={`${m.label}, ${studioProvider(m.providerId)?.label}. Show details`} aria-pressed={openKey === k} />
                <Cover m={m} asset={cover} />
                <div className="mg-tags">
                  <span className={`mg-tag out-${m.output}`}>{outputLabel(m.output)}</span>
                  <span className={`mg-tag st-${st}`}>{STATE_TEXT[st]}</span>
                </div>
                <div className="mg-actions">
                  <button className={`mg-icon${favs.includes(k) ? ' on' : ''}`} aria-pressed={favs.includes(k)} aria-label={favs.includes(k) ? `Remove ${m.label} from favourites` : `Add ${m.label} to favourites`} onClick={() => onToggleFav(k)}>{favs.includes(k) ? '♥' : '♡'}</button>
                  <button className={`mg-icon${compare.includes(k) ? ' on' : ''}`} aria-pressed={compare.includes(k)} aria-label={compare.includes(k) ? `Remove ${m.label} from comparison` : `Compare ${m.label}`} disabled={!compare.includes(k) && compare.length >= MAX_COMPARE} onClick={() => toggleCompare(k)}>⇄</button>
                </div>
                <div className="mg-info">
                  <div className="mg-title"><i className="mg-logo">{BRAND[m.providerId].mark}</i><span><strong>{m.label}</strong><small>{studioProvider(m.providerId)?.label}</small></span></div>
                  <p className="mg-desc">{describeModel(m)}</p>
                  <div className="mg-foot">
                    <span className={`mg-price${price.known ? '' : ' unknown'}`}>{price.text}</span>
                    <button className="btn small primary" disabled={st === 'soon'} tabIndex={-1} onClick={() => onCreate(m)}>{st === 'soon' ? 'Not connected' : 'Create'}</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        {open && (
          <aside className="mg-detail" aria-label={`${open.label} details`}>
            <Cover m={open} asset={coverFor(open, assets)} big />
            <button className="btn small ghost mg-close" onClick={() => setOpenKey(null)}>Close</button>
            <h3>{open.label}</h3>
            <div className="asset-meta">{studioProvider(open.providerId)?.label} · {outputLabel(open.output)} · {STATE_TEXT[state(open)]}</div>
            <p>{describeModel(open)}</p>
            {open.note && <p className="asset-meta">{open.note}</p>}
            <h4>What it can do</h4>
            <div className="as-badges">{open.operations.map((o) => <span key={o} className="as-badge">{OP_LABEL[o]}</span>)}</div>
            <div className="as-badges">{categoriesOf(open).map((c) => <span key={c} className="as-badge">{CATEGORIES.find((x) => x.id === c)!.label}</span>)}</div>
            {settingsSummary(open).length > 0 && (<><h4>Settings you can change</h4><ul className="mg-list">{settingsSummary(open).map((s) => <li key={s}>{s}</li>)}</ul></>)}
            <h4>Cost and billing</h4>
            <p className={priceInfo(open).known ? '' : 'asset-meta'}>{priceInfo(open).text}. {studioProvider(open.providerId)?.costInfo}</p>
            <p className="asset-meta">Stopping a job: {studioProvider(open.providerId)?.cancel}</p>
            {studioProvider(open.providerId)?.connection && <p className="asset-meta">{studioProvider(open.providerId)?.connection}</p>}
            {open.source !== 'in-app' && <p className="asset-meta">Checked against <a href={open.source} target="_blank" rel="noreferrer">the official documentation</a>.</p>}
            {state(open) === 'needs-key' && <div className="notice">Add your {studioProvider(open.providerId)?.label} key in Settings → Integrations to use it. {onOpenSettings && <button className="btn small" onClick={onOpenSettings}>Open Settings</button>}</div>}
            {state(open) === 'soon' && <div className="notice">Documented by {studioProvider(open.providerId)?.label} but not connected yet, so nothing can be sent.</div>}
            <div className="btn-row">
              <button className="btn primary" disabled={state(open) === 'soon'} onClick={() => onCreate(open)}>Create</button>
              <button className="btn" onClick={() => onToggleFav(favKey(open))}>{favs.includes(favKey(open)) ? '♥ Favourite' : '♡ Add to favourites'}</button>
              <button className="btn" disabled={!compare.includes(favKey(open)) && compare.length >= MAX_COMPARE} onClick={() => toggleCompare(favKey(open))}>{compare.includes(favKey(open)) ? 'Remove from comparison' : 'Compare'}</button>
            </div>
          </aside>
        )}
      </div>

      {compare.length > 0 && (
        <div className="mg-tray" role="region" aria-label="Model comparison">
          <span>Comparing {compared.map((m) => m.label).join(' · ')}</span>
          <button className="btn small primary" disabled={compared.length < 2} onClick={() => setShowCompare(!showCompare)}>{showCompare ? 'Hide comparison' : compared.length < 2 ? 'Pick one more to compare' : 'Compare side by side'}</button>
          <button className="btn small ghost" onClick={() => { setCompare([]); setShowCompare(false); }}>Clear</button>
        </div>
      )}
      {showCompare && compared.length >= 2 && (
        <div className="mg-compare" style={{ ['--n' as string]: compared.length }}>
          <div />
          {compared.map((m) => <div key={favKey(m)} className="mg-ch"><i className="mg-logo" style={{ background: BRAND[m.providerId].hue }}>{BRAND[m.providerId].mark}</i><strong>{m.label}</strong></div>)}
          {compareRows(compared).map((r) => (<Fragment key={r.label}><div className="mg-rl">{r.label}</div>{r.values.map((v, i) => <div key={`${r.label}${i}`}>{v}</div>)}</Fragment>))}
          <div />
          {compared.map((m) => <div key={`go${favKey(m)}`}><button className="btn small primary" disabled={state(m) === 'soon'} onClick={() => onCreate(m)}>Create</button></div>)}
        </div>
      )}
    </div>
  );
}

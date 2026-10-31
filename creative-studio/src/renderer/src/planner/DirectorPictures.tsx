import { useEffect, useState } from 'react';
import { aiPictures } from '@shared/aiModelsBriefing';
import type { Asset } from '@shared/types';

/** Told by whatever just made or changed a picture, so the window shows it without being reopened. */
export const LIBRARY_CHANGED = 'omni-library-changed';

/**
 * The AI pictures in the project, newest first, so the owner can look at what was made and talk about it with the director who owns AI. Picking "Talk about this one"
 * tells that director how it was made (never how it looks: the chat cannot see pictures). Only what is really in the library is shown.
 */
export function DirectorPictures({ name, onTalk }: { name: string; onTalk: (a: Asset) => void }) {
  const [pics, setPics] = useState<Asset[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => { void window.studio.loadProject().then((m) => { if (live) setPics(aiPictures(m.assets)); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); }); };
    load();
    window.addEventListener(LIBRARY_CHANGED, load);
    const off = window.studio.director.build.onChange(load);
    return () => { live = false; window.removeEventListener(LIBRARY_CHANGED, load); off(); };
  }, []);

  const shown = pics?.find((a) => a.id === pick) ?? pics?.[0] ?? null;
  const p = shown?.provenance;
  return (
    <section className="tw-pictures" aria-label="AI pictures">
      {error && <p className="pl-error" role="alert">{error}</p>}
      {pics && pics.length === 0 && <p className="pl-hint">No AI pictures in this project yet. Ask {name} to make one, then it shows up here.</p>}
      {shown && (
        <div className="tw-pic-main">
          <img src={window.studio.assetUrl(shown.id)} alt={shown.name} />
          <div className="tw-pic-info">
            <strong>{shown.name}</strong>
            <p className="pl-hint">
              {p?.model ? `Made with ${p.model}` : 'Made with AI'}{p?.createdAt ? ` on ${new Date(p.createdAt).toLocaleDateString()}` : ''}
              {p?.settings && Object.keys(p.settings).length ? ` · ${Object.entries(p.settings).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}
              {typeof p?.estimatedCostUsd === 'number' ? ` · about $${p.estimatedCostUsd.toFixed(2)}` : ''}
            </p>
            <p>{p?.prompt ? <><em>Prompt:</em> {p.prompt}</> : <em>The prompt was not recorded.</em>}</p>
            <button className="btn small primary" onClick={() => onTalk(shown)}>Talk about this one with {name}</button>
          </div>
        </div>
      )}
      {pics && pics.length > 1 && (
        <ul className="tw-pic-strip" aria-label="All AI pictures">
          {pics.map((a) => (
            <li key={a.id}><button className={a.id === shown?.id ? 'on' : ''} onClick={() => setPick(a.id)} aria-label={`Look at ${a.name}`} aria-pressed={a.id === shown?.id}><img src={window.studio.assetUrl(a.id)} alt="" loading="lazy" /></button></li>
          ))}
        </ul>
      )}
    </section>
  );
}

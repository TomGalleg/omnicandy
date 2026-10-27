import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HfJobRecord } from '@shared/higgsfield';
import type { ProviderStatusDto } from '@shared/ipc';
import { addJob, updateJob, type StudioJob } from '@shared/aiStudio';
import type { Asset, ProjectManifest, WorkspaceId } from '@shared/types';
import {
  actionState, buildDraft, buildRun, promptRule, quickChoices, quickHost, type QuickAsset, type QuickContext, type QuickRun,
} from '@shared/quickAi';
import { PROVIDERS_CHANGED } from './ProvidersCard';
import './quickAi.css';

interface Props {
  /** The app this panel sits in. Only apps listed in QUICK_HOSTS get a panel. */
  appId: string;
  manifest: ProjectManifest | null;
  /** The file open in the app. */
  open: Asset | null;
  /** The file selected in the library. */
  selected: Asset | null;
  onGoto: (w: WorkspaceId, assetId?: string) => void;
  log: (source: string, msg: string) => void;
}

const OPEN_KEY = 'cs-quick-ai-open';
const DRAFT_KEY = 'cs-studio-draft';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const qa = (a: Asset | null): QuickAsset | null => (a ? { id: a.id, name: a.name, kind: a.kind, sourceFormat: a.sourceFormat } : null);

/** Quick AI: a small panel inside a connected app. Same models, same approval card, same spending limit and same jobs as AI Studio;
 *  results are always saved as new files and never replace what is open. */
export function QuickAiPanel({ appId, manifest, open, selected, onGoto, log }: Props) {
  const host = quickHost(appId);
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } });
  const [providers, setProviders] = useState<ProviderStatusDto[] | null>(null);
  const [actionId, setActionId] = useState<string>(host?.actions[0]?.id ?? '');
  const [modelKey, setModelKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [clips, setClips] = useState<string[]>([]);
  const [resultIds, setResultIds] = useState<string[]>([]);
  const [hfJob, setHfJob] = useState<string | null>(null);
  const [confirmInsert, setConfirmInsert] = useState<string | null>(null);
  const [manualId, setManualId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  const toggle = () => setExpanded((e) => { const n = !e; try { localStorage.setItem(OPEN_KEY, n ? '1' : '0'); } catch { /* storage unavailable */ } return n; });

  useEffect(() => {
    if (!expanded) return;
    const load = () => { void window.studio.generate.providers().then(setProviders).catch(() => undefined); };
    load();
    window.addEventListener(PROVIDERS_CHANGED, load);
    return () => window.removeEventListener(PROVIDERS_CHANGED, load);
  }, [expanded]);

  // FilmCraft: which clips are selected on the timeline (names only: a timeline clip does not map to a library file).
  useEffect(() => {
    if (!expanded || appId !== 'filmcraft') return;
    let live = true;
    const read = () => { void window.studio.live.timeline().then((t) => { if (live) setClips(t ? t.tracks.flatMap((tr) => tr.clips).filter((c) => t.selection.includes(c.id)).map((c) => c.name) : []); }).catch(() => undefined); };
    read();
    const iv = setInterval(read, 2500);
    return () => { live = false; clearInterval(iv); };
  }, [expanded, appId]);

  // A Higgsfield request runs in the background: follow it until its files are in the library.
  useEffect(() => window.studio.generate.onHiggsfield((r: HfJobRecord) => {
    if (r.id !== hfJob) return;
    if (r.state === 'done') { setResultIds(r.assetIds); setHfJob(null); setMsg({ text: r.message }); }
    else if (r.state === 'failed' || r.state === 'moderated' || r.state === 'canceled') { setHfJob(null); setMsg({ text: r.message, error: r.state !== 'canceled' }); }
    else setMsg({ text: r.message });
  }), [hfJob]);

  const manual = manifest?.assets.find((a) => a.id === manualId) ?? null;
  const ctx: QuickContext = useMemo(() => ({ open: qa(open), selected: qa(manual ?? selected), selectedClips: clips }), [open, selected, manual, clips]);
  const configured = useMemo(() => new Set((providers ?? []).filter((p) => p.configured).map((p) => p.id as string)), [providers]);
  const action = host?.actions.find((a) => a.id === actionId) ?? host?.actions[0];
  const state = host && action ? actionState(action, ctx) : null;
  const choices = useMemo(() => (state ? quickChoices(state, configured) : []), [state, configured]);
  const choice = choices.find((c) => `${c.model.providerId}/${c.model.id}` === modelKey) ?? choices.find((c) => c.ready) ?? choices[0];

  const record = useCallback(async (rec: StudioJob) => {
    try { await window.studio.generate.studioJobsSave(addJob(await window.studio.generate.studioJobs(), rec)); } catch { /* the job list is a convenience */ }
  }, []);
  const finish = useCallback(async (id: string, patch: Partial<StudioJob>) => {
    try { await window.studio.generate.studioJobsSave(updateJob(await window.studio.generate.studioJobs(), id, patch)); } catch { /* same */ }
  }, []);

  if (!host || !action || !state) return null;
  const library = (manifest?.assets ?? []).filter((a) => (action.source === 'video' ? a.kind === 'video' : a.kind === 'image' || a.kind === 'vector')).slice(-20).reverse();
  const pick = (id: string) => { setActionId(id); setModelKey(''); setChoosing(false); setMsg(null); setResultIds([]); const a = host.actions.find((x) => x.id === id); if (a?.starter && !prompt) setPrompt(a.starter); };

  const rule = choice ? promptRule(choice.model) : 'required';

  const run = async () => {
    if (!choice) return;
    let r: QuickRun;
    try { r = buildRun(choice.model, prompt, state.source); } catch (e) { setMsg({ text: errText(e), error: true }); return; }
    setBusy(true); setMsg(null); setResultIds([]);
    const jobId = `qa-${Date.now().toString(36)}`;
    const label = r.label;
    const base = { id: jobId, at: new Date().toISOString(), providerId: choice.model.providerId, modelId: choice.model.id, modelLabel: label, prompt: prompt.trim() || action.label, settings: {} as Record<string, string>, count: 1, referenceAssetIds: state.source ? [state.source.id] : [], state: 'running' as const };
    try {
      if (r.kind === 'higgsfield') {
        const rec = await window.studio.generate.higgsfieldRun(r.job);
        setHfJob(rec.id);
        setMsg({ text: 'Sent to Higgsfield. It runs in the background; the result is saved to your library when it finishes. Follow it in AI Studio → Jobs.' });
        log('generate', 'Higgsfield request accepted (Quick AI).');
        return;
      }
      await record(base);
      const dto = r.kind === 'image' ? await window.studio.generate.run(r.job) : r.kind === 'recraft' ? await window.studio.generate.recraftRun(r.job) : await window.studio.generate.recraftToolRun(r.job);
      await finish(jobId, { state: 'done', message: dto.message, assetIds: dto.assetIds, estimateUsd: dto.estimate.amount });
      setResultIds(dto.assetIds); setMsg({ text: dto.message }); log('generate', dto.message);
    } catch (e) {
      const t = errText(e);
      const cancelled = /cancelled/i.test(t);
      if (r.kind !== 'higgsfield') await finish(jobId, { state: cancelled ? 'canceled' : 'failed', message: t });
      setMsg({ text: t, error: !cancelled }); log('generate', t);
    } finally { setBusy(false); }
  };

  const openInStudio = () => {
    if (!choice) return;
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(buildDraft(host.id, choice.model, prompt, state.source))); } catch { /* storage unavailable */ }
    onGoto('generate');
  };

  const insertClip = async (id: string) => {
    setBusy(true);
    try { await window.studio.live.editTimeline({ kind: 'add', assetId: id, as: 'clip' }); setMsg({ text: 'Added to the end of the timeline. Undo in FilmCraft removes it.' }); setConfirmInsert(null); }
    catch (e) { setMsg({ text: errText(e), error: true }); }
    finally { setBusy(false); }
  };

  const results = resultIds.map((id) => manifest?.assets.find((a) => a.id === id) ?? null);

  return (
    <aside className={`qa${expanded ? ' open' : ''}`} aria-label={`Quick AI for ${host.label}`}>
      <button className="qa-toggle" aria-expanded={expanded} onClick={toggle} title="Quick AI">{expanded ? '›' : '✦'}<span>{expanded ? '' : 'Quick AI'}</span></button>
      {expanded && (
        <div className="qa-body">
          <h3>Quick AI <small>in {host.label}</small></h3>
          <div className="asset-meta">
            {state.source ? <>Working on <strong>{state.source.name}</strong></> : open ? <>Open: <strong>{open.name}</strong></> : 'Nothing open.'}
            {host.id === 'filmcraft' && clips.length > 0 ? ` · selected clip${clips.length === 1 ? '' : 's'}: ${clips.join(', ')}` : ''}
          </div>

          <div className="qa-actions" role="radiogroup" aria-label="What do you want to do?">
            {host.actions.map((a) => {
              const s = actionState(a, ctx);
              return <button key={a.id} role="radio" aria-checked={a.id === action.id} className={`qa-action${a.id === action.id ? ' on' : ''}${s.blocked ? ' none' : ''}`} title={s.blocked ? `${a.hint} ${s.blocked}` : a.hint} onClick={() => pick(a.id)}>{a.label}</button>;
            })}
          </div>
          <div className="asset-meta">{action.hint}</div>

          {action.source && (!state.source || choosing) && (
            <div className="field">{action.source === 'video' ? 'Choose a video from your library' : 'Choose a picture from your library'}
              {library.length === 0 ? <span className="asset-meta">Nothing suitable in this project yet.</span> : (
                <div className="qa-strip" role="list">
                  {library.map((a) => (
                    <button key={a.id} role="listitem" className={`qa-cand${a.id === state.source?.id ? ' on' : ''}`} title={a.name} aria-label={`Use ${a.name}`} onClick={() => { setManualId(a.id); setChoosing(false); }}>
                      {a.kind === 'video' ? <video src={window.studio.assetUrl(a.id)} muted preload="metadata" /> : <img src={window.studio.assetUrl(a.id)} alt="" loading="lazy" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {action.source && state.source && !choosing && <button className="btn small ghost" onClick={() => setChoosing(true)}>Use a different file…</button>}
          {state.blocked && !(action.source && !state.source && /^Open/.test(state.blocked)) ? <div className="notice">{state.blocked}</div> : state.blocked ? null : (
            <>
              <label className="field">Model
                <select aria-label="Model" value={choice ? `${choice.model.providerId}/${choice.model.id}` : ''} onChange={(e) => setModelKey(e.target.value)}>
                  {choices.map((c) => <option key={`${c.model.providerId}/${c.model.id}`} value={`${c.model.providerId}/${c.model.id}`}>{c.model.label} — {c.price}{c.ready ? '' : ' (needs a key)'}</option>)}
                </select>
              </label>
              {rule !== 'none' && (
                <label className="field">{action.source ? (rule === 'optional' ? 'What should it do? (optional)' : 'What should it do?') : 'Prompt'}
                  <textarea aria-label="Prompt" value={prompt} maxLength={4000} placeholder={host.id === 'filmcraft' ? 'Describe the motion and the scene…' : 'Describe it…'} onChange={(e) => setPrompt(e.target.value)} />
                </label>
              )}
              <div className="btn-row">
                <button className="btn primary" disabled={busy || !!hfJob || !choice?.ready || (rule === 'required' && !prompt.trim())} onClick={() => void run()}>{busy ? 'Working…' : hfJob ? 'Running…' : 'Generate… (asks you to approve)'}</button>
                <button className="btn" disabled={!choice} onClick={openInStudio} title="Opens the full AI Studio with this model, prompt and file">Open in AI Studio</button>
              </div>
              {choice && !choice.ready && <div className="asset-meta">Add your key in Settings → Integrations to use this model.</div>}
              <div className="asset-meta">You see the price and approve before anything is sent. Results are saved as new files; what is open is never replaced.</div>
            </>
          )}

          {msg && <div className={`wf-msg${msg.error ? ' error' : ''}`} role="status">{msg.text}</div>}

          {results.map((a, i) => a && (
            <div key={a.id} className="qa-result">
              {a.kind === 'video' ? <video src={window.studio.assetUrl(a.id)} controls muted loop playsInline /> : <img src={window.studio.assetUrl(a.id)} alt={a.name} />}
              <div className="asset-meta">{a.name} — saved in your project library{host.id === 'filmcraft' ? ' (media bin)' : ''}.</div>
              <div className="btn-row">
                {host.id === 'filmcraft' && a.kind === 'video' && (confirmInsert === a.id
                  ? <><button className="btn small primary" disabled={busy} onClick={() => void insertClip(a.id)}>Yes, add to the end</button><button className="btn small" onClick={() => setConfirmInsert(null)}>Not now</button></>
                  : <button className="btn small primary" onClick={() => setConfirmInsert(a.id)}>Insert into timeline…</button>)}
                {host.id === 'photocraft' && a.kind !== 'video' && <button className="btn small primary" onClick={() => onGoto('edit', a.id)}>Open in PhotoCraft</button>}
                <button className="btn small" onClick={() => onGoto('media', a.id)}>Show in library</button>
              </div>
              {i === 0 && host.id === 'photocraft' && host.unavailable[0] && <div className="asset-meta">{host.unavailable[0]}</div>}
            </div>
          ))}
          {resultIds.length > 0 && results.every((r) => r === null) && <div className="asset-meta">{resultIds.length} new file{resultIds.length === 1 ? '' : 's'} saved in your library. <button className="btn small" onClick={() => onGoto('media', resultIds[0])}>Show</button></div>}
        </div>
      )}
    </aside>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUILDER_CONSENT, parseLinks, suggestedLinksFor, type BuilderOverview, type BuilderProjectDetail, type InstalledProgram } from '@shared/builder';
import { errorText } from '../connect/events';
import { ProjectView } from './ProjectView';

type Phase = 'loading' | 'choose' | 'project';
type Source = 'installed' | 'name';

interface Props {
  onClose: () => void;
  /** Open an existing project (My Custom Integrations > Details). */
  openProjectId?: string;
}

/**
 * Create Custom Integration. Two ways to begin: pick an installed program that has no integration yet, or type any program's
 * name (installed or not). Then one button, understandable progress, and a result the user reviews. Nothing is installed or run
 * until the user approves it in the normal review.
 */
export function BuilderWizard({ onClose, openProjectId }: Props) {
  const [phase, setPhase] = useState<Phase>(openProjectId ? 'project' : 'loading');
  const [overview, setOverview] = useState<BuilderOverview | null>(null);
  const [source, setSource] = useState<Source>('installed');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<InstalledProgram | null>(null);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [docs, setDocs] = useState<string[]>([]);
  const [linkText, setLinkText] = useState('');
  const [projectId, setProjectId] = useState<string | null>(openProjectId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState<{ name: string; docs: string[] } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => { opener?.focus?.(); };
  }, []);

  const load = useCallback(async () => {
    try { const o = await window.studio.builder.overview(); if (alive.current) { setOverview(o); setPhase((p) => (p === 'loading' ? 'choose' : p)); } } catch (e) { if (alive.current) { setError(errorText(e)); setPhase('choose'); } }
  }, []);
  useEffect(() => { if (!openProjectId) void load(); }, [load, openProjectId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (overview?.programs ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || (p.publisher ?? '').toLowerCase().includes(q)).slice(0, 80);
  }, [overview, query]);

  const targetName = source === 'installed' ? picked?.name ?? '' : name.trim();
  const claudeReady = overview?.claude.ready ?? true;
  const suggested = suggestedLinksFor(targetName);
  const addSuggested = () => { if (suggested) setLinkText((t) => [...new Set([...parseLinks(t), ...suggested.links])].join(String.fromCharCode(10))); };

  const browseProgram = async () => {
    setError(null);
    try { const p = await window.studio.builder.pickProgram(); if (p) setPicked(p); } catch (e) { setError(errorText(e)); }
  };

  const addDocs = async (kind: 'files' | 'folder') => {
    setError(null);
    try { const p = await window.studio.builder.pickDocs(kind); if (p.length) setDocs((d) => [...new Set([...d, ...p])].slice(0, 40)); } catch (e) { setError(errorText(e)); }
  };

  const create = async () => {
    if (!targetName) return;
    setBusy(true); setError(null);
    try {
      const s = await window.studio.builder.create({ appName: targetName, exePath: source === 'installed' ? picked?.exePath ?? null : null, documentation: docs, documentationUrls: parseLinks(linkText).slice(0, 10), goal: goal.trim() || undefined });
      setProjectId(s.id);
      setPhase('project');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const retry = (d: BuilderProjectDetail) => {
    setSeed({ name: d.appName, docs: [] });
    setSource('name'); setName(d.appName); setPicked(null); setProjectId(null); setPhase('choose');
  };

  return (
    <div className="modal-backdrop connect-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="builder-title" className="panel-card connect-dialog" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div className="settings-head">
          <div>
            <h2 id="builder-title" tabIndex={-1} ref={heading}>{phase === 'project' ? 'Custom integration' : 'Create Custom Integration'}</h2>
            <small className="ext-note">Private to this computer. Never shared, published or uploaded.</small>
          </div>
          <button className="btn small ghost" aria-label="Close Create Custom Integration" onClick={onClose}>✕</button>
        </div>
        <div className="connect-body">
          {error && <small className="ext-error" role="alert">{error}</small>}
          {phase === 'loading' && <div className="connect-empty" aria-busy="true"><strong>Looking at the programs on this computer…</strong><small>This list stays on your computer.</small></div>}
          {phase === 'choose' && (
            <>
              <p className="connect-lead">Tell CreateCraft which program you want to connect. It researches how the program can be controlled, builds a connector, tests it safely and asks for your approval before anything is installed.</p>
              {seed && <small className="connect-notice">Trying again for {seed.name}. Add the program's documentation if the last attempt said it was missing.</small>}
              <div className="builder-tabs" role="tablist" aria-label="How to choose the program">
                <button role="tab" aria-selected={source === 'installed'} className={`btn small ${source === 'installed' ? 'primary' : 'ghost'}`} onClick={() => setSource('installed')}>Installed on this computer</button>
                <button role="tab" aria-selected={source === 'name'} className={`btn small ${source === 'name' ? 'primary' : 'ghost'}`} onClick={() => setSource('name')}>Type a program name</button>
              </div>
              {source === 'installed' ? (
                <div className="field">
                  <label className="menu-label" htmlFor="builder-search">Programs without an integration yet</label>
                  <input id="builder-search" type="search" className="text-input" placeholder="Search by name or publisher" value={query} onChange={(e) => setQuery(e.target.value)} />
                  {overview && overview.programs.length === 0 && <small className="ext-note">No other programs were found, or all of them already have an integration. You can type any program's name instead.</small>}
                  <div className="ext-actions">
                    <button className="btn small" onClick={() => void browseProgram()}>Not in the list? Browse for the program file…</button>
                  </div>
                  {picked?.key.startsWith('picked:') && (
                    <div className="field">
                      <label className="menu-label" htmlFor="builder-picked-name">Program name</label>
                      <input id="builder-picked-name" className="text-input" value={picked.name} maxLength={80} onChange={(e) => setPicked({ ...picked, name: e.target.value })} />
                      <small>Chosen file: {picked.exePath}</small>
                    </div>
                  )}
                  <ul className="status-list ext-list builder-programs" role="listbox" aria-label="Installed programs">
                    {filtered.map((p) => (
                      <li key={p.key} role="option" aria-selected={picked?.key === p.key}>
                        <label className="ext-check">
                          <input type="radio" name="builder-program" checked={picked?.key === p.key} onChange={() => setPicked(p)} />
                          <span><strong>{p.name}</strong> <small>{p.version ? `version ${p.version}` : ''} {p.publisher ? `· ${p.publisher}` : ''}</small></span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="field">
                  <label className="menu-label" htmlFor="builder-name">Program name</label>
                  <input id="builder-name" className="text-input" placeholder="For example: Adobe Photoshop, AutoCAD, Inkscape" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                  <small>It does not have to be installed. If it is not, CreateCraft builds a candidate and tests it with simulations only; it stays “Awaiting live verification” until you install the program and test it for real.</small>
                </div>
              )}
              <div className="field">
                <label className="menu-label" htmlFor="builder-goal">What do you want to do with it? (optional)</label>
                <input id="builder-goal" className="text-input" placeholder="For example: export pages as PDF" value={goal} maxLength={500} onChange={(e) => setGoal(e.target.value)} />
              </div>
              <div className="field">
                <span className="menu-label">Documentation (optional)</span>
                <small>If CreateCraft cannot find trustworthy documentation online, it stops instead of guessing. You can give it the program's manual or SDK now: text, HTML or source files.</small>
                <div className="ext-actions">
                  <button className="btn small" onClick={() => void addDocs('files')}>Add documentation files…</button>
                  <button className="btn small" onClick={() => void addDocs('folder')}>Add a documentation or SDK folder…</button>
                </div>
                <label className="menu-label" htmlFor="builder-links">Or paste links to documentation pages</label>
                {suggested && <div className="ext-actions"><button className="btn small primary" onClick={addSuggested}>Add the {suggested.links.length} suggested {suggested.label} pages</button></div>}
                <textarea id="builder-links" className="text-input" rows={4} placeholder={'One link per line, for example: https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/index'} value={linkText} onChange={(e) => setLinkText(e.target.value)} />
                <small>{(() => { const n = parseLinks(linkText).length; return n === 0 ? 'Links must start with https://. CreateCraft reads each page once, as plain text, and sends it only to Claude. Pages that need a browser to show their content cannot be read; save those as HTML and add them as files.' : `${n} link${n === 1 ? '' : 's'} will be read${n > 10 ? ' (only the first 10 are used)' : ''}.`; })()}</small>
                {docs.length > 0 && <ul className="status-list">{docs.map((p) => <li key={p}><small>{p}</small> <button className="btn small ghost" aria-label={`Remove ${p}`} onClick={() => setDocs((x) => x.filter((y) => y !== p))}>Remove</button></li>)}</ul>}
              </div>
              <small className="ext-note" role="note">{BUILDER_CONSENT}</small>
              {!claudeReady && <small className="ext-error" role="alert">{overview?.claude.reason}</small>}
            </>
          )}
          {phase === 'project' && projectId && <ProjectView id={projectId} onRetry={retry} onChanged={() => void load()} />}
        </div>
        <div className="connect-foot">
          {phase === 'choose' && (<>
            <small>{targetName ? `Ready to create an integration for ${targetName}.` : 'Choose a program or type a name.'}</small>
            <span className="spacer" />
            <button className="btn small ghost" onClick={onClose}>Close</button>
            <button className="btn small primary" disabled={!targetName || busy || !claudeReady} onClick={() => void create()}>{busy ? 'Starting…' : 'Create Integration'}</button>
          </>)}
          {phase === 'project' && (<>
            <small>You can close this window; building continues in the background.</small>
            <span className="spacer" />
            {!openProjectId && <button className="btn small ghost" onClick={() => { setProjectId(null); setPhase('choose'); void load(); }}>Create another</button>}
            <button className="btn small primary" onClick={onClose}>Done</button>
          </>)}
        </div>
      </div>
    </div>
  );
}

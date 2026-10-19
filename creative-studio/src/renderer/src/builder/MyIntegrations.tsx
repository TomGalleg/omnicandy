import { useCallback, useEffect, useRef, useState } from 'react';
import { INTEGRATION_TYPE_LABEL, type ExternalAppInfo } from '@shared/integrations';
import type { BuilderOverview, MyIntegration } from '@shared/builder';
import { EXTERNAL_CHANGED, errorText } from '../connect/events';
import { BuilderWizard } from './BuilderWizard';

/** Entry card: Create Custom Integration. */
export function CreateIntegrationCard() {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>();
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <section className="connect-card" aria-labelledby="builder-card-title">
        <div>
          <h3 id="builder-card-title">Create Custom Integration</h3>
          <p>Is your program not on the list? Pick it (or type its name) and Claude researches how to connect it, builds a private connector, tests it safely and asks for your approval. Nothing is installed without you.</p>
        </div>
        <button ref={btn} className="btn primary" onClick={() => { setProjectId(undefined); setOpen(true); }}>Create Integration…</button>
      </section>
      <MyIntegrations onOpen={(id) => { setProjectId(id); setOpen(true); }} reloadKey={open ? 1 : 0} />
      {open && <BuilderWizard openProjectId={projectId} onClose={() => { setOpen(false); queueMicrotask(() => btn.current?.focus()); window.dispatchEvent(new Event(EXTERNAL_CHANGED)); }} />}
    </>
  );
}

/** My Integrations: official ones that come with OmniCandy, and the private ones created on this computer. */
export function MyIntegrations({ onOpen, reloadKey }: { onOpen: (projectId: string) => void; reloadKey: number }) {
  const [mine, setMine] = useState<MyIntegration[] | null>(null);
  const [overview, setOverview] = useState<BuilderOverview | null>(null);
  const [official, setOfficial] = useState<ExternalAppInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine1 = ++seq.current;
    try {
      const [m, o, apps] = await Promise.all([window.studio.builder.mine(), window.studio.builder.overview(), window.studio.external.list()]);
      if (mine1 !== seq.current) return; // a newer load is already on its way
      setMine(m); setOverview(o);
      setOfficial(apps.filter((a) => a.adapterId && a.origin && a.maturity !== 'stub' && !m.some((x) => x.adapterId === a.adapterId && x.origin === 'custom')));
    } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load, reloadKey]);
  useEffect(() => {
    const h = () => { void load(); };
    window.addEventListener(EXTERNAL_CHANGED, h);
    const off = window.studio.builder.onProgress(h);
    return () => { window.removeEventListener(EXTERNAL_CHANGED, h); off(); };
  }, [load]);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); await load(); window.dispatchEvent(new Event(EXTERNAL_CHANGED)); }
  };

  const custom = (mine ?? []).filter((x) => x.origin === 'custom');
  const officialInstalled = (mine ?? []).filter((x) => x.origin === 'official');
  const inProgress = (overview?.projects ?? []).filter((p) => !p.installed);
  const names = new Set<string>();
  const builtIn = official.filter((a) => (names.has(a.adapterId!) ? false : (names.add(a.adapterId!), true)));

  return (
    <div className="field" aria-label="My Integrations">
      <span className="menu-label">My Integrations</span>
      {error && <small className="ext-error" role="alert">{error}</small>}
      <section aria-label="Official OmniCandy Integrations">
        <small className="menu-label">Official OmniCandy Integrations</small>
        {builtIn.length + officialInstalled.length === 0 ? <small>None connected yet. Use Connect Applications above.</small> : (
          <ul className="status-list">
            {builtIn.map((a) => <li key={a.adapterId}><span className="chip ok"><span className="dot" />Official</span> <strong>{a.adapterName ?? a.name}</strong> <small>{a.origin === 'built-in' ? 'comes with OmniCandy' : 'official package'} · {a.commands.length} command{a.commands.length === 1 ? '' : 's'}{a.maturity === 'experimental' ? ' · experimental' : ''}</small></li>)}
            {officialInstalled.map((a) => <li key={a.adapterId}><span className="chip ok"><span className="dot" />Official</span> <strong>{a.name}</strong> <small>version {a.version} · {a.signed ? 'signed' : 'not signed'}</small></li>)}
          </ul>
        )}
      </section>
      <section aria-label="My Custom Integrations">
        <small className="menu-label">My Custom Integrations</small>
        {custom.length === 0 && inProgress.length === 0 && <small>Nothing created yet. Custom integrations stay on this computer.</small>}
        <ul className="status-list ext-list">
          {custom.map((c) => (
            <li key={c.adapterId} className="ext-row">
              <div className="ext-head">
                <strong>{c.name}</strong><small>version {c.version}</small>
                <span className="chip real"><span className="dot" />Custom · {INTEGRATION_TYPE_LABEL[c.integrationType]}</span>
                <span className={`chip ${c.verification?.verified ? 'ok' : 'warn'}`}><span className="dot" />{c.verification?.summary ?? 'Not tested on the real program yet'}</span>
                {!c.enabled && <span className="chip off"><span className="dot" />Turned off</span>}
              </div>
              <small>{c.stateDetail}</small>
              <div className="ext-actions">
                {c.projectId && <button className="btn small" onClick={() => onOpen(c.projectId!)}>Details, test, repair…</button>}
                {c.projectId && <button className="btn small" disabled={!!busy} onClick={() => onOpen(c.projectId!)}>Update Integration…</button>}
                <button className="btn small" disabled={!!busy} onClick={() => void act('toggle', () => window.studio.external.setPackageEnabled(c.adapterId, !c.enabled))}>{c.enabled ? 'Turn off' : 'Turn on'}</button>
                {c.projectId && <button className="btn small ghost" disabled={!!busy} onClick={() => void act('remove', () => window.studio.builder.removeIntegration(c.projectId!))}>Remove Integration</button>}
              </div>
            </li>
          ))}
          {inProgress.map((p) => (
            <li key={p.id} className="ext-row">
              <div className="ext-head"><strong>{p.appName}</strong><span className="chip real"><span className="dot" />{p.statusLabel}</span></div>
              <small>{p.headline}</small>
              <div className="ext-actions">
                <button className="btn small" onClick={() => onOpen(p.id)}>Open</button>
                <button className="btn small ghost" disabled={!!busy} onClick={() => void act('delete', () => window.studio.builder.deleteProject(p.id))}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExternalLiveState } from '@shared/ipc';
import { useOverlayOpen } from '../overlay';
import { EDITOR_APPS } from '@shared/appEditors';
import type { AppProbeResult } from '@shared/types';
import { ExternalApps } from './ExternalApps';

/** The window of a third-party program Claude is working in (Blender), shown inside OmniCandy. */
function LiveStage({ live, onList }: { live: ExternalLiveState; onList: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const overlay = useOverlayOpen();
  useEffect(() => { void window.studio.external.liveShow(); }, [live.pid]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void window.studio.live.setViewport({ x: r.left, y: r.top, width: r.width, height: r.height, visible: !overlay });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => { ro.disconnect(); window.removeEventListener('resize', report); void window.studio.live.setViewport(null); };
  }, [overlay, live.pid]);
  return (
    <div className="ext-live">
      <div className="ext-live-bar">
        <strong>{live.name}</strong><span className="asset-meta">{live.name === 'Blender' ? 'live: you can watch Claude work here and edit by hand. Edits are saved to the project file after each step.' : `live: you can watch the work happen here and edit by hand. Changes are not saved to disk until you save in ${live.name} (Ctrl+S).`}</span>
        <button className="btn small" onClick={onList}>Software list</button>
      </div>
      <div className="ext-live-stage" ref={ref} />
    </div>
  );
}

/** Every program connected to OmniCandy: the ArtCraft apps (with what each one opens) and third-party software. */
export function SoftwareWorkspace({ apps }: { apps: AppProbeResult[] }) {
  const installed = apps.filter((a) => a.installed).length;
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const launch = async (id: string, name: string, inOmniCandy: boolean) => {
    setMsg(null);
    try { await window.studio.launchApp(id, inOmniCandy); setMsg({ text: inOmniCandy ? `Opening ${name} inside OmniCandy… its window appears here in a few seconds.` : `Opening ${name} in its own window…` }); } catch (e) { setMsg({ text: (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), error: true }); }
  };
  const probe = (id: string) => apps.find((a) => a.appId === id);
  const [live, setLive] = useState<ExternalLiveState | null>(null);
  const [showList, setShowList] = useState(false);
  useEffect(() => {
    void window.studio.external.liveState().then(setLive).catch(() => undefined);
    return window.studio.external.onLive((s) => { setLive(s); if (s.pid) setShowList(false); });
  }, []);
  if (live?.pid && !showList) return <LiveStage live={live} onList={() => setShowList(true)} />;
  return (
    <div className="software-screen">
      {live?.pid && <div className="btn-row"><button className="btn small primary" onClick={() => setShowList(false)}>Back to {live.name}</button></div>}
      <h2>Software</h2>
      <p className="asset-meta">Every program connected to OmniCandy. <strong>Open in OmniCandy</strong> starts it and shows its window right here, so you can start using it without leaving. Programs found on this PC come first.</p>

      <div className="field">
        <span className="menu-label">ArtCraft apps · {installed} of {Object.keys(EDITOR_APPS).length} installed</span>
        {msg && <div className={`wf-msg${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</div>}
        <div className="software-grid">
          {Object.values(EDITOR_APPS).slice().sort((x, y) => Number(!!probe(y.id)?.installed) - Number(!!probe(x.id)?.installed)).map((app) => {
            const p = probe(app.id);
            const state = p?.connected ? 'Open now' : p?.installed ? 'Installed' : 'Not installed';
            return (
              <div key={app.id} className="software-card" aria-label={`${app.name}: ${state}`}>
                <div className="provider-head">
                  <strong>{app.name}</strong>
                  <span className={`chip ${p?.connected ? 'ok' : p?.installed ? 'real' : 'off'}`}><span className="dot" />{state}</span>
                </div>
                <div className="asset-meta">{app.blurb}{p?.version ? ` · ${p.version}` : ''}</div>
                {p?.installed
                  ? (
                    <div className="btn-row">
                      <button className="btn small primary" onClick={() => void launch(app.id, app.name, true)}>Open in OmniCandy</button>
                      <button className="btn small ghost" onClick={() => void launch(app.id, app.name, false)} title="Opens it as its own window">Own window</button>
                    </div>
                  )
                  : <div className="asset-meta">Install {app.name} to use it here.</div>}
              </div>
            );
          })}
        </div>
      </div>

      <ExternalApps />
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExternalLiveState } from '@shared/ipc';
import { useOverlayOpen } from '../overlay';
import { EDITOR_APPS } from '@shared/appEditors';
import type { AppProbeResult } from '@shared/types';
import { ExternalApps } from './ExternalApps';

const TAB_LABEL = { edit: 'Create', color: 'Color', effects: 'Effects', audio: 'Audio' } as const;

/** The window of a third-party program Claude is working in (Blender), shown inside CreateCraft. */
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
        <strong>{live.name}</strong><span className="asset-meta">live: you can watch Claude work here and edit by hand. Edits are saved to the project file after each step.</span>
        <button className="btn small" onClick={onList}>Software list</button>
      </div>
      <div className="ext-live-stage" ref={ref} />
    </div>
  );
}

/** Every program connected to CreateCraft: the ArtCraft apps (with what each one opens) and third-party software. */
export function SoftwareWorkspace({ apps }: { apps: AppProbeResult[] }) {
  const installed = apps.filter((a) => a.installed).length;
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const launch = async (id: string, name: string) => {
    setMsg(null);
    try { await window.studio.launchApp(id); setMsg({ text: `Opening ${name}…` }); } catch (e) { setMsg({ text: (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), error: true }); }
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
      <h2>Software connected to CreateCraft</h2>
      <p className="asset-meta">Claude and you can open and edit your media in these programs. Installed means the program was found on this PC; CreateCraft starts it when you open a file in it.</p>

      <div className="field">
        <span className="menu-label">ArtCraft apps · {installed} of {Object.keys(EDITOR_APPS).length} installed</span>
        {msg && <div className={`wf-msg${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</div>}
        <div className="software-grid">
          {Object.values(EDITOR_APPS).map((app) => {
            const p = probe(app.id);
            const state = p?.connected ? 'Open now' : p?.installed ? 'Installed' : 'Not installed';
            return (
              <div key={app.id} className="software-card" aria-label={`${app.name}: ${state}`}>
                <div className="provider-head">
                  <strong>{app.name}</strong>
                  <span className={`chip ${p?.connected ? 'ok' : p?.installed ? 'real' : 'off'}`}><span className="dot" />{state}</span>
                </div>
                <div className="asset-meta">{app.blurb}{p?.version ? ` · ${p.version}` : ''}</div>
                <div className="asset-meta">Opens: {app.formats.map((f) => `.${f}`).join(' ')}</div>
                {p?.installed && <div className="btn-row"><button className="btn small primary" onClick={() => void launch(app.id, app.name)}>Open {app.name}</button></div>}
                <div className="asset-meta">Found in the {TAB_LABEL[app.tab]} tab · {app.quickEdits.length} quick edit{app.quickEdits.length === 1 ? '' : 's'}</div>
              </div>
            );
          })}
        </div>
      </div>

      <ExternalApps />
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExternalLiveState } from '@shared/ipc';
import { STATUS_LABEL, type ExternalAppInfo } from '@shared/integrations';
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
  const [others, setOthers] = useState<ExternalAppInfo[]>([]);
  const [pick, setPick] = useState('');
  useEffect(() => {
    const load = async () => { let l = await window.studio.external.list().catch(() => [] as ExternalAppInfo[]); if (!l.length) l = (await window.studio.external.scan().catch(() => null))?.apps ?? []; setOthers(l); };
    void load();
  }, []);
  const openOther = async (key: string) => {
    setMsg(null);
    try { setMsg({ text: await window.studio.external.open(key) }); } catch (e) { setMsg({ text: (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), error: true }); }
  };
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
      <p className="asset-meta">Every program connected to OmniCandy, in one list. Choose one and press <strong>Open in OmniCandy</strong>: it starts and its window appears right here, so you can start using it.</p>
      {msg && <div className={`wf-msg${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</div>}
      {(() => {
        const art = Object.values(EDITOR_APPS).slice().sort((x, y) => Number(!!probe(y.id)?.installed) - Number(!!probe(x.id)?.installed));
        const chosen = pick.startsWith('art:') ? art.find((a) => `art:${a.id}` === pick) : undefined;
        const chosenOther = pick.startsWith('ext:') ? others.find((o) => `ext:${o.key}` === pick) : undefined;
        const installedChosen = !!chosen && !!probe(chosen.id)?.installed;
        return (
          <div className="software-pick">
            <label className="field">Program
              <select aria-label="Program" value={pick} onChange={(e) => { setPick(e.target.value); setMsg(null); }}>
                <option value="">Choose a program…</option>
                <optgroup label={`ArtCraft apps · ${installed} of ${art.length} installed`}>
                  {art.map((a) => <option key={a.id} value={`art:${a.id}`}>{a.name}{probe(a.id)?.installed ? '' : ' (not installed)'}</option>)}
                </optgroup>
                <optgroup label={`Other programs · ${others.length} found on this PC`}>
                  {others.map((o) => <option key={o.key} value={`ext:${o.key}`}>{o.adapterName ?? o.name}{o.version ? ` ${o.version}` : ''} ({STATUS_LABEL[o.status].toLowerCase()})</option>)}
                </optgroup>
              </select>
            </label>
            {chosen && <div className="asset-meta">{chosen.blurb}{probe(chosen.id)?.version ? ` · ${probe(chosen.id)?.version}` : ''}{installedChosen ? '' : `. ${chosen.name} is not installed on this PC.`}</div>}
            {chosenOther && <div className="asset-meta">{chosenOther.statusDetail}{chosenOther.notes ? ` ${chosenOther.notes}` : ''}</div>}
            <div className="btn-row">
              <button className="btn primary" disabled={!(installedChosen || chosenOther)} onClick={() => { if (chosen) void launch(chosen.id, chosen.name, true); else if (chosenOther) void openOther(chosenOther.key); }}>Open in OmniCandy</button>
              <button className="btn" disabled={!installedChosen} onClick={() => chosen && void launch(chosen.id, chosen.name, false)} title="Opens it as its own window instead">Open in its own window</button>
            </div>
            {others.length === 0 && <div className="asset-meta">No other programs (Blender, Unreal, Fusion, Resolve…) were found yet. Open <em>Connections and setup</em> below and press Rescan, or Add application location for a portable copy.</div>}
          </div>
        );
      })()}

      <details className="software-setup">
        <summary>Connections and setup (find, connect or repair programs)</summary>
        <ExternalApps />
      </details>
    </div>
  );
}

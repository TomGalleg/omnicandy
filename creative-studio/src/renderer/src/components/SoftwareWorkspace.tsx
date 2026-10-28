import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { groupInstalls, nextStep } from '@shared/softwareList';
import type { ExternalLiveState } from '@shared/ipc';
import { STATUS_LABEL, type ExternalScan, type IntegrationStatus } from '@shared/integrations';
import { useOverlayOpen } from '../overlay';
import { EDITOR_APPS } from '@shared/appEditors';
import type { AppProbeResult } from '@shared/types';
import { EXTERNAL_CHANGED, IntegrationPackages } from './IntegrationPackages';

const CHIP: Record<IntegrationStatus, string> = {
  detected: 'real', available: 'real', connected: 'ok', limited: 'warn', unsupported: 'off', 'needs-repair': 'warn', incompatible: 'warn', 'not-running': 'real', 'api-unavailable': 'warn',
};
const plain = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

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
  const [scan, setScan] = useState<ExternalScan | null>(null);
  const rows = useMemo(() => groupInstalls(scan?.apps ?? []), [scan]);
  const [busy, setBusy] = useState<string | null>(null);
  const rescan = async () => { setBusy('scan'); try { setScan(await window.studio.external.scan()); } catch (e) { setMsg({ text: plain(e), error: true }); } setBusy(null); };
  useEffect(() => { void window.studio.external.list().then((l) => setScan((cur) => cur ?? { apps: l, missing: [] })).catch(() => undefined); void rescan(); }, []);
  useEffect(() => {
    const onChanged = () => { void window.studio.external.list().then((apps) => setScan((cur) => (cur ? { ...cur, apps } : { apps, missing: [] }))).catch(() => undefined); };
    window.addEventListener(EXTERNAL_CHANGED, onChanged);
    return () => window.removeEventListener(EXTERNAL_CHANGED, onChanged);
  }, []);
  /** Connect, disconnect or repair one program, then show its new status. */
  const act = async (key: string, what: 'connect' | 'disconnect' | 'repair') => {
    setBusy(`${what}:${key}`); setMsg(null);
    try {
      if (what === 'connect') await window.studio.external.connect(key); else if (what === 'disconnect') await window.studio.external.disconnect(key); else await window.studio.external.repair(key);
    } catch (e) { setMsg({ text: plain(e), error: true }); } finally {
      await window.studio.external.list().then((apps) => setScan((cur) => (cur ? { ...cur, apps } : { apps, missing: [] }))).catch(() => undefined);
      setBusy(null);
    }
  };
  const openOther = async (key: string) => {
    setMsg(null);
    try { setMsg({ text: await window.studio.external.open(key) }); } catch (e) { setMsg({ text: plain(e), error: true }); }
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
      <p className="asset-meta">Every program connected to OmniCandy, in one list. <strong>Connect</strong> lets OmniCandy and Claude work in a program; <strong>Open in OmniCandy</strong> starts it and shows its window right here so you can start using it.</p>
      {msg && <div className={`wf-msg${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</div>}

      <div className="field">
        <span className="menu-label">ArtCraft apps · {installed} of {Object.keys(EDITOR_APPS).length} installed</span>
        <ul className="software-list">
          {Object.values(EDITOR_APPS).slice().sort((x, y) => Number(!!probe(y.id)?.installed) - Number(!!probe(x.id)?.installed)).map((app) => {
            const p = probe(app.id);
            const state = p?.connected ? 'Open now' : p?.installed ? 'Connected' : 'Not installed';
            return (
              <li key={app.id} className="software-row" aria-label={`${app.name}: ${state}`}>
                <div className="software-info">
                  <strong>{app.name}</strong>
                  <span className={`chip ${p?.connected ? 'ok' : p?.installed ? 'real' : 'off'}`}><span className="dot" />{state}</span>
                  <small>{app.blurb}{p?.version ? ` · ${p.version}` : ''}</small>
                </div>
                <div className="software-actions">
                  {p?.installed
                    ? (<>
                      <button className="btn small primary" onClick={() => void launch(app.id, app.name, true)}>Open in OmniCandy</button>
                      <button className="btn small ghost" onClick={() => void launch(app.id, app.name, false)} title="Opens it as its own window">Own window</button>
                    </>)
                    : <small>Install {app.name} to use it here.</small>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="field">
        <span className="menu-label">Other programs · {rows.length} found on this PC</span>
        <div className="btn-row">
          <button className="btn small" disabled={!!busy} onClick={() => void rescan()}>{busy === 'scan' ? 'Scanning…' : 'Rescan'}</button>
          <button className="btn small ghost" disabled={!!busy} onClick={() => { setBusy('add'); void window.studio.external.addLocation().then((r) => { if (r) setScan(r); }).catch((e: unknown) => setMsg({ text: plain(e), error: true })).finally(() => setBusy(null)); }}>Add a program location…</button>
        </div>
        <ul className="software-list">
          {rows.map(({ app: a, others }) => {
            const next = nextStep(a);
            const connected = a.status === 'connected' || a.status === 'limited';
            const canConnect = a.status === 'available' || a.status === 'needs-repair' || a.status === 'not-running' || a.status === 'api-unavailable' || a.status === 'detected';
            const working = busy?.endsWith(`:${a.key}`);
            return (
              <li key={a.key} className="software-row">
                <div className="software-info">
                  <strong>{a.adapterName ?? a.name}</strong>
                  <span className={`chip ${CHIP[a.status]}`}><span className="dot" />{STATUS_LABEL[a.status]}</span>
                  <small>{a.version ? `version ${a.version}` : 'version unknown'}{a.publisher ? ` · ${a.publisher}` : ''}. {a.statusDetail}</small>
                  {next && <small className="software-next"><strong>Next:</strong> {next}</small>}
                  {others > 0 && <small className="asset-meta">{others === 1 ? '1 other copy' : `${others} other copies`} found on this PC (older or unsupported), hidden.</small>}
                </div>
                <div className="software-actions">
                  {!connected && canConnect && <button className="btn small primary" disabled={!!busy} onClick={() => void act(a.key, 'connect')}>{working ? 'Connecting…' : 'Connect'}</button>}
                  {connected && <button className="btn small" disabled={!!busy} onClick={() => void act(a.key, 'disconnect')}>Disconnect</button>}
                  {(a.status === 'needs-repair' || a.status === 'limited') && <button className="btn small" disabled={!!busy} onClick={() => void act(a.key, 'repair')}>Repair</button>}
                  <button className="btn small" disabled={!!busy || !(connected || canConnect)} title={connected || canConnect ? 'Starts it on a new blank document and shows its window here' : 'Connect it first'} onClick={() => void openOther(a.key)}>Open in OmniCandy</button>
                </div>
              </li>
            );
          })}
          {scan && rows.length === 0 && <li className="asset-meta">No supported programs were found on this PC yet. Press Rescan, or add a portable copy location.</li>}
          {(scan?.missing ?? []).map((m) => (
            <li key={m.adapterId} className="software-row">
              <div className="software-info"><strong>{m.name}</strong><span className="chip off"><span className="dot" />Not found on this PC</span><small>{m.vendor}. Install it, then press Rescan.</small></div>
            </li>
          ))}
        </ul>
      </div>

      <details className="software-setup">
        <summary>Add more connectors (install a connector package)</summary>
        <IntegrationPackages onChanged={() => void rescan()} />
      </details>
    </div>
  );
}

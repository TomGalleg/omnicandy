import { useEffect, useState } from 'react';
import { PERMISSION_LABEL, STATUS_LABEL, type ExternalAppInfo, type ExternalScan, type IntegrationStatus } from '@shared/integrations';
import { IntegrationPackages } from './IntegrationPackages';

const CHIP: Record<IntegrationStatus, string> = {
  detected: 'real', available: 'real', connected: 'ok', limited: 'warn', unsupported: 'off', 'needs-repair': 'warn', incompatible: 'warn', 'not-running': 'real', 'api-unavailable': 'warn',
};

/** Last scan, kept while Settings is closed and reopened so switching tabs does not rescan. */
let cached: ExternalScan | null = null;

/** External third-party applications (Blender, Autodesk, Adobe...): detect, connect, repair. Native Craft apps are listed above. */
export function ExternalApps() {
  const [scan, setScanState] = useState<ExternalScan | null>(cached);
  const setScan = (v: ExternalScan | null | ((s: ExternalScan | null) => ExternalScan | null)) => setScanState((prev) => { const n = typeof v === 'function' ? v(prev) : v; cached = n; return n; });
  const [busy, setBusy] = useState<string | null>(cached ? null : 'scan');
  const [error, setError] = useState<string | null>(null);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)); }
    setBusy(null);
  };
  const rescan = () => run('scan', async () => setScan(await window.studio.external.scan()));
  const refreshList = async () => {
    const apps = await window.studio.external.list();
    setScan((s) => (s ? { ...s, apps } : s));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount; rescan/refreshList only close over setters
  useEffect(() => { if (!cached) void rescan(); else void refreshList(); }, []);

  const act = (key: string, what: 'connect' | 'disconnect' | 'repair' | 'revoke') =>
    run(`${what}:${key}`, async () => {
      try {
        if (what === 'connect') await window.studio.external.connect(key);
        else if (what === 'disconnect') await window.studio.external.disconnect(key);
        else if (what === 'repair') await window.studio.external.repair(key);
        else await window.studio.external.revoke(key);
      } finally {
        // A failed connect still changes the status (Not running, Scripting not available): show it.
        await refreshList().catch(() => undefined);
      }
    });

  const row = (a: ExternalAppInfo) => {
    const working = busy?.endsWith(`:${a.key}`);
    const canConnect = a.status === 'available' || a.status === 'needs-repair' || a.status === 'not-running' || a.status === 'api-unavailable';
    return (
      <li key={a.key} className="ext-row">
        <div className="ext-head">
          <span className={`chip ${CHIP[a.status]}`}><span className="dot" />{STATUS_LABEL[a.status]}</span>
          <strong>{a.adapterName ?? a.name}</strong>
          <small>{a.version ? `version ${a.version}` : 'version unknown'}{a.publisher ? ` · ${a.publisher}` : ''}</small>
        </div>
        <small>{a.statusDetail}</small>
        {a.commands.length > 0 && (
          <small>Can do: {a.commands.map((c) => c.label).join(' · ')}{a.methods.length ? ` (via ${a.methods[0]})` : ''}</small>
        )}
        {a.granted.length > 0 && <small>Allowed: {a.granted.map((p) => PERMISSION_LABEL[p].toLowerCase()).join(', ')}</small>}
        {a.notes && <small className="ext-note">{a.notes}</small>}
        <div className="ext-actions">
          {(a.status === 'connected' || a.status === 'limited') && <button className="btn small" disabled={!!busy} onClick={() => void act(a.key, 'disconnect')}>Disconnect</button>}
          {canConnect && a.status !== 'needs-repair' && <button className="btn small primary" disabled={!!busy} onClick={() => void act(a.key, 'connect')}>{working ? 'Connecting…' : 'Connect'}</button>}
          {(a.status === 'needs-repair' || a.status === 'limited') && <button className="btn small" disabled={!!busy} onClick={() => void act(a.key, 'repair')}>Repair integration</button>}
          {a.granted.length > 0 && <button className="btn small ghost" disabled={!!busy} onClick={() => void act(a.key, 'revoke')}>Forget permissions</button>}
        </div>
      </li>
    );
  };

  const apps = scan?.apps ?? [];
  return (
    <div className="field ext-apps">
      <span className="menu-label">External applications · {apps.length} found</span>
      <div className="ext-actions">
        <button className="btn small" disabled={!!busy} onClick={() => void rescan()}>{busy === 'scan' ? 'Scanning…' : 'Rescan applications'}</button>
        <button className="btn small ghost" disabled={!!busy} onClick={() => void run('add', async () => { const r = await window.studio.external.addLocation(); if (r) setScan(r); })}>Add application location…</button>
      </div>
      {error && <small className="ext-error" role="alert">{error}</small>}
      {scan && apps.length === 0 && <small>No supported external applications were found on this PC.</small>}
      <ul className="status-list ext-list">{apps.map(row)}</ul>
      {scan && scan.missing.length > 0 && (
        <small>Not detected: {scan.missing.map((m) => m.name).join(', ')}. Use “Add application location…” for portable copies.</small>
      )}
      <IntegrationPackages onChanged={() => void rescan()} />
      <small>Scanning happens on this PC only; nothing about your installed software is sent anywhere. Commands run only after you allow them.</small>
    </div>
  );
}

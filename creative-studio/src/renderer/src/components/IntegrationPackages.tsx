import { useEffect, useMemo, useState } from 'react';
import {
  PERMISSION_LABEL,
  type InstalledAdapter, type InstalledState, type JobInfo, type PackageListing, type PackageReview, type Permission,
} from '@shared/integrations';

const STATE_LABEL: Record<InstalledState, string> = {
  ok: 'Ready', disabled: 'Turned off', tampered: 'Files changed', incompatible: 'Needs a newer CreateCraft', 'missing-files': 'Files missing', 'crash-disabled': 'Stopped after crashes',
};
const STATE_CHIP: Record<InstalledState, string> = { ok: 'ok', disabled: 'off', tampered: 'warn', incompatible: 'warn', 'missing-files': 'warn', 'crash-disabled': 'warn' };

const msg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/** Settings > Integrations > installable integration packages, with the review step, permissions and background jobs. */
export function IntegrationPackages({ onChanged }: { onChanged: () => void }) {
  const [listing, setListing] = useState<PackageListing | null>(null);
  const [review, setReview] = useState<PackageReview | null>(null);
  const [granted, setGranted] = useState<Permission[]>([]);
  const [confirmUnsigned, setConfirmUnsigned] = useState(false);
  const [confirmPublisher, setConfirmPublisher] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try { await fn(); } catch (e) { setError(msg(e)); }
    setBusy(null);
  };
  const refresh = async () => { setListing(await window.studio.external.packages()); setJobs(await window.studio.external.jobs()); };
  useEffect(() => { void run('load', refresh); }, []);

  // Poll while a job runs: progress and the final verified result come from main.
  const running = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => { void window.studio.external.jobs().then(setJobs).catch(() => undefined); }, 1000);
    return () => clearInterval(t);
  }, [running]);

  const open = (r: PackageReview) => {
    setReview(r);
    setGranted(r.permissions);
    setConfirmUnsigned(false);
    setConfirmPublisher(false);
  };

  const pick = (kind: 'file' | 'folder') => run('pick', async () => { const r = await window.studio.external.pickPackage(kind); if (r) open(r); });
  const install = () => review && run('install', async () => {
    const l = await window.studio.external.installPackage(review.path, { permissions: granted, allowUnsigned: confirmUnsigned, trustPublisher: confirmPublisher });
    setListing(l);
    setReview(null);
    onChanged();
  });
  const act = (id: string, what: 'enable' | 'disable' | 'repair' | 'uninstall') => run(`${what}:${id}`, async () => {
    const l = what === 'repair' ? await window.studio.external.repairPackage(id)
      : what === 'uninstall' ? await window.studio.external.uninstallPackage(id)
        : await window.studio.external.setPackageEnabled(id, what === 'enable');
    setListing(l);
    onChanged();
  });

  const blocked = !review || review.problems.length > 0
    || (review.signature === 'unsigned' && !confirmUnsigned)
    || (review.signature === 'valid' && !review.publisherTrusted && !confirmPublisher);

  const trustLabel = (r: Pick<PackageReview, 'signature' | 'publisherTrusted'>) =>
    r.signature === 'invalid' ? 'Signature invalid' : r.signature === 'unsigned' ? 'Not signed' : r.publisherTrusted ? 'Signed, trusted publisher' : 'Signed, new publisher';
  const trustChip = (r: Pick<PackageReview, 'signature' | 'publisherTrusted'>) => (r.signature === 'valid' && r.publisherTrusted ? 'ok' : 'warn');

  const row = (a: InstalledAdapter) => {
    const working = busy?.endsWith(`:${a.id}`);
    return (
      <li key={a.id} className="ext-row">
        <div className="ext-head">
          <span className={`chip ${STATE_CHIP[a.state]}`}><span className="dot" />{STATE_LABEL[a.state]}</span>
          <strong>{a.name}</strong>
          <small>version {a.version} · {a.publisherName}</small>
          <span className={`chip ${a.trust === 'unsigned' ? 'warn' : 'ok'}`}><span className="dot" />{a.trust === 'unsigned' ? 'Not signed' : 'Signed'}</span>
        </div>
        {a.description && <small>{a.description}</small>}
        <small>{a.stateDetail}</small>
        <small>
          {a.selfContained ? 'Needs no other program.' : `Controls ${a.applicationName}; the program must be installed on this PC.`}
          {' '}Allowed: {a.approvedPermissions.length ? a.approvedPermissions.map((p) => PERMISSION_LABEL[p].toLowerCase()).join(', ') : 'nothing beyond its own files'}.
          {' '}Runs in its own restricted process. {a.license ? `Licence: ${a.license}.` : ''}
        </small>
        {a.requirements.length > 0 && <small className="ext-note">Needs: {a.requirements.map((q) => q.text).join(' · ')}</small>}
        <div className="ext-actions">
          {a.enabled
            ? <button className="btn small" disabled={!!busy} onClick={() => void act(a.id, 'disable')}>Turn off</button>
            : <button className="btn small primary" disabled={!!busy} onClick={() => void act(a.id, 'enable')}>Turn on</button>}
          <button className="btn small" disabled={!!busy} onClick={() => void pick('file')}>Update…</button>
          {(a.state === 'tampered' || a.state === 'missing-files' || a.state === 'crash-disabled') && (
            <button className="btn small primary" disabled={!!busy} onClick={() => void act(a.id, 'repair')}>{working ? 'Repairing…' : 'Repair'}</button>
          )}
          <button className="btn small ghost" disabled={!!busy} onClick={() => void act(a.id, 'uninstall')}>Remove</button>
        </div>
      </li>
    );
  };

  const reviewPanel = useMemo(() => {
    if (!review) return null;
    const requested = review.permissions;
    return (
      <div className="ext-row ext-review" role="group" aria-label="Review integration package">
        <div className="ext-head">
          <strong>{review.name ?? 'Unreadable package'}</strong>
          {review.version && <small>version {review.version}</small>}
          {review.publisherName && <small>by {review.publisherName}</small>}
          <span className={`chip ${trustChip(review)}`}><span className="dot" />{trustLabel(review)}</span>
        </div>
        {review.description && <small>{review.description}</small>}
        {review.fingerprint && <small>Publisher key: <code>{review.fingerprint}</code></small>}
        {review.installedVersion && <small>Installed now: version {review.installedVersion}.</small>}
        <small>{review.selfContained ? 'It needs no other program.' : `It controls ${review.applicationName ?? 'a program'} that must already be installed.`}</small>
        {review.requirements.length > 0 && <small className="ext-note">Needs: {review.requirements.map((q) => q.text).join(' · ')}</small>}
        {review.problems.map((p) => <small key={p} className="ext-error" role="alert">{p}</small>)}
        {review.warnings.map((w) => <small key={w} className="ext-note">{w}</small>)}
        {review.commands.length > 0 && (
          <div className="field">
            <span className="menu-label">What it can do</span>
            <ul className="status-list">
              {review.commands.map((c) => (
                <li key={c.id}><small><strong>{c.label}</strong>: {c.description}{c.destructive ? ' (can change existing work; asked every time)' : ''}{c.longRunning ? ' (runs as a background job)' : ''}</small></li>
              ))}
            </ul>
          </div>
        )}
        {requested.length > 0 && (
          <div className="field">
            <span className="menu-label">Permissions it asks for</span>
            {requested.map((p) => (
              <label key={p} className="ext-check">
                <input type="checkbox" checked={granted.includes(p)} onChange={(e) => setGranted((g) => (e.target.checked ? [...g, p] : g.filter((x) => x !== p)))} />
                {PERMISSION_LABEL[p]}
              </label>
            ))}
            <small>Unchecked permissions are refused for good: commands that need them will not run. You are also asked when a command first needs one.</small>
          </div>
        )}
        {review.signature === 'unsigned' && (
          <label className="ext-check"><input type="checkbox" checked={confirmUnsigned} onChange={(e) => setConfirmUnsigned(e.target.checked)} />I understand this package is not signed and will ask me before every command.</label>
        )}
        {review.signature === 'valid' && !review.publisherTrusted && (
          <label className="ext-check"><input type="checkbox" checked={confirmPublisher} onChange={(e) => setConfirmPublisher(e.target.checked)} />I trust {review.publisherName} (key {review.fingerprint}).</label>
        )}
        <div className="ext-actions">
          <button className="btn small primary" disabled={blocked || !!busy} onClick={() => void install()}>{busy === 'install' ? 'Installing…' : review.action === 'update' ? 'Update' : 'Install'}</button>
          <button className="btn small ghost" disabled={!!busy} onClick={() => setReview(null)}>Cancel</button>
        </div>
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- install/trust helpers close over the state listed
  }, [review, granted, confirmUnsigned, confirmPublisher, busy]);

  const installed = listing?.installed ?? [];
  const inbox = (listing?.inbox ?? []).filter((r) => r.action !== 'reinstall');
  const recentJobs = jobs.slice(0, 5);

  return (
    <div className="field ext-packages">
      <span className="menu-label">Integration packages · {installed.length} installed</span>
      <small>Add support for another program by installing an integration package. CreateCraft checks the package before anything runs, and each integration works in its own restricted process.</small>
      <div className="ext-actions">
        <button className="btn small" disabled={!!busy} onClick={() => void pick('file')}>Install integration package…</button>
        <button className="btn small ghost" disabled={!!busy} onClick={() => void pick('folder')}>Install from folder…</button>
        <button className="btn small ghost" disabled={!!busy} onClick={() => void run('load', refresh)}>Refresh</button>
      </div>
      {error && <small className="ext-error" role="alert">{error}</small>}
      {reviewPanel}
      {installed.length === 0 && !review && <small>No integration packages are installed.</small>}
      <ul className="status-list ext-list">{installed.map(row)}</ul>
      {inbox.length > 0 && (
        <div className="field">
          <span className="menu-label">Waiting in the inbox folder</span>
          <ul className="status-list ext-list">
            {inbox.map((r) => (
              <li key={r.path} className="ext-row">
                <div className="ext-head">
                  <strong>{r.name ?? r.path.split(/[\\/]/).pop()}</strong>
                  {r.version && <small>version {r.version}</small>}
                  <span className={`chip ${r.problems.length ? 'warn' : trustChip(r)}`}><span className="dot" />{r.problems.length ? 'Cannot be installed' : trustLabel(r)}</span>
                </div>
                {r.problems.length > 0 && <small className="ext-error">{r.problems[0]}</small>}
                <div className="ext-actions"><button className="btn small" disabled={!!busy} onClick={() => open(r)}>Review…</button></div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {listing && <small>Packages placed in <code>{listing.inboxDir}</code> are listed here but never run until you install them.</small>}
      {recentJobs.length > 0 && (
        <div className="field">
          <span className="menu-label">Background jobs</span>
          <ul className="status-list">
            {recentJobs.map((j) => (
              <li key={j.id} className="ext-job">
                <small>
                  <strong>{j.commandId}</strong> in {j.appName}: {j.status}{j.status === 'running' ? ` · ${j.stage}${j.fraction !== null ? ` (${Math.round(j.fraction * 100)}%)` : ''}` : j.result ? ` · ${j.result.message}` : ''}
                </small>
                {j.status === 'running' && <button className="btn small ghost" onClick={() => void window.studio.external.cancelJob(j.id).then(setJobs)}>Cancel</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import {
  INTEGRATION_TYPE_LABEL, PERMISSION_LABEL,
  type InstalledAdapter, type InstalledState, type JobInfo, type PackageApproval, type PackageListing, type PackageReview,
} from '@shared/integrations';
import { announceExternalChanged, errorText, EXTERNAL_CHANGED } from '../connect/events';
import { PackageReviewCard, trustChip, trustLabel } from '../connect/PackageReviewCard';

const STATE_LABEL: Record<InstalledState, string> = {
  ok: 'Ready', disabled: 'Turned off', tampered: 'Files changed', incompatible: 'Needs a newer CreateCraft', 'missing-files': 'Files missing', 'crash-disabled': 'Stopped after crashes',
};
const STATE_CHIP: Record<InstalledState, string> = { ok: 'ok', disabled: 'off', tampered: 'warn', incompatible: 'warn', 'missing-files': 'warn', 'crash-disabled': 'warn' };

export { EXTERNAL_CHANGED };

/** Settings > Integrations > installable integration packages, with the review step, permissions and background jobs. */
export function IntegrationPackages({ onChanged }: { onChanged: () => void }) {
  const [listing, setListing] = useState<PackageListing | null>(null);
  const [review, setReview] = useState<PackageReview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try { await fn(); if (what !== 'load') announceExternalChanged(); } catch (e) { setError(errorText(e)); }
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

  const open = (r: PackageReview) => setReview(r);

  const pick = (kind: 'file' | 'folder') => run('pick', async () => { const r = await window.studio.external.pickPackage(kind); if (r) open(r); });
  const install = (approval: PackageApproval) => review && run('install', async () => {
    const l = await window.studio.external.installPackage(review.path, approval);
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
        {a.integrationType !== 'external' && (
          <small><strong>{INTEGRATION_TYPE_LABEL[a.integrationType]}.</strong> Add-in: {a.pluginState === 'connected' ? 'connected and tested' : a.pluginDetail}</small>
        )}
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
      {review && <PackageReviewCard key={review.path} review={review} busy={busy === 'install'} onConfirm={(a) => void install(a)} onCancel={() => setReview(null)} />}
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

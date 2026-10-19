import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { INTEGRATION_TYPE_LABEL, type PackageApproval, type PackageReview } from '@shared/integrations';
import { STAGE_LABEL, STAGE_ORDER, TEMPLATE_LABEL, type BuilderProjectDetail, type BuilderProgress, type PipelineReport } from '@shared/builder';
import { announceExternalChanged, errorText } from '../connect/events';
import { PackageReviewCard } from '../connect/PackageReviewCard';
import { PermissionExplainer } from '../connect/PermissionExplainer';

const RUNNING = new Set(['researching', 'building', 'testing']);
const STATE_CHIP = { passed: 'ok', failed: 'warn', warning: 'real', skipped: 'off' } as const;
const STATE_TEXT = { passed: 'Passed', failed: 'Failed', warning: 'Passed with a note', skipped: 'Not run' } as const;
const STAGE_NAME: Record<PipelineReport['stage'], string> = { static: 'Checks on the connector', security: 'Safety checks', simulated: 'Safe trial run with a pretend program', live: 'Test on the real program' };

type Tab = 'checks' | 'research' | 'files' | 'log' | 'versions' | 'about';

function ReportList({ reports }: { reports: PipelineReport[] }) {
  if (!reports.length) return <small>No checks have run yet.</small>;
  return (
    <div className="builder-reports">
      {reports.map((r) => (
        <section key={r.stage} className="field" aria-label={STAGE_NAME[r.stage]}>
          <span className="menu-label">{STAGE_NAME[r.stage]} <span className={`chip ${STATE_CHIP[r.state]}`}><span className="dot" />{STATE_TEXT[r.state]}</span>{r.mock ? <span className="chip real"><span className="dot" />Simulated</span> : null}</span>
          <ul className="status-list">
            {r.checks.map((c) => (
              <li key={c.id}><span className={`chip ${STATE_CHIP[c.state]}`}><span className="dot" />{STATE_TEXT[c.state]}</span> <small><strong>{c.title}.</strong> {c.detail}</small></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Advanced({ d, onRefreshDocs, busy }: { d: BuilderProjectDetail; onRefreshDocs: () => void; busy: boolean }) {
  const [tab, setTab] = useState<Tab>('checks');
  const [file, setFile] = useState<string>('adapter.json');
  const shown = d.files.find((f) => f.path === file) ?? d.files[0];
  const tabs: Array<[Tab, string]> = [['checks', 'Checks'], ['research', 'Research and sources'], ['files', 'Generated files'], ['log', 'Log'], ['versions', 'Versions'], ['about', 'Diagnostics']];
  return (
    <details className="more-details builder-advanced">
      <summary>Advanced: logs, manifest, generated source and diagnostics</summary>
      <div className="builder-tabs" role="tablist" aria-label="Advanced details">
        {tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={`btn small ${tab === id ? 'primary' : 'ghost'}`} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === 'checks' && <ReportList reports={d.reports} />}
      {tab === 'research' && (
        <div className="field">
          {d.research ? (
            <>
              <small>{d.research.summary}</small>
              <span className="menu-label">Sources {d.research.sourcesConsulted ? '' : '(none were read)'}</span>
              <ul className="status-list">{d.research.sources.map((s) => <li key={s.url}><small><strong>{s.title}</strong> · {s.kind}<span className="ext-block">{s.url}</span>{s.note ? <span className="ext-block">{s.note}</span> : null}</small></li>)}</ul>
              <span className="menu-label">Ways to connect it</span>
              <ul className="status-list">{d.research.methods.map((m) => <li key={m.method}><small><strong>{m.method}</strong> ({m.officialSupport} support): {m.note}</small></li>)}</ul>
              {d.research.limitations.length > 0 && <><span className="menu-label">Limits</span><ul className="status-list">{d.research.limitations.map((l) => <li key={l}><small>{l}</small></li>)}</ul></>}
              <small>Licence: {d.research.licensing || 'not stated'}. Needs: {d.research.requiredTools.join('; ') || 'nothing else'}.</small>
              <span className="menu-label">Documentation used (kept on this computer)</span>
              {d.documentation.length === 0 ? <small>No documentation was collected by CreateCraft; only what Claude read itself.</small> : (
                <ul className="status-list">{d.documentation.map((x) => <li key={x.url}><small><strong>{x.title}</strong> · {x.originLabel} · {x.versionNote} · {new Date(x.fetchedAt).toLocaleDateString()}{x.outdated ? ' · outdated' : ''}<span className="ext-block">{x.url}</span></small></li>)}</ul>
              )}
              <div className="ext-actions"><button className="btn small" disabled={busy} onClick={onRefreshDocs}>Refresh official documentation</button></div>
              {d.decision && <small>Chosen method: <strong>{TEMPLATE_LABEL[d.decision.template]}</strong> ({INTEGRATION_TYPE_LABEL[d.decision.type]}). {d.decision.rationale}</small>}
            </>
          ) : <small>No research yet.</small>}
        </div>
      )}
      {tab === 'files' && (
        <div className="field">
          {d.files.length === 0 ? <small>Nothing was generated.</small> : (
            <>
              <div className="builder-tabs">{d.files.map((f) => <button key={f.path} className={`btn small ${shown?.path === f.path ? 'primary' : 'ghost'}`} onClick={() => setFile(f.path)}>{f.path}</button>)}</div>
              {shown?.text != null ? <pre className="builder-code" tabIndex={0} aria-label={`Contents of ${shown.path}`}>{shown.text}</pre> : <small>{shown?.path} is {shown?.bytes} bytes (not shown).</small>}
            </>
          )}
        </div>
      )}
      {tab === 'log' && <pre className="builder-code" tabIndex={0} aria-label="Build log">{d.log.map((l) => `${new Date(l.at).toLocaleTimeString()}  ${l.stage ? `[${STAGE_LABEL[l.stage]}] ` : ''}${l.text}`).join('\n')}</pre>}
      {tab === 'versions' && (
        <ul className="status-list">
          {d.versions.map((v) => <li key={v.version}><small><strong>{v.version}</strong>{v.current ? ' · current' : ''}{v.installed ? ' · installed' : ''} · {new Date(v.createdAt).toLocaleString()} · {v.reason}<span className="ext-block">SHA-256 {v.sha256.slice(0, 16)}…</span></small></li>)}
          {d.versions.length === 0 && <li><small>No package was built.</small></li>}
        </ul>
      )}
      {tab === 'about' && (
        <dl className="kv">
          <dt>Project</dt><dd>{d.id}</dd>
          <dt>Integration id</dt><dd>{d.adapterId ?? 'none'}</dd>
          <dt>Written by</dt><dd>{d.log.length ? 'Claude, via your Claude sign-in (the blueprint records who wrote it)' : 'n/a'}</dd>
          <dt>Declared versions</dt><dd>{d.compatibility.declared}</dd>
          <dt>Tested versions</dt><dd>{d.compatibility.tested.join(', ') || 'none'}</dd>
          <dt>Claude usage</dt><dd>{d.usage.calls} call{d.usage.calls === 1 ? '' : 's'}{d.usage.costUsd ? ` · about $${d.usage.costUsd.toFixed(2)} of usage on your Claude sign-in` : ''}</dd>
          <dt>Documentation</dt><dd>{d.request.documentation.join(', ') || 'none supplied'}</dd>
        </dl>
      )}
    </details>
  );
}

interface Props { id: string; onChanged?: () => void; onRetry?: (d: BuilderProjectDetail) => void }

/** One generated integration: progress while it is being built, then what it can do, what it may do, its checks, and the next safe step. */
export function ProjectView({ id, onChanged, onRetry }: Props) {
  const [d, setD] = useState<BuilderProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [liveProject, setLiveProject] = useState('');
  const [review, setReview] = useState<{ review: PackageReview; kind: 'install' | 'fix' } | null>(null);
  const [live, setLive] = useState<PipelineReport | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try { const x = await window.studio.builder.detail(id); if (alive.current) setD(x); return x; } catch (e) { if (alive.current) setError(errorText(e)); return null; }
  }, [id]);

  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  useEffect(() => {
    const off = window.studio.builder.onProgress((p: BuilderProgress) => { if (p.projectId === id) void refresh(); });
    return off;
  }, [id, refresh]);
  useEffect(() => {
    if (!d || !RUNNING.has(d.status)) return undefined;
    const t = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(t);
  }, [d, refresh]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); await refresh(); onChanged?.(); }
  };

  const openReview = (path: string, kind: 'install' | 'fix') => run('review', async () => { setReview({ review: await window.studio.external.reviewPackage(path), kind }); });

  const install = (approval: PackageApproval) => run('install', async () => {
    if (!review) return;
    await window.studio.external.installPackage(review.review.path, approval);
    setReview(null);
    await window.studio.builder.sync(id);
    announceExternalChanged();
    setNotice(review.kind === 'fix' ? 'The fix is installed. Test it on the real program to confirm it works.' : 'Installed. Next: connect and test it on the real program.');
  });

  const connectAndTest = () => run('connect', async () => {
    const apps = await window.studio.external.list();
    const app = apps.find((a) => a.adapterId === d?.adapterId);
    if (!app) throw new Error(`${d?.request.appName} was not found on this computer. Install it or use Browse for Application in Connect Applications, then try again.`);
    const out = await window.studio.connect.connectApp(app.key);
    announceExternalChanged();
    if (out.state !== 'verified' && out.state !== 'verified-limited') throw new Error(`${out.headline} ${out.detail}`);
    setNotice(`${out.headline}. Now testing every command on the real program. Each test asks you first.`);
    setLive(await window.studio.builder.verifyLive(id, d?.needsProject ? liveProject.trim() : undefined));
    await window.studio.builder.sync(id);
  });

  const testOnly = () => run('live', async () => { setLive(await window.studio.builder.verifyLive(id, d?.needsProject ? liveProject.trim() : undefined)); await window.studio.builder.sync(id); });
  const propose = (why?: { commandId?: string; error?: string }) => run('propose', async () => { await window.studio.builder.propose(id, why); });
  const discard = () => run('discard', async () => { await window.studio.builder.discardProposal(id); });
  const removeIt = () => run('remove', async () => { await window.studio.builder.removeIntegration(id); announceExternalChanged(); setNotice('Removed. Your saved versions are kept; you can install it again.'); });
  const rollback = (v: string) => run('rollback', async () => { await window.studio.builder.rollback(id, v); announceExternalChanged(); setNotice(`Went back to version ${v}.`); });
  const checkCompat = () => run('compat', async () => { const c = await window.studio.builder.compatibility(id); setNotice(c.message); if (c.needsCheck) setNotice(`${c.message} Use “Update for this version” to let Claude check the documentation.`); });

  const failedCmd = useMemo(() => d?.commands.find((c) => c.verifications.some((v) => v.state === 'failed')), [d]);
  if (!d) return <div className="connect-empty" aria-busy="true"><strong>Loading…</strong>{error && <small className="ext-error" role="alert">{error}</small>}</div>;

  const running = RUNNING.has(d.status);
  const proposal = d.proposal;
  const stageIdx = d.stage ? STAGE_ORDER.indexOf(d.stage) : -1;
  const readonlyCmds = d.commands.filter((c) => c.readOnly);
  const changing = d.commands.filter((c) => !c.readOnly);
  const sim = d.reports.find((r) => r.stage === 'simulated');
  const sec = d.reports.find((r) => r.stage === 'security');

  return (
    <div className="builder-project" data-status={d.status}>
      {error && <small className="ext-error" role="alert">{error}</small>}
      {notice && <small className="connect-notice" role="status">{notice}</small>}

      <div className="ext-head">
        <strong>{d.appName}</strong>
        <span className={`chip ${d.status === 'live-verified' ? 'ok' : d.status === 'failed' || d.status === 'needs-repair' || d.status === 'not-feasible' || d.status === 'needs-documentation' ? 'warn' : 'real'}`}><span className="dot" />{d.statusLabel}</span>
        {d.template && <small>{TEMPLATE_LABEL[d.template]}</small>}
        {d.version && <small>version {d.version}</small>}
      </div>
      <p className="connect-lead" role="status">{d.headline}</p>

      {running && (
        <ol className="connect-progress" aria-label="Progress">
          {STAGE_ORDER.filter((s) => s !== 'connecting' && s !== 'connected').map((s, i) => (
            <li key={s} className={i < stageIdx ? 'step-done' : i === stageIdx ? 'step-running' : ''}>{i < stageIdx ? '✓' : i === stageIdx ? '…' : '○'} {STAGE_LABEL[s]}</li>
          ))}
        </ol>
      )}
      {running && <small className="ext-note">{d.log.at(-1)?.text}</small>}
      {running && <div className="ext-actions"><button className="btn small" onClick={() => void window.studio.builder.cancel(id)}>Cancel</button></div>}

      {!running && d.nextSteps.length > 0 && (
        <div className="field" role="note">
          <span className="menu-label">What to do next</span>
          <ul className="status-list">{d.nextSteps.map((s) => <li key={s}><small>{s}</small></li>)}</ul>
        </div>
      )}
      {d.status === 'failed' && d.error && <small className="ext-error" role="alert">{d.error}</small>}

      {d.commands.length > 0 && !running && (
        <div className="field">
          <span className="menu-label">What it can do</span>
          <ul className="status-list">
            {[...readonlyCmds, ...changing].map((c) => {
              const v = c.verifications.at(-1);
              return (
                <li key={c.id}>
                  <small><strong>{c.label}</strong>: {c.description}{c.destructive ? ' (asked every time)' : ''}</small>{' '}
                  <span className={`chip ${v?.state === 'verified' ? 'ok' : v?.state === 'failed' ? 'warn' : 'off'}`}><span className="dot" />{v?.state === 'verified' ? `Tested on ${v.appVersion}` : v?.state === 'failed' ? `Failed on ${v.appVersion}` : 'Not tested on the real program'}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {d.permissions.length > 0 && !running && (
        <div className="field">
          <span className="menu-label">What you would be allowing</span>
          <PermissionExplainer permissions={d.permissions} />
        </div>
      )}

      {!running && sec && sim && (
        <small className="ext-note">
          Safety checks: {STATE_TEXT[sec.state].toLowerCase()}. Trial run: {STATE_TEXT[sim.state].toLowerCase()} — {sim.mock ? 'done with a pretend program, so it shows the steps work, not that the real program accepts them.' : ''}
        </small>
      )}

      {/* the next safe step */}
      {!running && !review && d.installed && d.needsProject && (
        <div className="field">
          <label className="menu-label" htmlFor="live-project">Project for the live test ({d.needsProject})</label>
          <input id="live-project" className="text-input" placeholder={`Full path, for example C:\\Projects\\Test\\Test${d.needsProject}`} value={liveProject} onChange={(e) => setLiveProject(e.target.value)} />
          <small>{d.appName} works with project files. The tests run on this project, and each command asks you first. Use a copy or a test project, because commands may change it.</small>
        </div>
      )}
      {!running && !review && (
        <div className="ext-actions">
          {d.status === 'ready-for-approval' && d.packagePath && !d.installed && <button className="btn small primary" disabled={!!busy} onClick={() => void openReview(d.packagePath!, 'install')}>Review and approve installation…</button>}
          {d.status === 'awaiting-live-verification' && d.packagePath && !d.installed && d.appInstalled && <button className="btn small primary" disabled={!!busy} onClick={() => void openReview(d.packagePath!, 'install')}>Review and approve installation…</button>}
          {d.installed && <button className="btn small primary" disabled={!!busy} onClick={() => void connectAndTest()}>{busy === 'connect' ? 'Testing…' : d.verification.verified ? 'Connect and test again' : 'Connect and test on the real program'}</button>}
          {d.installed && <button className="btn small" disabled={!!busy} onClick={() => void testOnly()}>{busy === 'live' ? 'Testing…' : 'Test commands only'}</button>}
          {d.installed && <button className="btn small" disabled={!!busy} onClick={() => void checkCompat()}>Check version</button>}
          {d.installed && <button className="btn small" disabled={!!busy} onClick={() => void propose({ commandId: failedCmd?.id })}>{busy === 'propose' ? 'Claude is working…' : failedCmd ? 'Repair integration' : 'Update for this version'}</button>}
          {d.installed && <button className="btn small ghost" disabled={!!busy} onClick={() => void removeIt()}>Remove integration</button>}
          {(d.status === 'failed' || d.status === 'needs-documentation' || d.status === 'not-feasible') && onRetry && <button className="btn small primary" onClick={() => onRetry(d)}>Try again…</button>}
        </div>
      )}
      {d.status === 'awaiting-live-verification' && !d.appInstalled && <small className="ext-note">Awaiting live verification: nothing about this integration has been proven against the real {d.appName}. When it is installed, come back here to review, install and test it.</small>}

      {review && (
        <PackageReviewCard review={review.review} busy={busy === 'install'} intro={review.kind === 'fix' ? 'Claude proposed a fix. Review exactly what changes before it replaces the working version.' : `Written by Claude for this computer only. Review what it may do before anything is installed.`} confirmLabel={review.kind === 'fix' ? 'Install the fix' : 'Install'} onConfirm={(a) => void install(a)} onCancel={() => setReview(null)} />
      )}

      {proposal && !review && (
        <section className="field builder-proposal" aria-label="Proposed fix">
          <span className="menu-label">Proposed fix · {proposal.fromVersion} → {proposal.toVersion}</span>
          <small><strong>Problem:</strong> {proposal.problem}</small>
          <ul className="status-list">
            {proposal.diagnosis.map((x) => <li key={x}><small>{x}</small></li>)}
          </ul>
          <small>
            Changes: {proposal.changes.changed.length ? `changed ${proposal.changes.changed.join(', ')}` : ''} {proposal.changes.added.length ? `· new ${proposal.changes.added.join(', ')}` : ''} {proposal.changes.removed.length ? `· removed ${proposal.changes.removed.join(', ')}` : ''}
            {proposal.changes.newPermissions.length ? ` · NEW permissions: ${proposal.changes.newPermissions.join(', ')}` : ' · no new permissions'}
          </small>
          {proposal.changes.notes.map((n) => <small key={n} className="ext-note">Claude says: {n}</small>)}
          <ReportList reports={proposal.reports} />
          <div className="ext-actions">
            <button className="btn small primary" disabled={!proposal.passed || !proposal.packagePath || !!busy} onClick={() => void openReview(proposal.packagePath!, 'fix')}>Review and install the fix…</button>
            <button className="btn small ghost" disabled={!!busy} onClick={() => void discard()}>Discard</button>
          </div>
          <small className="ext-note">Your current version {proposal.fromVersion} stays saved. You can go back to it at any time.</small>
        </section>
      )}

      {live && (
        <section className="field" aria-label="Live test result">
          <span className="menu-label">{live.title} <span className={`chip ${STATE_CHIP[live.state]}`}><span className="dot" />{STATE_TEXT[live.state]}</span></span>
          <ul className="status-list">{live.checks.map((c) => <li key={c.id}><span className={`chip ${STATE_CHIP[c.state]}`}><span className="dot" />{STATE_TEXT[c.state]}</span> <small><strong>{c.title}.</strong> {c.detail}</small></li>)}</ul>
        </section>
      )}

      {d.versions.length > 1 && !running && (
        <details className="more-details">
          <summary>Earlier versions ({d.versions.length - 1})</summary>
          <ul className="status-list">
            {d.versions.filter((v) => !v.installed).map((v) => (
              <li key={v.version}><small>Version {v.version} · {new Date(v.createdAt).toLocaleString()} · {v.reason}</small>{d.installed && <button className="btn small ghost" disabled={!!busy} onClick={() => void rollback(v.version)}>Go back to this version</button>}</li>
            ))}
          </ul>
        </details>
      )}

      <Advanced d={d} busy={!!busy} onRefreshDocs={() => void run('docs', async () => { const r = await window.studio.builder.refreshDocs(id); setNotice(r.notes.join(' ') || `Documentation refreshed (${r.count} documents).`); })} />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ADAPTER_STATE_LABEL, chipText, GROUP_CHIP, GROUP_ORDER, GROUP_TITLE,
  type ConnectEntry, type ConnectOverview,
} from '@shared/connect';
import { runSetup, summarise, type AdapterDecision, type AppRun } from '@shared/connectFlow';
import type { PackageReview } from '@shared/integrations';
import { announceExternalChanged, errorText } from './events';
import { PackageReviewCard } from './PackageReviewCard';
import { PermissionExplainer } from './PermissionExplainer';

type Phase = 'scanning' | 'choose' | 'permissions' | 'running' | 'done';

interface Prompt { entry: ConnectEntry; review: PackageReview | null }

const RUN_CHIP: Record<AppRun['outcome'], string> = {
  pending: 'off', working: 'real', verified: 'ok', 'verified-limited': 'ok', blocked: 'warn', failed: 'warn', cancelled: 'off', skipped: 'off',
};
const RUN_LABEL: Record<AppRun['outcome'], string> = {
  pending: 'Waiting', working: 'Working…', verified: 'Connected and tested', 'verified-limited': 'Connected (experimental)', blocked: 'Needs your action', failed: 'Not connected', cancelled: 'Not set up', skipped: 'Skipped',
};
const STEP_MARK = { todo: '○', running: '…', done: '✓', failed: '✗', skipped: '–' } as const;
const ADAPTER_STEP = { todo: 'Review and install the connector', running: 'Reviewing the connector…', done: 'Connector reviewed and installed', failed: 'Connector not installed', skipped: 'Connector not installed' } as const;
const CONNECT_STEP = { todo: 'Connect and test', running: 'Connecting and testing…', done: 'Connected and tested', failed: 'Could not connect and test', skipped: 'Not connected' } as const;

const nameOf = (e: ConnectEntry) => e.adapterName ?? e.name;
const where = (e: ConnectEntry) => (e.installType === 'portable' ? 'Portable copy you added' : e.installType === 'running' ? 'Found running' : e.installType === 'path' ? 'Found on the PATH' : null);

/**
 * Universal Connect: find the programs on this PC, pick one or several, read what each connector may do, then set them up
 * one by one. Every program has its own install, trust, permission and verification outcome. Built on the existing
 * `window.studio.external` (packages, trust) and `window.studio.connect` APIs.
 */
export function ConnectWizard({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('scanning');
  const [overview, setOverview] = useState<ConnectOverview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runs, setRuns] = useState<AppRun[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [forgetKey, setForgetKey] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [announce, setAnnounce] = useState('');
  const cancelled = useRef(false);
  const resolvePrompt = useRef<((d: AdapterDecision) => void) | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Keyboard: focus lands in the dialog, Tab stays inside it, focus returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => { opener?.focus?.(); };
  }, []);
  useEffect(() => { heading.current?.focus(); }, [phase]);

  const load = useCallback(async (rescan: boolean) => {
    setError(null);
    try {
      const o = await window.studio.connect.overview(rescan);
      if (!alive.current) return o;
      setOverview(o);
      setSelected((prev) => new Set([...prev].filter((k) => o.entries.some((e) => e.key === k && e.selectable))));
      return o;
    } catch (e) { if (alive.current) setError(errorText(e)); return null; }
  }, []);

  useEffect(() => {
    void (async () => {
      const o = await load(true);
      if (!alive.current) return;
      setPhase('choose');
      if (o) {
        // A first look: preselect nothing, but say what was found.
        setAnnounce(`Scan finished. ${o.entries.length} program${o.entries.length === 1 ? '' : 's'} found.`);
      }
    })();
  }, [load]);

  // Anything that changes the list elsewhere (Settings, another window action) refreshes it here too.
  useEffect(() => {
    const h = () => { void load(false); };
    window.addEventListener('createcraft:external-apps-changed', h);
    return () => window.removeEventListener('createcraft:external-apps-changed', h);
  }, [load]);

  const entries = useMemo(() => overview?.entries ?? [], [overview]);
  const chosen = useMemo(() => entries.filter((e) => selected.has(e.key)), [entries, selected]);
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleOpen = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const rescan = async () => {
    setBusy('scan'); setNotice(null);
    const o = await load(true);
    setBusy(null);
    if (o) setAnnounce(`Scan finished. ${o.entries.length} program${o.entries.length === 1 ? '' : 's'} found.`);
    announceExternalChanged();
  };

  const browse = async (kind: 'file' | 'folder') => {
    setBusy('browse'); setNotice(null); setError(null);
    try {
      const r = await window.studio.connect.browse(kind);
      if (r.kind === 'cancelled') return;
      setNotice(r.message);
      setAnnounce(r.message);
      const o = await load(false);
      announceExternalChanged();
      if (r.kind === 'added' && o?.entries.some((e) => e.key === r.key && e.selectable)) setSelected((s) => new Set(s).add(r.key));
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };

  const forget = async (e: ConnectEntry) => {
    setBusy(`forget:${e.key}`); setForgetKey(null); setNotice(null); setError(null);
    try {
      const r = await window.studio.connect.forget(e.key);
      setNotice(r.message);
      setAnnounce(r.message);
      await load(false);
      announceExternalChanged();
    } catch (err) { setError(errorText(err)); } finally { setBusy(null); }
  };

  // ---- the run ----

  const start = async (list: ConnectEntry[]) => {
    cancelled.current = false;
    setCancelling(false);
    setPhase('running');
    setError(null);
    const final = await runSetup(list, {
      askAdapter: async (entry) => {
        const o = entry.offer!;
        const review = o.path ? await window.studio.external.reviewPackage(o.path) : null;
        return new Promise<AdapterDecision>((resolve) => { resolvePrompt.current = resolve; setPrompt({ entry, review }); });
      },
      installAdapter: async (entry, approval) => {
        const o = entry.offer!;
        if (o.source === 'installed-off') await window.studio.external.setPackageEnabled(o.adapterId, true);
        else await window.studio.external.installPackage(o.path!, approval);
        announceExternalChanged();
      },
      refresh: async () => (await load(false))?.entries ?? [],
      connect: async (key) => { const out = await window.studio.connect.connectApp(key); await load(false); announceExternalChanged(); return out; },
      onUpdate: (r) => { if (alive.current) setRuns(r); },
      isCancelled: () => cancelled.current,
    });
    if (!alive.current) return;
    setPrompt(null);
    resolvePrompt.current = null;
    setPhase('done');
    setAnnounce(summarise(final));
    await load(false);
    announceExternalChanged();
    void window.studio.connect.done().catch(() => undefined);
  };

  const answer = (d: AdapterDecision) => { const r = resolvePrompt.current; resolvePrompt.current = null; setPrompt(null); r?.(d); };
  const cancelSetup = () => { cancelled.current = true; setCancelling(true); if (resolvePrompt.current) answer(null); };

  const retry = async (run: AppRun) => {
    const o = await load(false);
    const e = o?.entries.find((x) => x.key === run.appKey) ?? o?.entries.find((x) => x.key === run.key);
    if (e && e.selectable) void start([e]);
    else { setPhase('choose'); setSelected(new Set()); }
  };

  const close = () => {
    if (phase === 'running') return;
    void window.studio.connect.done().catch(() => undefined);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (phase === 'running') { if (!cancelling) cancelSetup(); } else close(); return; }
    if (e.key !== 'Tab' || !root.current) return;
    const f = [...root.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0]!; const last = f[f.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current || document.activeElement === heading.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  // ---- views ----

  const entryRow = (e: ConnectEntry) => {
    const id = `cw-${e.key.replace(/[^a-z0-9]/gi, '-')}`;
    const isOpen = open.has(e.key);
    return (
      <li key={e.key} className="connect-row ext-row" data-key={e.key}>
        <div className="ext-head">
          {e.selectable
            ? <input id={id} type="checkbox" checked={selected.has(e.key)} onChange={() => toggle(e.key)} aria-describedby={`${id}-d`} />
            : <span className="connect-nopick" aria-hidden="true" />}
          <label htmlFor={e.selectable ? id : undefined}><strong>{nameOf(e)}</strong></label>
          <small>{e.version ? `version ${e.version}` : 'version unknown'}{e.publisher ? ` · ${e.publisher}` : ''}</small>
          <span className={`chip ${GROUP_CHIP[e.group]}`}><span className="dot" />{chipText(e)}</span>
          {e.experimental && <span className="chip warn"><span className="dot" />Experimental</span>}
          {where(e) && <span className="chip"><span className="dot" />{where(e)}</span>}
        </div>
        <small id={`${id}-d`}><strong>{e.headline}.</strong> {e.explanation}</small>
        <div className="ext-actions">
          <button className="btn small ghost" aria-expanded={isOpen} onClick={() => toggleOpen(e.key)}>{isOpen ? 'Hide details' : 'Details'}</button>
          {e.forgettable && forgetKey !== e.key && <button className="btn small ghost" disabled={!!busy} onClick={() => setForgetKey(e.key)} aria-label={`Forget ${nameOf(e)}`}>Forget</button>}
        </div>
        {forgetKey === e.key && (
          <div className="connect-confirm" role="group" aria-label={`Forget ${nameOf(e)}?`}>
            <small>Forget {nameOf(e)}? CreateCraft stops remembering where it is and forgets the permissions you gave it. The program itself is <strong>not</strong> uninstalled or changed.</small>
            <div className="ext-actions">
              <button className="btn small primary" onClick={() => void forget(e)}>Forget {nameOf(e)}</button>
              <button className="btn small ghost" onClick={() => setForgetKey(null)}>Keep it</button>
            </div>
          </div>
        )}
        {isOpen && (
          <div className="connect-details">
            <small>{ADAPTER_STATE_LABEL[e.adapterState]}{e.offer ? ` · ${e.offer.name} ${e.offer.version} (${e.offer.source === 'bundled' ? 'shipped with CreateCraft' : e.offer.source === 'inbox' ? 'from your inbox folder' : 'installed, turned off'})` : ''}</small>
            {e.requirements.length > 0 && <small className="ext-note">Needs: {e.requirements.map((q) => q.text).join(' · ')}</small>}
            {e.notes && <small className="ext-note">{e.notes}</small>}
            <PermissionExplainer
              permissions={e.offer && e.adapterState !== 'installed' ? e.offer.permissions : e.permissionsNeeded}
              details={{ adapter: e.adapterId ? `${e.adapterId}${e.adapterVersion ? ` ${e.adapterVersion}` : ''}` : null, version: e.version, method: e.methods[0] ?? null, trust: e.trust, path: e.exePath, commands: e.commands }}
            />
          </div>
        )}
      </li>
    );
  };

  const chooseView = () => {
    const groups = GROUP_ORDER.map((g) => ({ g, list: entries.filter((e) => e.group === g) })).filter((x) => x.list.length);
    return (
      <>
        {overview?.firstRun && (
          <div className="connect-welcome" role="note">
            <strong>Welcome. Let’s connect your creative programs.</strong>
            <small>CreateCraft looks for programs like Blender or FreeCAD on <em>this PC only</em>. Nothing is sent anywhere. Nothing is installed, trusted or changed until you say so, and you see exactly what each one is allowed to do first.</small>
          </div>
        )}
        <div className="ext-actions">
          <button className="btn small primary" disabled={!!busy} onClick={() => void browse('file')}>Browse for Application…</button>
          <button className="btn small" disabled={!!busy} onClick={() => void browse('folder')}>Choose a program folder…</button>
          <button className="btn small ghost" disabled={!!busy} onClick={() => void rescan()}>{busy === 'scan' ? 'Scanning…' : 'Scan again'}</button>
        </div>
        <small className="ext-note">Portable program, or one that was not found? Use Browse for Application and point to its .exe file or its folder.</small>
        {entries.length === 0 && <div className="connect-empty"><strong>No supported programs were found on this PC.</strong><small>That is fine: nothing is wrong. If a program is installed in an unusual place or is a portable copy, use Browse for Application to point to it.</small></div>}
        {groups.map(({ g, list }) => (
          <section key={g} className="field" aria-label={GROUP_TITLE[g]}>
            <span className="menu-label">{GROUP_TITLE[g]} · {list.length}</span>
            <ul className="status-list ext-list">{list.map(entryRow)}</ul>
          </section>
        ))}
        {overview && overview.notDetected.length > 0 && (
          <details className="more-details">
            <summary>Supported, but not found on this PC ({overview.notDetected.length})</summary>
            <ul className="connect-missing">
              {overview.notDetected.map((m) => (
                <li key={m.adapterId}><small><strong>{m.name}</strong> · {ADAPTER_STATE_LABEL[m.adapterState]}{m.experimental ? ' · experimental' : ''}</small></li>
              ))}
            </ul>
          </details>
        )}
      </>
    );
  };

  const permissionsView = () => (
    <>
      <p className="connect-lead">You are about to set up {chosen.length} program{chosen.length === 1 ? '' : 's'}. Here is what that means for each one.</p>
      <ul className="status-list ext-list">
        {chosen.map((e) => {
          const perms = e.offer && e.adapterState !== 'installed' ? e.offer.permissions : e.permissionsNeeded;
          return (
            <li key={e.key} className="ext-row">
              <div className="ext-head">
                <strong>{nameOf(e)}</strong>
                <small>{e.version ? `version ${e.version}` : ''}</small>
                {e.experimental && <span className="chip warn"><span className="dot" />Experimental</span>}
              </div>
              <ol className="connect-steps">
                {e.group === 'needs-adapter' && <li>First you review the {nameOf(e)} {e.offer?.integrationType === 'external' ? 'connector' : 'connector and add-in'} (who made {e.offer?.integrationType === 'external' ? 'it' : 'them'}, what {e.offer?.integrationType === 'external' ? 'it' : 'they'} can do, which folders are used) and decide whether to trust {e.offer?.integrationType === 'external' ? 'it' : 'them'}. Nothing is installed before that.</li>}
                {e.group === 'needs-adapter' && e.offer && e.offer.integrationType !== 'external' && e.offer.closeHost && <li>{e.offer.hostName ?? nameOf(e)} has to be closed while the add-in is installed. CreateCraft never closes it for you.</li>}
                {e.group === 'needs-adapter' && e.offer && e.offer.integrationType !== 'external' && e.offer.restartHost && <li>Afterwards you open (or restart) {e.offer.hostName ?? nameOf(e)} so it loads the add-in. If it asks whether to allow the add-in, allow it.</li>}
                <li>CreateCraft connects to {nameOf(e)} and runs a real test to prove it works. {e.group === 'attention' && e.status === 'not-running' ? `${nameOf(e)} has to be open for this.` : ''}</li>
              </ol>
              <span className="menu-label">What this connector may be allowed to do</span>
              <PermissionExplainer permissions={perms} details={{ adapter: e.offer?.name ?? e.adapterName, version: e.version, method: e.methods[0] ?? null, trust: e.trust ?? (e.offer ? (e.offer.signature === 'valid' ? 'Signed package' : 'Not signed') : null), path: e.exePath, commands: e.commands }} />
            </li>
          );
        })}
      </ul>
      <small className="ext-note">Connecting does not give blanket access. Later, when you or Claude ask {chosen.length === 1 ? 'it' : 'a program'} to do something, CreateCraft asks first in plain language. Anything that could change or delete your work is asked every time. You can take permissions back in Settings, under Integrations (Forget permissions).</small>
    </>
  );

  const runCard = (r: AppRun) => (
    <li key={r.key} className="connect-row ext-row" data-outcome={r.outcome}>
      <div className="ext-head">
        <strong>{r.name}</strong>
        <span className={`chip ${RUN_CHIP[r.outcome]}`}><span className="dot" />{RUN_LABEL[r.outcome]}</span>
      </div>
      <ol className="connect-progress" aria-label={`Steps for ${r.name}`}>
        {r.needsAdapter && <li className={`step-${r.adapter}`}>{STEP_MARK[r.adapter]} {ADAPTER_STEP[r.adapter]}</li>}
        <li className={`step-${r.connect}`}>{STEP_MARK[r.connect]} {CONNECT_STEP[r.connect]}</li>
      </ol>
      <small><strong>{r.headline}</strong>{r.detail ? ` ${r.detail}` : ''}</small>
      {r.evidence.length > 0 && <small className="ext-note">Checked: {r.evidence.join(' · ')}</small>}
      {r.technical && (r.outcome === 'failed' || r.outcome === 'blocked') && (
        <details className="more-details"><summary>Technical details</summary><code>{r.technical}</code></details>
      )}
      {phase === 'done' && (r.outcome === 'failed' || r.outcome === 'blocked') && (
        <div className="ext-actions"><button className="btn small" onClick={() => void retry(r)}>Try again</button></div>
      )}
    </li>
  );

  const runningView = () => (
    <>
      {prompt && (
        <div className="connect-prompt">
          <p className="connect-lead">Step 1 for {nameOf(prompt.entry)}: review {prompt.entry.offer?.integrationType === 'external' ? 'its connector' : 'its connector and add-in'}. You decide whether to install and trust {prompt.entry.offer?.integrationType === 'external' ? 'it' : 'them'}.</p>
          {prompt.review
            ? <PackageReviewCard key={prompt.review.path} review={prompt.review} onRecheck={() => { void window.studio.external.reviewPackage(prompt.review!.path).then((rv) => setPrompt((p) => (p ? { ...p, review: rv } : p))).catch((e) => setError(errorText(e))); }} confirmLabel={`Install ${prompt.review.name ?? 'connector'}`} cancelLabel={`Skip ${nameOf(prompt.entry)}`} onConfirm={(approval) => answer({ approval })} onCancel={() => answer(null)} />
            : (
              <div className="ext-row ext-review" role="group" aria-label="Turn on connector">
                <small>The {prompt.entry.offer?.name} connector is already installed but turned off. Turn it on to continue?</small>
                <div className="ext-actions">
                  <button className="btn small primary" onClick={() => answer({ approval: { permissions: [] } })}>Turn on</button>
                  <button className="btn small ghost" onClick={() => answer(null)}>Skip {nameOf(prompt.entry)}</button>
                </div>
              </div>
            )}
        </div>
      )}
      <ul className="status-list ext-list">{runs.map(runCard)}</ul>
    </>
  );

  const doneView = () => (
    <>
      <p className="connect-lead" role="status">{summarise(runs)}</p>
      <ul className="status-list ext-list">{runs.map(runCard)}</ul>
      <small className="ext-note">“Connected and tested” always means a real test passed. Anything else is listed above with what to do next; the programs that did connect are not affected by the ones that did not.</small>
    </>
  );

  const title = phase === 'scanning' ? 'Looking for programs on this PC…' : phase === 'choose' ? 'Connect Applications' : phase === 'permissions' ? 'What you are allowing' : phase === 'running' ? 'Setting up…' : 'Setup finished';
  const stepNo = phase === 'scanning' || phase === 'choose' ? 1 : phase === 'permissions' ? 2 : phase === 'running' ? 3 : 4;

  return (
    <div className="modal-backdrop connect-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && phase !== 'running') close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="connect-title" className="panel-card connect-dialog" ref={root} onKeyDown={onKeyDown}>
        <div className="settings-head">
          <div>
            <h2 id="connect-title" tabIndex={-1} ref={heading}>{title}</h2>
            <small className="ext-note">Step {stepNo} of 4 · Find · Allow · Set up · Done</small>
          </div>
          <button className="btn small ghost" aria-label="Close Connect Applications" disabled={phase === 'running'} onClick={close}>✕</button>
        </div>
        <div className="connect-body">
          <div className="sr-only" role="status" aria-live="polite">{announce}</div>
          {error && <small className="ext-error" role="alert">{error}</small>}
          {notice && <small className="connect-notice" role="status">{notice}</small>}
          {phase === 'scanning' && <div className="connect-empty" aria-busy="true"><strong>Scanning this PC…</strong><small>Looking only for programs CreateCraft can connect. Nothing leaves your PC.</small></div>}
          {phase === 'choose' && chooseView()}
          {phase === 'permissions' && permissionsView()}
          {phase === 'running' && runningView()}
          {phase === 'done' && doneView()}
        </div>
        <div className="connect-foot">
          {phase === 'choose' && (<>
            <small>{chosen.length ? `${chosen.length} selected` : 'Pick one or more programs to continue.'}</small>
            <span className="spacer" />
            <button className="btn small ghost" onClick={close}>Close</button>
            <button className="btn small primary" disabled={!chosen.length || !!busy} onClick={() => setPhase('permissions')}>Continue with {chosen.length || 'none'}…</button>
          </>)}
          {phase === 'permissions' && (<>
            <button className="btn small ghost" onClick={() => setPhase('choose')}>Back</button>
            <span className="spacer" />
            <button className="btn small primary" onClick={() => void start(chosen)}>Set up {chosen.length} program{chosen.length === 1 ? '' : 's'}</button>
          </>)}
          {phase === 'running' && (<>
            <small>{cancelling ? 'Cancelling after the current step finishes…' : 'Each program is set up on its own; one problem does not stop the others.'}</small>
            <span className="spacer" />
            <button className="btn small" disabled={cancelling} onClick={cancelSetup}>Cancel setup</button>
          </>)}
          {phase === 'done' && (<>
            <button className="btn small ghost" onClick={() => { setPhase('choose'); setSelected(new Set()); void load(false); }}>Set up more programs</button>
            <span className="spacer" />
            <button className="btn small primary" onClick={close}>Done</button>
          </>)}
        </div>
      </div>
    </div>
  );
}


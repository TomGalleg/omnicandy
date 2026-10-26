import { useEffect, useRef, useState } from 'react';
import type { BuildState, BuildUsage, WorkspaceState, PlanUsage, PlanUsageBar } from '@shared/buildSession';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const LIMIT_NAME: Record<string, string> = { five_hour: 'Session limit', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly Opus limit', seven_day_sonnet: 'Weekly Sonnet limit' };

const resets = (t: number | null) => (t ? ` · resets ${new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '');

function Meter({ label, right, percent }: { label: string; right: string; percent: number }) {
  return (
    <div className="build-limit">
      <div className="build-usage-row"><span>{label}</span><strong>{right}</strong></div>
      <div className={`build-meter${percent >= 80 ? ' hot' : ''}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>
    </div>
  );
}

function Usage({ u, plan }: { u: BuildUsage; plan: PlanUsage | null }) {
  const bars: Array<[string, PlanUsageBar | null]> = plan && !plan.error ? [['Session limit', plan.session], ['Weekly · all models', plan.weekly], ['Weekly · Opus', plan.weeklyOpus], ['Weekly · Sonnet', plan.weeklySonnet]] : [];
  const ctx = u.contextWindow ? Math.min(1, u.contextTokens / u.contextWindow) : null;
  return (
    <div className="build-usage" aria-label="Usage">
      <div className="build-usage-row"><span>Conversation size</span><strong>{tokens(u.contextTokens)}{u.contextWindow ? ` of ${tokens(u.contextWindow)}` : ''}</strong></div>
      {ctx !== null && <div className="build-meter" role="progressbar" aria-label="Conversation size" aria-valuenow={Math.round(ctx * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${ctx * 100}%` }} /></div>}
      <div className="build-usage-row"><span>This chat</span><strong>{tokens(u.inputTokens + u.cachedTokens)} in · {tokens(u.outputTokens)} out · ≈ ${u.costUsd.toFixed(2)}</strong></div>
      {plan && !plan.error ? (
        <>
          {bars.filter((x): x is [string, PlanUsageBar] => x[1] !== null).map(([label, b]) => <Meter key={label} label={label} percent={b.percent} right={`${Math.round(b.percent)}% used${resets(b.resetsAt)}`} />)}
          {plan.credits && <Meter label="Usage credits" percent={Math.min(100, (plan.credits.usedUsd / plan.credits.limitUsd) * 100)} right={`$${plan.credits.usedUsd.toFixed(2)} of $${plan.credits.limitUsd.toFixed(2)}`} />}
        </>
      ) : (
        <>
          {plan?.error && <small>{plan.error}</small>}
          {u.limits.map((lim) => <Meter key={lim.kind} label={LIMIT_NAME[lim.kind] ?? 'Plan limit'} percent={Math.round((lim.used ?? 0) * 100)} right={lim.status === 'rejected' ? 'reached' : lim.used !== null ? `${Math.round(lim.used * 100)}% used${resets(lim.resetsAt)}` : 'ok'} />)}
        </>
      )}
      <small>The dollar figure is what this chat would cost at API prices. A Claude subscription is not billed per message.</small>
    </div>
  );
}

/** Setting up, rebuilding and restoring the editable copy of OmniCandy's source. */
function Workspace({ w, onError, onAskFix }: { w: WorkspaceState; onError: (m: string | null) => void; onAskFix: (text: string) => void }) {
  const run = (fn: () => Promise<void>) => { onError(null); fn().catch((e) => onError(errText(e))); };
  const tail = w.log.length > 0 && (
    <pre className="build-log" aria-live="polite">{w.log.slice(-8).join('\n')}</pre>
  );
  if (w.state === 'busy') return <div className="build-workspace"><strong>{w.step}…</strong>{tail}<small>Keep OmniCandy open. This can take a few minutes.</small></div>;
  if (w.state === 'no-bundle') return <div className="build-workspace"><div className="msg error">This copy of OmniCandy does not include its source code, so Claude has nothing to change.</div></div>;
  if (w.state === 'needs-setup') {
    return (
      <div className="build-workspace">
        <strong>Set up editing</strong>
        <small>OmniCandy keeps a copy of its own source in <code>{w.folder}</code>. Claude changes that copy; the program you installed stays as it is until you rebuild, and you can always restore the original.</small>
        {!w.nodeFound && <div className="msg system">Rebuilding needs Node.js, which was not found on this PC. {' '}
          <button className="btn small" onClick={() => run(() => window.studio.build.installNode())}>Install Node.js</button> then press Set up editing.</div>}
        <button className="btn primary" onClick={() => run(() => window.studio.build.setup())}>Set up editing</button>
        {tail}

      </div>
    );
  }
  return (
    <div className="build-workspace row">
      {w.editedFailed && <div className="msg error">Your edited version did not start, so the original opened. Ask Claude to fix it, then rebuild.</div>}
      {w.buildError && (
        <div className="msg error">The last build failed.{' '}
          <button className="btn small" onClick={() => onAskFix(`The build failed with this output. Please fix it:\n\n${w.buildError}`)}>Ask Claude to fix it</button></div>
      )}
      {tail}
      <span className="build-workspace-actions">
        <button className="btn small" title="Builds your version and restarts OmniCandy into it" onClick={() => run(() => window.studio.build.rebuild())}>Rebuild and restart</button>
        {w.mode === 'installed' && <button className="btn small ghost" title="Puts the original source back" onClick={() => { if (window.confirm('Replace everything Claude changed with the original source?')) run(() => window.studio.build.restore()); }}>Restore original</button>}
      </span>
    </div>
  );
}

/** Slide-out chat with Claude Code working in OmniCandy's own source. Rendered only while open. */
export function BuildPanel({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<BuildState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showUsage, setShowUsage] = useState(true);
  const [plan, setPlan] = useState<PlanUsage | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void window.studio.build.state().then(setSt);
    return window.studio.build.onChange(setSt);
  }, []);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [st?.items.length, st?.approval]);
  useEffect(() => { boxRef.current?.focus(); }, []);
  // Plan limits: read live (same numbers as Claude Code's /usage) when the panel opens, every minute, and after each reply.
  const working0 = st?.status;
  useEffect(() => {
    let live = true;
    const load = () => { void window.studio.build.planUsage().then((p) => { if (live) setPlan(p); }).catch(() => undefined); };
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [working0]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const working = st?.status === 'working';
  const canChat = st?.workspace.state === 'ready';
  const send = () => {
    const text = draft.trim();
    if (!text || working) return;
    setDraft('');
    setError(null);
    window.studio.build.send(text).catch((e) => setError(errText(e)));
  };

  return (
    <aside className="build-panel" aria-label="Build with Claude Code">
      <div className="build-head">
        <strong>Build with Claude Code</strong>
        <span className="build-head-actions">
          <button className="btn small ghost" aria-pressed={showUsage} onClick={() => setShowUsage((v) => !v)}>Usage</button>
          <button className="btn small ghost" disabled={!st?.items.length && !working} onClick={() => { void window.studio.build.reset(); }}>New chat</button>
          <button className="btn small ghost" aria-label="Close Build panel" onClick={onClose}>✕</button>
        </span>
      </div>
      {showUsage && st && <Usage u={st.usage} plan={plan} />}
      {st && <Workspace w={st.workspace} onError={setError} onAskFix={(text) => { setError(null); window.studio.build.send(text).catch((e) => setError(errText(e))); }} />}
      <div className="build-chat" ref={chatRef}>
        {st && !st.items.length && !st.unavailable && (
          <div className="msg system">Tell Claude what to change in OmniCandy or which app to connect. For example: &quot;Add a button to the Home tab that opens my projects folder&quot; or &quot;Connect Affinity Photo&quot;. It can read the code freely and asks you before it changes anything.</div>
        )}
        {st?.unavailable && <div className="msg error">{st.unavailable}</div>}
        {st?.items.map((i) => <div key={i.id} className={`msg ${i.kind === 'claude' ? 'assistant' : i.kind === 'tool' ? 'activity' : i.kind}`}>{i.text}</div>)}
        {working && !st?.approval && <div className="msg activity">Claude is working…</div>}
        {st?.approval && (
          <div className="build-approval" role="alertdialog" aria-label="Claude asks permission">
            <div><strong>Claude wants to:</strong></div>
            <code>{st.approval.summary}</code>
            <div className="build-approval-actions">
              <button className="btn primary" onClick={() => { void window.studio.build.answer(st.approval!.id, true); }}>Allow</button>
              <button className="btn" onClick={() => { void window.studio.build.answer(st.approval!.id, false); }}>Don&apos;t allow</button>
            </div>
          </div>
        )}
      </div>
      {error && <div className="msg error" role="alert">{error}</div>}
      <div className="build-input">
        <textarea ref={boxRef} rows={3} disabled={!canChat} value={draft} placeholder="What should Claude build or change?" aria-label="Message to Claude"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {working
          ? <button className="btn" onClick={() => { void window.studio.build.stop(); }}>Stop</button>
          : <button className="btn primary" disabled={!draft.trim() || !canChat} onClick={send}>Send</button>}
      </div>
    </aside>
  );
}

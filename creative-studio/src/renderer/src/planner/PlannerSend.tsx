// The plain "Send to AI" panel (docs/planner-simplification-plan.md, section 4). It prepares text only: nothing is started, uploaded
// or paid for. Choosing tasks and an AI and pressing one button replaces "select tasks, create a package, show, copy".
import { useEffect, useMemo, useState } from 'react';
import { isClaimLive, type ExecPackage, type PlannerProject } from '@shared/planner';
import { brainstormText, buildContext } from '@shared/plannerContext';
import { claudeReadyToWork, DESTINATIONS, lastActive, listPaths, sendText, type DestinationId } from '@shared/plannerSend';
import { copyText, CopyButton, errMsg, ErrorLine, Section, useAction, when } from './plannerUi';

const api = () => window.studio.planner;
const TOOL_KINDS = ['claude-code', 'gemini', 'cowork'];
const DEST_KEY = 'cs-planner-send-dest';
const storedDest = (): DestinationId | null => { try { const v = window.localStorage.getItem(DEST_KEY); return v === 'createcraft' || v === 'tools' || v === 'chat' ? v : null; } catch { return null; } };

/** `only`: the one task being worked on (no list to tick). */
export function SendPanel({ p, reload, sel, setSel, only }: { p: PlannerProject; reload: () => Promise<void>; sel: string[]; setSel: (ids: string[]) => void; only?: string }) {
  // OmniCandy's own Claude is offered first. The owner's last choice is remembered; with no choice yet and Claude not ready to work, "any chat" is offered instead.
  const [dest, setDestRaw] = useState<DestinationId>(() => storedDest() ?? 'createcraft');
  const setDest = (d: DestinationId) => { setDestRaw(d); try { window.localStorage.setItem(DEST_KEY, d); } catch { /* storage unavailable */ } };
  useEffect(() => { if (storedDest()) return; void window.studio.claude.state().then((st) => { if (!claudeReadyToWork(st)) setDestRaw('chat'); }).catch(() => {}); }, []);
  const [objective, setObjective] = useState('');
  const [sent, setSent] = useState<{ pkg: ExecPackage; reused: boolean; replaced: number[]; dest: DestinationId } | null>(null);
  const [redact, setRedact] = useState(true);
  const [seen, setSeen] = useState<{ name: string; at: string } | null>(null);
  const [filled, setFilled] = useState(false);
  // "Do this now": the owner confirms what will happen and how long it may run before OmniCandy's Claude starts. Nothing starts without that.
  const [confirming, setConfirming] = useState(false);
  const [steps, setSteps] = useState(40);
  const [started, setStarted] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [force, setForce] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const a = useAction(reload);
  const now = new Date();
  const ready = p.tasks.filter((t) => ['todo', 'revision'].includes(t.status) && !isClaimLive(t.claim, now) && (!only || t.id === only));
  const chosen = useMemo(() => (only ? ready.map((t) => t.id) : sel.filter((id) => ready.some((t) => t.id === id))), [sel, ready, only]);
  useEffect(() => { void api().activity(p.id).then((act) => setSeen(lastActive(act, TOOL_KINDS))).catch(() => {}); }, [p.id, p.revision]);
  const chosenKey = chosen.join(',');
  useEffect(() => { setSent(null); setFilled(false); setCopied(false); setConfirming(false); setStarted(false); setRunError(null); }, [chosenKey, dest, force]);
  useEffect(() => { setForce([]); }, [chosenKey, dest]);
  const ctx = useMemo(() => (chosen.length ? buildContext(p, { purpose: 'execute', taskIds: chosen, destination: dest, forceInclude: force }) : null), [p, chosen, dest, force]);
  useEffect(() => { setRedact(dest === 'chat'); }, [dest]);

  const prepare = (thenConfirm = false) => a.run(async () => {
    const r = await api().prepareSend(p.id, { taskIds: chosen, objective: objective.trim() || undefined, destination: dest, forceInclude: force });
    setSent({ pkg: r.package, reused: r.reused, replaced: r.replaced, dest });
    if (thenConfirm) setConfirming(true);
    // One click: the instructions are on the clipboard as soon as they are ready (the text is also shown below).
    if (dest !== 'createcraft') setCopied(await copyText(sendText(r.package, p.title, dest, { redact: dest === 'chat' })));
  });
  const text = sent ? sendText(sent.pkg, p.title, sent.dest, { redact: redact && sent.dest !== 'createcraft' }) : '';
  const paths = sent ? listPaths(sent.pkg) : [];
  const waits = (id: string) => (p.tasks.find((t) => t.id === id)?.dependsOn ?? []).map((d) => p.tasks.find((x) => x.id === d)).filter((x) => x && !['accepted', 'cancelled'].includes(x.status) && !chosen.includes(x.id));

  return (
    <Section title={only ? 'Do this task' : 'Send to AI'} hint={only ? (dest === 'createcraft' ? 'OmniCandy Claude does it after you confirm. Nothing starts until you press Start.' : 'Pick who does it. This only prepares instructions for you to copy; nothing starts by itself.') : 'Pick what the AI should do and who gets it. This only prepares text for you to send. Nothing starts by itself.'}>
      {!ready.length && <p className="pl-hint">{only ? 'This task is already with an AI, waiting for a result, or finished. Bring the result back below.' : 'No task is ready to send. A task is ready when it is To Do and nobody is working on it.'}</p>}
      {!only && ready.map((t) => (
        <label key={t.id} className="pl-check">
          <input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => setSel(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} />
          {t.title}
          {t.packageId && <small className="pl-hint"> (already sent: sending again reuses it if nothing changed)</small>}
          {waits(t.id).length > 0 && <small className="pl-hint"> (also needs: {waits(t.id).map((w) => w?.title).join(', ')})</small>}
        </label>
      ))}
      {ready.length > 0 && (
        <fieldset className="pl-dests"><legend>Who does it?</legend>
          {(() => {
            const row = (d: (typeof DESTINATIONS)[number]) => (
              <label key={d.id} className="pl-check pl-dest">
                <input type="radio" name={`dest-${p.id}`} checked={dest === d.id} onChange={() => setDest(d.id)} />
                <span><strong>{d.label}</strong><br /><small className="pl-hint">{d.blurb}{d.id === 'tools' && seen ? ` Last seen: ${seen.name}, ${when(seen.at)}.` : ''}</small></span>
              </label>
            );
            const first = DESTINATIONS.find((d) => d.id === 'createcraft')!;
            return <>{row(first)}<details open={dest !== 'createcraft'}><summary>Use another AI instead</summary>{DESTINATIONS.filter((d) => d.id !== 'createcraft').map(row)}</details></>;
          })()}
        </fieldset>
      )}
      {ctx && ctx.rules.length > 0 && (
        <div className="pl-context">
          <p className="pl-hint">The AI will see {ctx.includedIds.length} of your {ctx.rules.length} agreed rules and decisions{ctx.omitted.length ? ' (a chat message is kept short)' : ''}.{ctx.upstream.length > 0 && ` It also gets the finished results of: ${ctx.upstream.map((u) => u.title).join(', ')}.`}</p>
          {ctx.omitted.length > 0 && (
            <details open><summary>Left out ({ctx.omitted.length}): tick any you want included</summary>
              {ctx.omitted.map((o) => <label key={o.id} className="pl-check"><input type="checkbox" checked={force.includes(o.id)} onChange={(e) => setForce(e.target.checked ? [...force, o.id] : force.filter((x) => x !== o.id))} />{o.title}</label>)}
            </details>
          )}
        </div>
      )}
      {ctx && ctx.rules.length === 0 && ctx.upstream.length > 0 && <p className="pl-hint">It also gets the finished results of: {ctx.upstream.map((u) => u.title).join(', ')}.</p>}
      {ready.length > 0 && <details><summary>More options</summary><label>What should it aim for? (optional)<input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Leave empty to use the task names" /></label></details>}
      {ready.length > 0 && <div><button className="btn primary" disabled={a.busy || !chosen.length} onClick={() => void prepare(dest === 'createcraft')}>{dest === 'createcraft' ? 'Do this now' : 'Copy the instructions'}</button></div>}
      <ErrorLine error={a.error} />
      {sent && (
        <div className="pl-sent" role="status">
          <p><strong>{sent.reused ? 'Ready. This is the same brief you prepared before, and nothing in the plan has changed.' : 'Ready.'}</strong>
            {sent.replaced.length > 0 && <> It replaces the earlier brief{sent.replaced.length > 1 ? 's' : ''} ({sent.replaced.join(', ')}): an AI still holding the old one will be told it is out of date.</>}</p>
          {sent.dest !== 'createcraft' && paths.length > 0 && (
            <div className="pl-warn">
              <label className="pl-check"><input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} />Remove file locations from the text ({paths.length} found)</label>
              <details><summary>Show them</summary><ul>{paths.map((x) => <li key={x}><code>{x}</code></li>)}</ul></details>
            </div>
          )}
          <div className="pl-actions">
            {sent.dest !== 'createcraft' && <CopyButton text={text} label={sent.dest === 'chat' ? 'Copy for the chat' : 'Copy the line to paste'} />}
            {sent.dest === 'createcraft' && !started && !confirming && <button className="btn primary" onClick={() => setConfirming(true)}>Do this now</button>}
            <button className="btn small ghost" disabled={a.busy} title="Cancel this brief; its tasks go back to To Do" onClick={() => void a.run(async () => { await api().cancelPackage(p.id, sent.pkg.id); setSent(null); })}>Undo</button>
          </div>
          {sent.dest === 'createcraft' && !started && (
            <details><summary>Other ways to give this to Claude</summary>
              <div className="pl-actions"><CopyButton text={text} label="Copy the message" />
              <button className="btn small" onClick={() => { window.dispatchEvent(new CustomEvent('createcraft:claude-prefill', { detail: { text } })); setFilled(true); }}>Put it in the Claude panel instead</button>
              </div>
            </details>
          )}
          {copied && sent.dest !== 'createcraft' && <p className="pl-hint" role="status">Copied. Paste it into {sent.dest === 'chat' ? 'ChatGPT, Gemini or Claude' : 'your tool'}.</p>}
          {sent.dest === 'createcraft' && confirming && !started && (
            <div className="pl-warn" role="alertdialog" aria-label="Start this work">
              <p><strong>Start this now?</strong> OmniCandy's Claude will read the brief, claim {chosen.length === 1 ? 'the task' : 'the tasks'}, work in this project with the apps you have connected, then report back for your review. It asks you before it runs another program, never marks anything Done itself, and uses your Claude sign-in.</p>
              <label>It stops by itself after about <select value={steps} onChange={(e) => setSteps(Number(e.target.value))}><option value={20}>20 steps (short)</option><option value={40}>40 steps (normal)</option><option value={100}>100 steps (long)</option></select></label>
              <p className="pl-actions">
                <button className="btn primary" onClick={() => { setStarted(true); setConfirming(false); setRunError(null); void window.studio.claude.send(text, { maxTurns: steps }).then(() => reload()).catch((e: unknown) => { setStarted(false); setRunError(errMsg(e)); }); }}>Start</button>
                <button className="btn" onClick={() => setConfirming(false)}>Not yet</button>
              </p>
            </div>
          )}
          {started && <p className="pl-hint" role="status">Started. Watch the Claude panel. While it works, the task's director shows a turning gear in the town, and a ! when the result is ready for you to review. Press Stop in the Claude panel to end it.</p>}
          <ErrorLine error={runError} />
          {sent.dest === 'createcraft' && chosen.some((id) => !p.tasks.find((t) => t.id === id)?.assignee) && <p className="pl-hint">Tip: choose who handles {chosen.length === 1 ? 'this task' : 'these tasks'} (Handled by, on the card in the Studio) so their badge shows in the town.</p>}
          {filled && <p className="pl-hint">It is in the Claude panel's box. Read it, then press Send there. If the panel is closed, use Copy and paste it in.</p>}
          {sent.dest !== 'createcraft' && <p className="pl-hint">When the AI answers, paste the answer under <strong>Paste back</strong> below. It will wait for your review.</p>}
          {sent.dest !== 'createcraft' && <pre className="pl-raw">{text}</pre>}
        </div>
      )}
    </Section>
  );
}

/** Step 2 of the beginner loop: a ready-made request for ideas. Text only; it names no file locations and starts nothing. */
export function AskPanel({ p }: { p: PlannerProject }) {
  const text = useMemo(() => brainstormText(p), [p]);
  return (
    <Section title="Ask an AI for ideas" hint="Copies a short summary of your plan and asks for suggestions in a form you can paste back below. Nothing joins your plan until you say so.">
      <div className="pl-actions"><CopyButton text={text} label="Copy the request" /></div>
      <details><summary>Show what will be copied</summary><pre className="pl-raw">{text}</pre></details>
    </Section>
  );
}

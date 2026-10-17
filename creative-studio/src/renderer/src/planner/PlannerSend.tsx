// The plain "Send to AI" panel (docs/planner-simplification-plan.md, section 4). It prepares text only: nothing is started, uploaded
// or paid for. Choosing tasks and an AI and pressing one button replaces "select tasks, create a package, show, copy".
import { useEffect, useMemo, useState } from 'react';
import { isClaimLive, type ExecPackage, type PlannerProject } from '@shared/planner';
import { brainstormText, buildContext } from '@shared/plannerContext';
import { DESTINATIONS, lastActive, listPaths, sendText, type DestinationId } from '@shared/plannerSend';
import { CopyButton, ErrorLine, Section, useAction, when } from './plannerUi';

const api = () => window.studio.planner;
const TOOL_KINDS = ['claude-code', 'gemini', 'cowork'];

export function SendPanel({ p, reload, sel, setSel }: { p: PlannerProject; reload: () => Promise<void>; sel: string[]; setSel: (ids: string[]) => void }) {
  const [dest, setDest] = useState<DestinationId>('chat');
  const [objective, setObjective] = useState('');
  const [sent, setSent] = useState<{ pkg: ExecPackage; reused: boolean; replaced: number[]; dest: DestinationId } | null>(null);
  const [redact, setRedact] = useState(true);
  const [seen, setSeen] = useState<{ name: string; at: string } | null>(null);
  const [filled, setFilled] = useState(false);
  const [force, setForce] = useState<string[]>([]);
  const a = useAction(reload);
  const now = new Date();
  const ready = p.tasks.filter((t) => ['todo', 'revision'].includes(t.status) && !isClaimLive(t.claim, now));
  const chosen = useMemo(() => sel.filter((id) => ready.some((t) => t.id === id)), [sel, ready]);
  useEffect(() => { void api().activity(p.id).then((act) => setSeen(lastActive(act, TOOL_KINDS))).catch(() => {}); }, [p.id, p.revision]);
  const chosenKey = chosen.join(',');
  useEffect(() => { setSent(null); setFilled(false); }, [chosenKey, dest, force]);
  useEffect(() => { setForce([]); }, [chosenKey, dest]);
  const ctx = useMemo(() => (chosen.length ? buildContext(p, { purpose: 'execute', taskIds: chosen, destination: dest, forceInclude: force }) : null), [p, chosen, dest, force]);
  useEffect(() => { setRedact(dest === 'chat'); }, [dest]);

  const prepare = () => a.run(async () => {
    const r = await api().prepareSend(p.id, { taskIds: chosen, objective: objective.trim() || undefined, destination: dest, forceInclude: force });
    setSent({ pkg: r.package, reused: r.reused, replaced: r.replaced, dest });
  });
  const text = sent ? sendText(sent.pkg, p.title, sent.dest, { redact: redact && sent.dest !== 'createcraft' }) : '';
  const paths = sent ? listPaths(sent.pkg) : [];
  const waits = (id: string) => (p.tasks.find((t) => t.id === id)?.dependsOn ?? []).map((d) => p.tasks.find((x) => x.id === d)).filter((x) => x && !['accepted', 'cancelled'].includes(x.status) && !chosen.includes(x.id));

  return (
    <Section title="Send to AI" hint="Pick what the AI should do and who gets it. This only prepares text for you to send. Nothing starts by itself.">
      {!ready.length && <p className="pl-hint">No task is ready to send. A task is ready when it is To Do and nobody is working on it.</p>}
      {ready.map((t) => (
        <label key={t.id} className="pl-check">
          <input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => setSel(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} />
          {t.title}
          {t.packageId && <small className="pl-hint"> (already sent: sending again reuses it if nothing changed)</small>}
          {waits(t.id).length > 0 && <small className="pl-hint"> (also needs: {waits(t.id).map((w) => w?.title).join(', ')})</small>}
        </label>
      ))}
      {ready.length > 0 && (
        <fieldset className="pl-dests"><legend>Who is it for?</legend>
          {DESTINATIONS.map((d) => (
            <label key={d.id} className="pl-check pl-dest">
              <input type="radio" name={`dest-${p.id}`} checked={dest === d.id} onChange={() => setDest(d.id)} />
              <span><strong>{d.label}</strong><br /><small className="pl-hint">{d.blurb}{d.id === 'tools' && seen ? ` Last seen: ${seen.name}, ${when(seen.at)}.` : ''}</small></span>
            </label>
          ))}
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
      {ready.length > 0 && <div><button className="btn primary" disabled={a.busy || !chosen.length} onClick={() => void prepare()}>Get the text to send</button></div>}
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
            <CopyButton text={text} label={sent.dest === 'chat' ? 'Copy for the chat' : sent.dest === 'tools' ? 'Copy the line to paste' : 'Copy the message'} />
            {sent.dest === 'createcraft' && <button className="btn small" onClick={() => { window.dispatchEvent(new CustomEvent('createcraft:claude-prefill', { detail: { text } })); setFilled(true); }}>Put it in the Claude panel</button>}
            <button className="btn small ghost" disabled={a.busy} title="Cancel this brief; its tasks go back to To Do" onClick={() => void a.run(async () => { await api().cancelPackage(p.id, sent.pkg.id); setSent(null); })}>Unsend</button>
          </div>
          {filled && <p className="pl-hint">It is in the Claude panel's box. Read it, then press Send there. If the panel is closed, use Copy and paste it in.</p>}
          <p className="pl-hint">When the AI answers, paste the answer under <strong>Paste back</strong> below. It will wait for your review.</p>
          <pre className="pl-raw">{text}</pre>
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

import { useEffect, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { PlannerChat } from './PlannerChat';
import { CardDetails, ProjectCanvas } from './ProjectCanvas';
import { errMsg, ErrorLine, type TabProps } from './plannerUi';
import { nextStepsOf, type ViewNode } from '@shared/projectView';
import { useCanvas } from './useCanvas';

const api = () => window.studio.planner;

/**
 * Studio: the conversation on the left, the plan as a visual canvas on the right. What the AI suggests appears on the canvas as dashed cards; it joins
 * the plan only when you press Add. The canvas, board and list are three ways of drawing the same plan.
 */
export function StudioTab(props: TabProps) {
  const { p, reload, go, setFocusTaskId, setSendSel, manifest } = props;
  const c = useCanvas(p);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A project that already has work in it can be looked at in one click: the General Manager reads it (read-only) and starts the conversation from what it found.
  const [chatEmpty, setChatEmpty] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const [looking, setLooking] = useState(false);
  useEffect(() => { let live = true; void api().chatLoad(p.id).then((c) => { if (live) setChatEmpty(c.messages.length === 0); }).catch(() => {}); return () => { live = false; }; }, [p.id, chatKey]);
  const files = manifest?.assets.length ?? 0;
  const offerLook = files > 0 && chatEmpty && p.tasks.length === 0;
  const look = () => {
    setLooking(true); setError(null);
    void (async () => {
      const f = await api().analyze();
      if (f.changes.length) await api().applyFindings(p.id, f.changes.map((_, i) => i));
      const facts = f.lines.filter((l) => !/^Nothing has been made/.test(l));
      if (facts.length) await api().chatSave(p.id, { messages: [{ role: 'assistant', text: ['I looked through this project. Here is what I found:', '', ...facts.map((l) => `- ${l}`), '', 'What would you like to do with it next?'].join(String.fromCharCode(10)) }] });
      setChatKey((k) => k + 1);
      await reload();
    })().catch((e) => setError(errMsg(e))).finally(() => setLooking(false));
  };
  const next = nextStepsOf(c.view)[0];
  const node = selected ? c.view.nodes.find((n) => n.id === selected) ?? null : null;

  /** Suggested cards left out of what gets added. The service applies or rejects a suggestion as a whole, so "leave out" is a choice made here. */
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setLeft((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const decide = (proposalId: string, accept: boolean) => {
    setError(null);
    const pr = p.proposals.find((x) => x.id === proposalId);
    const keep = (pr?.changes ?? []).map((_, i) => i).filter((i) => !left.has(`ghost:${proposalId}:${i}`));
    if (accept && !keep.length) { setError('Every card in this suggestion is left out. Keep at least one, or skip the suggestion.'); return; }
    void (accept ? api().decideProposal(p.id, proposalId, true, keep) : api().decideProposal(p.id, proposalId, false))
      .then(() => reload())
      .catch((e) => { setError(errMsg(e)); void reload().catch(() => {}); });
  };
  /** The owner's choice of who handles a chunk. Plan data, so it goes through the plan's own edit (with the revision the owner was looking at). */
  const assign = (n: ViewNode, key: string | null) => {
    setError(null);
    void api().updateTask(p.id, n.ref.id, { assignee: key }, n.ref.rev).then(() => reload()).catch((e) => { setError(errMsg(e)); void reload().catch(() => {}); });
  };
  const work = (taskId: string) => { setSendSel?.([taskId]); setFocusTaskId?.(taskId); go('handoffs'); };

  return (
    <div className="studio">
      <Group orientation="horizontal">
        <Panel id="studio-chat" defaultSize="36" minSize="22">
          <div className="studio-chat">{offerLook && (
            <div className="pc-suggest" role="status">
              <span>This project already has {files} file{files === 1 ? '' : 's'}. Let the General Manager look through them (nothing is changed or marked done).</span>
              <button className="btn small primary" disabled={looking} onClick={look}>{looking ? 'Looking…' : 'Look at what is here'}</button>
            </div>
          )}
          <PlannerChat key={`${p.id}:${chatKey}`} p={p} reload={reload} go={go} preview /></div>
        </Panel>
        <Separator className="sep" />
        <Panel id="studio-canvas" defaultSize="64" minSize="30">
          <div className="studio-plan">
            {next && <p className="pc-next" role="status"><strong>Next:</strong> {next.text} {next.kind === 'continue-current' && next.taskId && <button className="btn small primary" onClick={() => work(next.taskId!)}>Work on this</button>}</p>}
            {c.note && <p className="pl-warn" role="status">{c.note} <button className="btn small ghost" onClick={c.clearNote}>Dismiss</button></p>}
            <ErrorLine error={error} />
            {c.view.pendingProposals.map((pr) => {
              const kept = p.proposals.find((x) => x.id === pr.id)?.changes.filter((_, i) => !left.has(`ghost:${pr.id}:${i}`)).length ?? pr.changes;
              return (
                <div key={pr.id} className="pc-suggest" role="status">
                  <span><strong>{pr.by}</strong> suggests {pr.changes} {pr.changes === 1 ? 'change' : 'changes'}{pr.note ? `: ${pr.note}` : ''}. They are shown dashed.</span>
                  <span className="pl-actions">
                    <button className="btn small primary" onClick={() => decide(pr.id, true)}>Add {kept === pr.changes ? 'all' : `${kept} of ${pr.changes}`}</button>
                    <button className="btn small" onClick={() => decide(pr.id, false)}>Skip all</button>
                  </span>
                </div>
              );
            })}
            {c.view.nodes.length <= 1 && c.view.pendingProposals.length === 0 && (
              <p className="pl-hint studio-empty">Your plan will take shape here as you talk. Cards you can move, group and connect appear as soon as there is something to show.</p>
            )}
            <div className="studio-main">
              <ProjectCanvas view={c.view} layout={c.layout} positions={c.positions} selectedId={selected} onSelect={setSelected} onPatch={c.patch} onArrange={c.arrange} excluded={left} onToggle={toggle} />
              <CardDetails node={node} onWork={work} onClose={() => setSelected(null)} onAssign={assign} />
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  );
}

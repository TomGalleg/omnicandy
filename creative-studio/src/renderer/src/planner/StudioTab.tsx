import { useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { PlannerChat } from './PlannerChat';
import { CardDetails, ProjectCanvas } from './ProjectCanvas';
import { errMsg, ErrorLine, type TabProps } from './plannerUi';
import { useCanvas } from './useCanvas';

const api = () => window.studio.planner;

/**
 * Studio: the conversation on the left, the plan as a visual canvas on the right. What the AI suggests appears on the canvas as dashed cards; it joins
 * the plan only when you press Add. The canvas, board and list are three ways of drawing the same plan.
 */
export function StudioTab(props: TabProps) {
  const { p, reload, go, setFocusTaskId, setSendSel } = props;
  const c = useCanvas(p);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const work = (taskId: string) => { setSendSel?.([taskId]); setFocusTaskId?.(taskId); go('handoffs'); };

  return (
    <div className="studio">
      <Group orientation="horizontal">
        <Panel id="studio-chat" defaultSize="36" minSize="22">
          <div className="studio-chat"><PlannerChat key={p.id} p={p} reload={reload} go={go} preview /></div>
        </Panel>
        <Separator className="sep" />
        <Panel id="studio-canvas" defaultSize="64" minSize="30">
          <div className="studio-plan">
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
              <CardDetails node={node} onWork={work} onClose={() => setSelected(null)} />
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  );
}

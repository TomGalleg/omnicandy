import { useEffect, useState } from 'react';
import type { BuildQueue } from '@shared/buildQueue';
import { titleOf } from '@shared/buildQueue';
import type { PlanTask } from '@shared/planner';
import type { DirectorKey } from '@shared/town';
import { errMsg } from './plannerUi';

const api = () => window.studio.director.build;

/**
 * The one line that shows how the build is going: who is working on what, step by step, and, when somebody needs the owner, who it is and why, with a button to walk
 * into their office. It shows only what is really happening (the saved queue), never a guess. Hidden while there is no build.
 */
export function BuildStrip({ tasks, openOffice, openPlan }: { tasks: readonly PlanTask[]; openOffice: (d: DirectorKey) => void; openPlan: () => void }) {
  const [q, setQ] = useState<BuildQueue | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let live = true; void api().state().then((s) => { if (live) setQ(s); }).catch(() => undefined); const off = api().onChange((s) => setQ(s)); return () => { live = false; off(); }; }, []);
  if (!q || q.status === 'idle' || (q.status === 'done' && hidden === q.startedAt)) return null;

  const titleOfTask = (id?: string) => tasks.find((t) => t.id === id)?.title ?? 'a task';
  const step = Math.min(q.order.length, q.finished.length + (q.current ? 1 : 0) || q.finished.length);
  const act = (fn: () => Promise<BuildQueue>) => { setError(null); void fn().then(setQ).catch((e) => setError(errMsg(e))); };
  const w = q.waiting;

  return (
    <div className={`tw-build tw-build-${q.status}`} role="status" aria-live="polite">
      {q.status === 'running' && (
        <>
          <span><strong>Building</strong> — task {Math.max(1, step)} of {q.order.length}{q.current ? `: ${titleOf(tasks.find((t) => t.id === q.current)?.assignee as DirectorKey ?? 'general-manager')} is working on "${titleOfTask(q.current)}"` : ''}.</span>
          <span className="pl-actions"><button className="btn small" onClick={() => act(api().pause)}>Pause after this one</button><button className="btn small" onClick={() => act(api().stop)}>Stop now</button></span>
        </>
      )}
      {q.status === 'waiting' && (
        <>
          <span><strong>{w ? `${titleOf(w.director)} needs you` : 'The build stopped'}.</strong> {w?.message}</span>
          <span className="pl-actions">
            {w && <button className="btn small primary" onClick={() => openOffice(w.director)}>Go to {titleOf(w.director)}'s office</button>}
            <button className="btn small" onClick={() => act(() => api().resume())}>Carry on</button>
          </span>
        </>
      )}
      {q.status === 'paused' && (
        <>
          <span><strong>Paused</strong> — {q.finished.length} of {q.order.length} tasks done.{q.why && q.why.startsWith('OmniCandy was closed') ? ` ${q.why}` : ''}</span>
          <span className="pl-actions"><button className="btn small primary" onClick={() => act(() => api().resume())}>Carry on</button></span>
        </>
      )}
      {q.status === 'done' && (
        <>
          <span><strong>The build is finished</strong> — {q.finished.length} task{q.finished.length === 1 ? '' : 's'} done. Their results are waiting for your review in the Plan.</span>
          <span className="pl-actions"><button className="btn small primary" onClick={openPlan}>Look at the plan</button><button className="btn small" onClick={() => setHidden(q.startedAt ?? '')}>Hide</button></span>
        </>
      )}
      {error && <span className="pl-error" role="alert">{error}</span>}
    </div>
  );
}

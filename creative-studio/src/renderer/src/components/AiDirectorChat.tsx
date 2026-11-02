import { useCallback, useEffect, useState } from 'react';
import type { PlannerProject } from '@shared/planner';
import { PlannerChat } from '../planner/PlannerChat';
import { useTown } from '../planner/useTown';

const api = () => window.studio.planner;
const OPEN_KEY = 'cs-ai-director-chat-open';

/** The chat itself, once the project's plan is loaded (the town says who the AI Director is). */
function DirectorChat({ plan, reload }: { plan: PlannerProject; reload: () => Promise<void> }) {
  const { town } = useTown(plan.id);
  const director = town?.agents.find((a) => a.director === 'ai-director' && !a.retired);
  if (!town) return <p className="pl-hint">Finding the AI Director…</p>;
  if (!director) return <p className="pl-hint">The AI Director is not on this project's team. Add them in OmniTown to chat here.</p>;
  return (
    <div className="adc-body">
      <p className="pl-hint">{director.name} approves, limits and records all AI work, and knows which AI makers are ready and what they cost. Ask which one fits what you want to make. This is the same conversation you have in their OmniTown office.</p>
      <PlannerChat key={`${plan.id}:${director.id}`} p={plan} reload={reload} go={() => {}} agent={{ id: director.id, name: director.name }} />
    </div>
  );
}

/** A chat window under AI Studio to talk to the AI Director of the open project. */
export function AiDirectorChat({ projectKey }: { projectKey?: string | null }) {
  const [open, setOpen] = useState<boolean>(() => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } });
  const [plan, setPlan] = useState<PlannerProject | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api().forProject();
      setPlan(s.plan?.id ? await api().get(s.plan.id) : null);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPlan(null); }
  }, []);
  useEffect(() => { setPlan(undefined); void load(); }, [projectKey, load]);

  const toggle = (v: boolean) => { setOpen(v); try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* storage unavailable */ } };

  return (
    <details className="adc" open={open} onToggle={(e) => toggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary><strong>Talk to the AI Director</strong></summary>
      {open && (plan === undefined ? <p className="pl-hint">Opening the chat…</p>
        : plan ? <DirectorChat plan={plan} reload={load} />
          : <p className="pl-hint">{error ?? 'Open a project, and open its OmniTown once, to chat with the AI Director.'}</p>)}
    </details>
  );
}

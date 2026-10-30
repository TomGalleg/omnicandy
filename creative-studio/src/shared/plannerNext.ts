// The one line that says what to do next, shown on every Planner tab with one button. It is worked out from the plan's own view (see nextStepsOf), so it
// never asks an AI anything and every tab gives the same advice.
import { nextStepsOf, type ProjectView } from './projectView';
import type { PlannerTab } from './plannerTabs';

export interface NextAction {
  text: string;
  /** The button only says "talk to the General Manager" (the town map has its own box for that, so it leaves this button out). */
  talksToManager?: boolean;
  /** The one button: what it says, which tab it opens, and which task it brings to the front there. */
  button: { label: string; tab: PlannerTab; taskId?: string };
}

/** The most urgent next step, or the closing line when every task is done. Nothing when the plan has nothing to say. */
export function nextAction(v: ProjectView): NextAction | null {
  const step = nextStepsOf(v)[0];
  if (step) {
    switch (step.kind) {
      case 'add-first-chunk': return { text: step.text, talksToManager: true, button: { label: 'Talk to the General Manager', tab: 'studio' } };
      case 'continue-current': return { text: step.text, button: { label: 'Work on this', tab: 'handoffs', taskId: step.taskId } };
      case 'review-report': return { text: step.text, button: { label: 'Review the result', tab: 'handoffs', taskId: step.taskId } };
      case 'review-proposal': return { text: step.text, button: { label: 'Look at the suggestion', tab: 'studio' } };
      case 'retake-stalled': return { text: step.text, button: { label: 'Take it back', tab: 'handoffs', taskId: step.taskId } };
    }
  }
  const real = v.nodes.filter((n) => (n.kind === 'chunk' || n.kind === 'task') && !n.flags.removed);
  if (real.length > 0) return { text: 'Every task is done. Tell the General Manager if there is more to make.', talksToManager: true, button: { label: 'Talk to the General Manager', tab: 'studio' } };
  return null;
}

// Which Planner tab a project opens on. The choice is remembered per project with the project (never in the plan), so reopening a project, or restarting the
// app, puts the owner back where they were. Pure rules: nothing here reads or writes anything.

/** The Planner's tabs. Simplified mode shows only OmniTown (the offices, the map chat and the Plan button cover the rest); Advanced mode shows all five. */
export const PLANNER_TABS = ['town', 'studio', 'plan', 'tasks', 'handoffs'] as const;
export type PlannerTab = (typeof PLANNER_TABS)[number];
export const SIMPLE_PLANNER_TABS: readonly PlannerTab[] = ['town'];

export const isPlannerTab = (x: unknown): x is PlannerTab => typeof x === 'string' && (PLANNER_TABS as readonly string[]).includes(x);

/**
 * The tab to show. Simplified mode has one view, OmniTown, whatever was saved. Advanced mode shows the saved tab, and Studio (the conversation with the General
 * Manager) for a project that has never chosen one or whose saved value is not a tab. What is shown never touches the saved value, so switching modes
 * returns to the choice made in Advanced.
 */
export function resolvePlannerTab(saved: unknown, advanced: boolean): PlannerTab {
  if (!advanced) return 'town';
  return isPlannerTab(saved) ? saved : 'studio';
}

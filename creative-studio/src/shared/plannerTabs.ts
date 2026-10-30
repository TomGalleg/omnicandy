// Which Planner tab a project opens on. The choice is remembered per project with the project (never in the plan), so reopening a project, or restarting the
// app, puts the owner back where they were. Pure rules: nothing here reads or writes anything.

/** The Planner's tabs. Simplified mode shows three of them; the other two exist only in Advanced mode. */
export const PLANNER_TABS = ['town', 'studio', 'plan', 'tasks', 'handoffs'] as const;
export type PlannerTab = (typeof PLANNER_TABS)[number];
export const SIMPLE_PLANNER_TABS: readonly PlannerTab[] = ['town', 'studio', 'handoffs'];

export const isPlannerTab = (x: unknown): x is PlannerTab => typeof x === 'string' && (PLANNER_TABS as readonly string[]).includes(x);

/**
 * The tab to show. A project that has never chosen one, or a saved value that is not a tab, opens on Studio (the conversation with the General Manager). In
 * Simplified mode an Advanced-only tab shows Studio instead: that is only what is shown. The saved value is not touched, so switching back to Advanced returns
 * to it.
 */
export function resolvePlannerTab(saved: unknown, advanced: boolean): PlannerTab {
  if (!isPlannerTab(saved)) return 'studio';
  if (!advanced && !SIMPLE_PLANNER_TABS.includes(saved)) return 'studio';
  return saved;
}

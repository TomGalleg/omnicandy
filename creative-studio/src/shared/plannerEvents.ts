// What the planner tells the windows (docs/planner-2.0/stage-1-blueprint.md, section 5). Events carry only ids and revision numbers, never plan
// content: a window that hears one asks for the data again. That keeps them small, ordered by revision, and safe to lose (windows also look
// again when they regain focus and on a slow timer, so nothing depends on every event arriving).
export type PlannerEvent =
  | { type: 'plan.changed'; planId: string; revision: number; planRevision: number; origin: 'app' | 'external'; at: string }
  | { type: 'canvas.changed'; planId: string; layoutRev: number; origin: 'app' | 'external'; at: string }
  | { type: 'chat.changed'; planId: string; messages: number; at: string }
  | { type: 'town.changed'; planId: string; rev: number; at: string }
  | { type: 'plan.recovered'; planId: string; what: 'canvas' | 'chat' | 'town'; note: string; at: string };
// Reserved for later stages, not sent today: run.* (work in progress) and live agent activity.

/** True when a window that already has revision `seen` of `planId` should ask for the plan again. */
export function shouldRefresh(e: PlannerEvent, planId: string | null, seen: number): boolean {
  return e.type === 'plan.changed' && e.planId === planId && e.revision > seen;
}

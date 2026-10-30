// What the General Manager is told, in one place. The owner reaches them through four doors (the Studio chat, their office, the map card and the Town
// Hall), and it must be the same person behind all of them: same team, same knowledge of the project and of what changed lately, same way of working.
// Two settings only change HOW they speak, never who they are:
//   planning  talking an idea through with the owner one to one (the Studio, their office): ask a little, say back what they understood, offer the plan
//   meeting   one voice among several at the Town Hall: short answers; the message itself carries the meeting's rules
import type { PlannerProject } from './planner';
import { planSummary } from './plannerContext';
import { chatSystemPrompt, connectedAppsLine, type ChatMode } from './plannerChat';
import { generalManagerIntro, type TownState } from './town';

export interface GeneralManagerInput {
  town: TownState;
  plan: PlannerProject;
  /** What the project already contains (names and counts), when this is the open project's plan. */
  context?: string[];
  /** What changed in the plan lately (see townNews). */
  news?: string[];
  /** Names of the connected applications. */
  apps?: string[];
  /** In planning: talk the idea through, or (the owner said yes) write the tasks. */
  mode?: ChatMode;
  setting?: 'planning' | 'meeting';
}

const MEETING_RULES = [
  'You are in a meeting at the Town Hall with the owner and the rest of the team. The message you are sent says what is being asked of you: do exactly that, from your own job as General Manager.',
  'Plain, short sentences. Never say that anything is done unless the owner has said so, and do not change the plan: the owner decides what joins it.',
];

export function generalManagerPrompt(i: GeneralManagerInput): string {
  const meeting = i.setting === 'meeting';
  const body = meeting
    ? [...MEETING_RULES, ...(i.context?.length ? ['', 'What this OmniCandy project already contains (names and counts only):', ...i.context] : []), '', 'The project so far:', ...planSummary(i.plan)].join('\n')
    : chatSystemPrompt(i.plan, i.context ?? [], i.mode ?? 'talk');
  return [
    ...generalManagerIntro(i.town),
    body,
    ...(i.news?.length ? ['', ...i.news] : []),
    ...(i.apps?.length ? ['', ...connectedAppsLine(i.apps)] : []),
  ].join('\n');
}

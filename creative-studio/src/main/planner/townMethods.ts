// The OmniTown calls the windows can make: the town, the team, and meetings. Like viewMethods.ts they are spread into the planner's single channel,
// so they share its trusted-sender check and its "point the store at the open project first" step.
//
// Who may do what: the window acts as the owner, so it may change the team. The coordinator (an AI helper) may only SUGGEST a team, which waits for
// the owner. A meeting is a record: calling one does not start any AI. What a meeting proposes for the plan is a pending proposal, never an edit.
import { z } from 'zod';
import { changeSchema } from '@shared/planner';
import {
  addMeetingNote, addTeamSuggestion, applyTeamChanges, decideTeamSuggestion, endMeeting, linkMeetingProposal, MEETING_KINDS, startMeeting, suggestTeamFromPlan, teamChangesSchema,
  type TownMeeting, type TownState,
} from '@shared/town';
import type { ProjectCoordinator } from './coordinator';
import type { PlannerService } from './service';
import { PlannerError, type PlannerStore } from './store';

const planId = z.string().regex(/^plan_[a-z0-9]{6,20}$/);
const text = (n: number) => z.string().trim().max(n);
const refId = z.string().regex(/^[a-z]{2,10}_[a-z0-9]{4,24}$/);
const meetingReq = z.object({ topic: text(200).min(1), kind: z.enum(MEETING_KINDS as [string, ...string[]]).optional(), participantIds: z.array(refId).max(12) }).strict();
const noteReq = z.object({ by: text(60).min(1), text: text(2000).min(1) }).strict();
const suggestReq = z.object({ note: text(1000), changes: teamChangesSchema }).strict();
const draftReq = z.object({ note: text(1000), changes: z.array(changeSchema).min(1).max(80) }).strict();

export interface TownMethodDeps { store: PlannerStore; coordinator: ProjectCoordinator; service: PlannerService }

export function createTownMethods(d: TownMethodDeps): Record<string, (...a: any[]) => unknown> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const COORDINATOR = 'Project coordinator';
  return {
    townLoad: (id: string) => d.store.readTown(planId.parse(id)),
    townApply: (id: string, changes: unknown) => d.store.updateTown(planId.parse(id), (t, now) => applyTeamChanges(t, teamChangesSchema.parse(changes), now)),
    townSuggest: (id: string, req: unknown) => {
      const r = suggestReq.parse(req);
      return d.store.updateTown(planId.parse(id), (t, now) => addTeamSuggestion(t, COORDINATOR, r.note, r.changes, now).town);
    },
    /** Looks at which kinds of work the plan names (the application on each task) and suggests a studio and a specialist for each. No AI is used. */
    townSuggestFromPlan: async (id: string) => {
      const pid = planId.parse(id);
      const plan = await d.service.getProject(d.coordinator.ctx, pid);
      const hints = plan.tasks.filter((t) => t.status !== 'cancelled' && t.appRef).map((t) => ({ id: t.appRef!.id, note: t.appRef!.note }));
      return d.store.updateTown(pid, (t, now) => {
        const changes = suggestTeamFromPlan(t, hints);
        if (!changes.length) throw new PlannerError('invalid', 'There is nothing new to suggest. Name the application on a task and the team can grow to match.');
        return addTeamSuggestion(t, COORDINATOR, 'A studio and a specialist for each kind of work in your plan', changes, now).town;
      });
    },
    townDecide: (id: string, suggestionId: string, accept: boolean) => d.store.updateTown(planId.parse(id), (t, now) => decideTeamSuggestion(t, refId.parse(suggestionId), accept === true, now)),

    meetingStart: async (id: string, req: unknown): Promise<{ town: TownState; meeting: TownMeeting }> => {
      const r = meetingReq.parse(req);
      let meeting!: TownMeeting;
      const town = await d.store.updateTown(planId.parse(id), (t, now) => { const s = startMeeting(t, { topic: r.topic, kind: r.kind as TownMeeting['kind'] | undefined, participantIds: r.participantIds }, now); meeting = s.meeting; return s.town; });
      return { town, meeting };
    },
    meetingNote: (id: string, meetingId: string, note: unknown) => { const n = noteReq.parse(note); return d.store.updateTown(planId.parse(id), (t, now) => addMeetingNote(t, refId.parse(meetingId), n, now)); },
    meetingEnd: (id: string, meetingId: string) => d.store.updateTown(planId.parse(id), (t, now) => endMeeting(t, refId.parse(meetingId), now)),
    /** What the meeting decided for the plan becomes ONE pending proposal from the coordinator, remembered on the meeting. The owner adds it from the canvas. */
    meetingPropose: async (id: string, meetingId: string, draft: unknown) => {
      const pid = planId.parse(id);
      const mid = refId.parse(meetingId);
      const dr = draftReq.parse(draft);
      const { town } = await d.store.readTown(pid);
      if (!town.meetings.some((m) => m.id === mid)) throw new PlannerError('not_found', 'There is no meeting with that id.');
      const { proposalId } = await d.coordinator.proposeChanges(pid, dr);
      await d.store.updateTown(pid, (t, now) => linkMeetingProposal(t, mid, proposalId, now));
      return { proposalId };
    },
  };
}

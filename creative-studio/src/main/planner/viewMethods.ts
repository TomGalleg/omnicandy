// The Planner 2.0 calls the windows can make: the shared view, the canvas layout, saving a chat message, and proposing changes.
// They live apart from the older method table (ipc.ts) so they can be tested without Electron; ipc.ts spreads them into that table, so they
// share its single channel, its trusted-sender check and its "point the store at the open project first" step.
import { z } from 'zod';
import { canvasPatchSchema } from '@shared/plannerCanvas';
import { changeSchema } from '@shared/planner';
import { CHAT_MAX_CHARS, type PlannerStore } from './store';
import type { ProjectCoordinator } from './coordinator';

const planId = z.string().regex(/^plan_[a-z0-9]{6,20}$/);
const chatAppendSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(CHAT_MAX_CHARS * 2) }).strict()).min(1).max(4),
  provider: z.enum(['claude', 'openai', 'gemini']).optional(),
  model: z.string().min(1).max(80).optional(),
}).strict();
const draftSchema = z.object({ note: z.string().max(1000), changes: z.array(changeSchema).min(1).max(80) }).strict();

export interface ViewMethodDeps { coordinator: ProjectCoordinator; store: PlannerStore }

export function createViewMethods(d: ViewMethodDeps): Record<string, (...a: any[]) => unknown> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    view: (id?: string) => d.coordinator.view(id === undefined ? undefined : planId.parse(id)),
    canvasLoad: (id: string) => d.store.readCanvas(planId.parse(id)),
    canvasPatch: (id: string, patch: unknown) => d.store.patchCanvas(planId.parse(id), canvasPatchSchema.parse(patch)),
    chatAppend: (id: string, req: unknown) => d.store.appendChat(planId.parse(id), chatAppendSchema.parse(req)),
    proposeChanges: (id: string, draft: unknown) => d.coordinator.proposeChanges(planId.parse(id), draftSchema.parse(draft)),
    nextSteps: (id: string) => d.coordinator.nextSteps(planId.parse(id)),
  };
}

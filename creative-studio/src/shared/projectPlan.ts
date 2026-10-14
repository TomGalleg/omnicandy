// Project categories and the creative plan Claude proposes for a described project (Phase 3).
import { z } from 'zod';

export const PROJECT_KINDS = [
  { id: 'image', label: 'Image / Photography', workspace: 'edit' },
  { id: 'design', label: 'Graphic Design', workspace: 'edit' },
  { id: 'video', label: 'Video / Animation', workspace: 'edit' },
  { id: 'audio', label: 'Audio', workspace: 'audio' },
  { id: 'mixed', label: 'Mixed Media', workspace: 'media' },
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number]['id'];
export const projectKindLabel = (k: string | undefined) => PROJECT_KINDS.find((p) => p.id === k)?.label ?? 'Project';

const kindIds = PROJECT_KINDS.map((p) => p.id) as [ProjectKind, ...ProjectKind[]];
const short = (n: number) => z.string().trim().min(1).max(n);

export const projectPlanSchema = z.object({
  name: short(80),
  kind: z.enum(kindIds),
  finishedOutput: short(300),
  summary: short(600),
  apps: z.array(short(40)).max(7).default([]),
  aiTools: z.array(short(200)).max(5).default([]),
  steps: z.array(short(240)).min(1).max(8),
  questions: z.array(short(240)).max(3).default([]),
  /** Id of a built-in template that fits (or null). Only a recommendation: nothing is applied until approval. */
  template: z.string().trim().max(80).nullish(),
});
export type ProjectPlan = z.infer<typeof projectPlanSchema>;

/** Pulls the JSON plan out of Claude's reply (tolerates a code fence or a sentence around it). */
export function parseProjectPlan(reply: string): ProjectPlan {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Claude did not return a plan. Try describing the project again.');
  let raw: unknown;
  try { raw = JSON.parse(reply.slice(start, end + 1)); } catch { throw new Error('Claude\'s plan could not be read. Try again.'); }
  const r = projectPlanSchema.safeParse(raw);
  if (!r.success) throw new Error('Claude\'s plan was incomplete. Try again with a little more detail.');
  return r.data;
}

/** Text saved as the project's creative brief. */
export function briefFromPlan(request: string, plan: ProjectPlan): string {
  return `${request.trim()}\n\nFinished output: ${plan.finishedOutput}\n${plan.summary}`.slice(0, 2000);
}

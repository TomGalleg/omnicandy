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
  apps: z.array(short(40)).max(13).default([]),
  aiTools: z.array(short(200)).max(5).default([]),
  steps: z.array(short(240)).min(1).max(8),
  questions: z.array(short(240)).max(3).default([]),
  /** Id of a built-in template that fits (or null). Only a recommendation: nothing is applied until approval. */
  template: z.string().trim().max(80).nullish(),
});
export type ProjectPlan = z.infer<typeof projectPlanSchema>;

/**
 * Claude sometimes lists a little more than the limits (every app, one more step). Over-long lists and sentences are cut to fit
 * rather than throwing the whole plan away; missing or wrongly typed fields still fail.
 */
function trimToLimits(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const o = { ...(raw as Record<string, unknown>) };
  // Claude sometimes answers a list entry as an object ({ model, purpose }) instead of one sentence: join its text values.
  const text = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v as Record<string, unknown>).filter((x) => typeof x === 'string' && x.trim()).join(' - ') : v);
  const cut = (v: unknown, n: number) => { const t = text(v); return typeof t === 'string' ? t.trim().slice(0, n) : t; };
  const list = (v: unknown, max: number, n: number) => (Array.isArray(v) ? v.map((x) => cut(x, n)).filter((x) => x !== '').slice(0, max) : v);
  o.name = cut(o.name, 80); o.finishedOutput = cut(o.finishedOutput, 300); o.summary = cut(o.summary, 600);
  if ('apps' in o) o.apps = list(o.apps, 13, 40);
  if ('aiTools' in o) o.aiTools = list(o.aiTools, 5, 200);
  o.steps = list(o.steps, 8, 240);
  if ('questions' in o) o.questions = list(o.questions, 3, 240);
  return o;
}

/** Pulls the JSON plan out of Claude's reply (tolerates a code fence or a sentence around it). */
export function parseProjectPlan(reply: string): ProjectPlan {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI did not return a plan. Try describing the project again.');
  let raw: unknown;
  try { raw = JSON.parse(reply.slice(start, end + 1)); } catch { throw new Error('Claude\'s plan could not be read. Try again.'); }
  const r = projectPlanSchema.safeParse(trimToLimits(raw));
  if (!r.success) {
    const why = r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`).join('; ');
    throw new Error(`The plan was incomplete (${why}). Try again with a little more detail.`);
  }
  return r.data;
}

/** Text saved as the project's creative brief. */
export function briefFromPlan(request: string, plan: ProjectPlan): string {
  return `${request.trim()}\n\nFinished output: ${plan.finishedOutput}\n${plan.summary}`.slice(0, 2000);
}

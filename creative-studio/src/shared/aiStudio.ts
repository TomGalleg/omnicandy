// Pure logic behind the AI Studio screen: what state a model card is in, and the job list.
// No Electron, no network, no React, so it is unit-tested.

import type { StudioModel } from './providerCapabilities';
import { studioProvider } from './providerCapabilities';

/** ready = can generate now; needs-key = wired but no key saved; soon = verified in docs, not connected yet. */
export type CardState = 'ready' | 'needs-key' | 'soon';

export function cardState(m: StudioModel, configured: ReadonlySet<string>): CardState {
  if (m.availability !== 'wired') return 'soon';
  const p = studioProvider(m.providerId);
  if (!p?.billable) return 'ready';
  return configured.has(m.providerId) ? 'ready' : 'needs-key';
}

export type JobState = 'running' | 'done' | 'failed' | 'canceled';

export interface StudioJob {
  id: string;
  at: string;
  providerId: string;
  modelId: string;
  modelLabel: string;
  prompt: string;
  settings: Record<string, string>;
  count: number;
  referenceAssetIds: string[];
  state: JobState;
  /** Result summary or the plain-words error. */
  message?: string;
  assetIds?: string[];
  estimateUsd?: number;
}

export const MAX_JOBS = 50;
const STATES: JobState[] = ['running', 'done', 'failed', 'canceled'];

/** Parses saved jobs defensively. A job that was 'running' when the app closed cannot still be running:
 *  it is shown as failed and is never re-sent automatically (a paid request must be re-approved). */
export function loadJobs(raw: string | null): StudioJob[] {
  if (!raw) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const jobs: StudioJob[] = [];
  for (const j of data) {
    if (!j || typeof j !== 'object') continue;
    const o = j as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.prompt !== 'string' || typeof o.modelId !== 'string' || !STATES.includes(o.state as JobState)) continue;
    const job = o as unknown as StudioJob;
    jobs.push(job.state === 'running' ? { ...job, state: 'failed', message: 'OmniCandy closed before this finished. Check your provider billing before trying again.' } : job);
  }
  return jobs.slice(0, MAX_JOBS);
}

export const addJob = (jobs: StudioJob[], job: StudioJob): StudioJob[] => [job, ...jobs].slice(0, MAX_JOBS);
export const updateJob = (jobs: StudioJob[], id: string, patch: Partial<StudioJob>): StudioJob[] => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));

/** Draft handed over by another screen (e.g. a Quick AI panel) so the studio opens with the same choices. */
export interface StudioDraft { providerId?: string; modelId?: string; prompt?: string; referenceAssetId?: string }

export function parseDraft(raw: string | null): StudioDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const s = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
    const out: StudioDraft = {};
    const providerId = s(d.providerId, 40), modelId = s(d.modelId, 120), prompt = s(d.prompt, 4000), referenceAssetId = s(d.referenceAssetId, 128);
    if (providerId) out.providerId = providerId;
    if (modelId) out.modelId = modelId;
    if (prompt) out.prompt = prompt;
    if (referenceAssetId) out.referenceAssetId = referenceAssetId;
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

export const SURPRISE_PROMPTS = [
  'A paper-cut fox leaping across a moonlit river, layered shadows',
  'A tiny greenhouse city floating in the clouds at golden hour',
  'Retro-futuristic diner on Mars, neon rain, 35mm film look',
  'A glass jellyfish lantern in a quiet library',
  'An isometric cutaway of a cozy treehouse workshop',
  'Bold flat-colour poster of a lighthouse in a storm',
];

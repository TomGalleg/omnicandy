// AI image generation in the main process. Keys come only from the vault (lent per call), every
// billable call needs the user's approval for the shown estimate (a native dialog in main, so
// neither the renderer nor Claude can skip it), and results become new originals with provenance.

import fs from 'node:fs/promises';
import path from 'node:path';
import { estimateCost, IMAGE_MODELS, modelById, normalizeJob, providerById, type CostEstimate, type ImageJob, type ProviderId } from '@shared/generation';
import {
  extForMime, geminiInteractionBody, openaiEditFields, openaiGenerationBody, parseGeminiImage, parseModelList, parseOpenAIImages,
  type GeneratedImage, type RefImage,
} from './imageApis';
import type { Asset } from '@shared/types';
import { redact, type KeyMeta, type KeyTest, type SafeStorageVault } from './credentialVault';
import { testPattern } from './png';
import type { ProjectStore } from './projectStore';

export const OPENAI_BASE = 'https://api.openai.com/v1';
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** The AI that is asking, for the approval card text. */
export type Requester = 'claude' | 'independent';

/** Card heading prefix: names the AI that is really asking. Claude wording is unchanged for Claude requests. */
export function approvalAsker(r: { requestedBy: 'user' | 'claude'; requester?: Requester }): string {
  if (r.requester === 'independent') return 'Independent AI is asking to generate';
  return r.requestedBy === 'claude' ? 'Claude is asking to generate' : 'Generate';
}

export interface ApprovalRequest {
  /** 'video' for Veo jobs (default 'image'). */
  kind?: 'image' | 'video';
  provider: string;
  model: string;
  prompt: string;
  count: number;
  settings: Record<string, string>;
  references: string[];
  estimate: CostEstimate;
  requestedBy: 'user' | 'claude';
  /** Who is shown as asking. Display only: billing, spend records and approval enforcement all use `requestedBy`. */
  requester?: Requester;
  /** This project's limit and what is already estimated as spent (USD); null limit = none. */
  limitUsd?: number | null;
  spentUsd?: number;
}

export interface GenerationDeps {
  vault: Pick<SafeStorageVault, 'status' | 'meta' | 'withKey' | 'setLastTest'>;
  store: () => Promise<ProjectStore>;
  /** Asks the user to approve a billable call. Must resolve false unless they clearly agree. */
  approve: (r: ApprovalRequest) => Promise<boolean>;
  fetch: typeof fetch;
  timeoutMs?: number;
}

export interface GenerateResult { assets: Asset[]; duplicates: number; estimate: CostEstimate; message: string }

export class GenerationCancelled extends Error {
  constructor() { super('Generation cancelled. Nothing was sent and nothing was charged.'); }
}

const REF_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

async function failure(res: Response, provider: string): Promise<Error> {
  let detail = '';
  try {
    const j = (await res.json()) as { error?: { message?: string } | string };
    detail = typeof j.error === 'string' ? j.error : j.error?.message ?? '';
  } catch { /* not JSON */ }
  const why = res.status === 401 || res.status === 403 ? 'the key was rejected'
    : res.status === 429 ? 'rate limit or quota reached'
    : res.status === 400 ? 'the request was refused'
    : `HTTP ${res.status}`;
  return new Error(redact(`${provider}: ${why}${detail ? ` — ${detail.slice(0, 400)}` : ''}`, null));
}

export class GenerationService {
  private busy = false;

  constructor(private readonly d: GenerationDeps) {}

  get isBusy() { return this.busy; }

  async providerStatus() {
    const out: Array<{ id: ProviderId; configured: boolean; unreadable: boolean; meta: KeyMeta | null }> = [];
    for (const p of ['openai', 'gemini', 'runway'] as const) {
      const s = await this.d.vault.status(p);
      out.push({ id: p, configured: s.configured, unreadable: !!s.unreadable, meta: await this.d.vault.meta(p) });
    }
    return out;
  }

  /** Lists models with the saved key (free; no image is generated). */
  async testConnection(provider: 'openai' | 'gemini' | 'runway'): Promise<KeyTest> {
    if (provider === 'runway') return this.testRunway();
    const at = new Date().toISOString();
    let test: KeyTest;
    try {
      const ids = await this.d.vault.withKey(provider, async (key) => {
        const res = provider === 'openai'
          ? await this.d.fetch(`${OPENAI_BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
          : await this.d.fetch(`${GEMINI_BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw await failure(res, providerById(provider)!.label);
        return parseModelList(provider, await res.json());
      });
      const ours = IMAGE_MODELS.filter((m) => m.provider === provider).map((m) => m.id);
      const models = ours.filter((id) => ids.includes(id));
      test = {
        ok: true, at, models,
        message: models.length ? `Connected. Image models on this key: ${models.length} of ${ours.length}.` : `Connected (${ids.length} models listed, none of OmniCandy's image models among them; all are shown).`,
      };
    } catch (e) {
      test = { ok: false, at, message: e instanceof Error ? e.message : String(e) };
    }
    await this.d.vault.setLastTest(provider, test);
    return test;
  }

  /** Free: reads the organisation record (credit balance). No video is made. */
  private async testRunway(): Promise<KeyTest> {
    const at = new Date().toISOString();
    let test: KeyTest;
    try {
      const credits = await this.d.vault.withKey('runway', async (key) => {
        const res = await this.d.fetch('https://api.dev.runwayml.com/v1/organization', { headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06' }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw await failure(res, 'Runway');
        const j = (await res.json()) as { creditBalance?: number };
        return typeof j.creditBalance === 'number' ? j.creditBalance : null;
      });
      test = { ok: true, at, models: [], message: credits === null ? 'Connected to Runway.' : `Connected. Runway credit balance: ${credits} credits (about $${(credits / 100).toFixed(2)}).` };
    } catch (e) {
      test = { ok: false, at, message: e instanceof Error ? e.message : String(e) };
    }
    await this.d.vault.setLastTest('runway', test);
    return test;
  }

  estimate(job: ImageJob): CostEstimate { return estimateCost(job); }

  async generate(raw: ImageJob, requestedBy: 'user' | 'claude', requester?: Requester): Promise<GenerateResult> {
    if (this.busy) throw new Error('A generation is already running. Wait for it to finish.');
    const job = normalizeJob(raw);
    const model = modelById(job.modelId)!;
    const provider = providerById(model.provider)!;
    if (provider.billable) {
      const key = await this.d.vault.status(provider.id);
      if (key.unreadable) throw new Error(`The saved ${provider.label} API key can't be read on this PC (it was saved by another PC or Windows user). Add it again (Settings → Integrations).`);
      if (!key.configured) throw new Error(`Add your ${provider.label} API key first (Generate → Providers).`);
    }
    const store = await this.d.store();
    const manifest = await store.loadManifest();
    const refs: RefImage[] = [];
    for (const id of job.referenceAssetIds) {
      const a = manifest.assets.find((x) => x.id === id);
      if (!a) throw new Error('A reference image is no longer in the library.');
      const mime = REF_MIME[a.sourceFormat];
      if (!mime) throw new Error(`${a.name}: only PNG, JPEG or WebP pictures can be used as references.`);
      refs.push({ mime, name: a.name, data: await fs.readFile(await store.resolveAssetPath(id)) });
    }

    const estimate = estimateCost(job);
    const spend = provider.billable ? await store.spending() : null;
    if (spend && spend.limitUsd !== null && spend.spentUsd + estimate.amount > spend.limitUsd) {
      throw new Error(`This would go over the project's spending limit of $${spend.limitUsd.toFixed(2)}: about $${spend.spentUsd.toFixed(2)} is already estimated as spent and this request is about $${estimate.amount.toFixed(2)}. Nothing was sent. Raise the limit in AI Generate to continue.`);
    }
    this.busy = true;
    try {
      if (provider.billable) {
        const ok = await this.d.approve({
          provider: provider.label, model: model.label, prompt: job.prompt, count: job.count, settings: job.settings,
          references: refs.map((r) => r.name), estimate, requestedBy, ...(requester ? { requester } : {}), limitUsd: spend?.limitUsd ?? null, spentUsd: spend?.spentUsd ?? 0,
        });
        if (ok !== true) throw new GenerationCancelled();
      }
      const images = await this.call(model.provider, job, refs);
      const dir = path.join(await store.workDir(), 'generate');
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const slug = job.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
      const assets: Asset[] = [];
      let duplicates = 0;
      for (const [i, img] of images.entries()) {
        const name = `${slug}-${stamp}${images.length > 1 ? `-${i + 1}` : ''}.${extForMime(img.mime)}`;
        const file = path.join(dir, name);
        await fs.writeFile(file, img.data);
        const r = await store.addGeneratedFile(file, {
          name,
          provenance: {
            source: `Generated with ${provider.label} · ${model.label} (${model.id})`,
            prompt: job.prompt, provider: provider.id, model: model.id, settings: job.settings,
            estimatedCostUsd: estimate.amount, requestedBy,
            ...(job.referenceAssetIds.length ? { referenceAssetIds: job.referenceAssetIds } : {}),
            licensingNotes: provider.billable ? `AI-generated via ${provider.label}. Check ${provider.label}'s terms for usage rights.` : 'Mock test pattern.',
          },
        });
        if (r.duplicateOf) duplicates++; else assets.push(r.asset);
      }
      if (provider.billable) await store.recordSpend({ at: new Date().toISOString(), provider: provider.id, model: model.id, images: images.length, estimateUsd: estimate.amount, requestedBy });
      const message = `${assets.length} new image${assets.length === 1 ? '' : 's'} from ${model.label}${provider.billable ? ` (estimated ${estimate.amount.toFixed(3)} USD)` : ''}.${duplicates ? ` ${duplicates} identical result${duplicates === 1 ? ' was' : 's were'} already in the library.` : ''}`;
      return { assets, duplicates, estimate, message };
    } finally {
      this.busy = false;
    }
  }

  private async call(provider: ProviderId, job: ImageJob, refs: RefImage[]): Promise<GeneratedImage[]> {
    const signal = AbortSignal.timeout(this.d.timeoutMs ?? 300_000);
    if (provider === 'mock') {
      const [w, h] = (job.settings.size ?? '512x512').split('x').map(Number) as [number, number];
      const seed = [...job.prompt].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
      return Array.from({ length: job.count }, (_, i) => ({ mime: 'image/png', data: testPattern(w, h, seed + i) }));
    }
    if (provider === 'openai') {
      return this.d.vault.withKey('openai', async (key) => {
        let res: Response;
        if (refs.length) {
          const form = new FormData();
          for (const [k, v] of Object.entries(openaiEditFields(job))) form.append(k, v);
          for (const r of refs) form.append('image[]', new Blob([new Uint8Array(r.data)], { type: r.mime }), r.name);
          res = await this.d.fetch(`${OPENAI_BASE}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal });
        } else {
          res = await this.d.fetch(`${OPENAI_BASE}/images/generations`, {
            method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(openaiGenerationBody(job)), signal,
          });
        }
        if (!res.ok) throw await failure(res, 'OpenAI');
        return parseOpenAIImages(await res.json());
      });
    }
    // Gemini returns one image per interaction; the approved count is made one request at a time.
    return this.d.vault.withKey('gemini', async (key) => {
      const out: GeneratedImage[] = [];
      for (let i = 0; i < job.count; i++) {
        const res = await this.d.fetch(`${GEMINI_BASE}/interactions`, {
          method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(geminiInteractionBody(job, refs)), signal,
        });
        try {
          if (!res.ok) throw await failure(res, 'Google Gemini');
          out.push(parseGeminiImage(await res.json()));
        } catch (e) {
          if (!out.length) throw e;
          break; // keep the images already paid for
        }
      }
      return out;
    });
  }
}

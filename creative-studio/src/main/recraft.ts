// Recraft image generation (direct API, independent of every other provider). Same rules as GenerationService:
// the key is lent by the vault per call, a native approval for the shown price comes first, the project's
// spending limit is checked, results become new originals with provenance, and a paid request is never retried.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Asset } from '@shared/types';
import { estimateRecraft, normalizeRecraftJob, recraftBody, recraftModel, RECRAFT_BASE, type RecraftJob } from '@shared/recraft';
import { redact } from './credentialVault';
import { GenerationCancelled, type GenerationDeps, type GenerateResult } from './generation';

export interface RecraftImage { mime: string; data: Buffer; ext: string }

/** data[].b64_json is the documented base64 form. Vector models return SVG. */
export function parseRecraftImages(json: unknown, output: 'raster' | 'svg'): { images: RecraftImage[]; credits: number | null } {
  const j = json as { credits?: unknown; data?: Array<{ b64_json?: unknown }> };
  if (!Array.isArray(j?.data)) throw new Error('Recraft returned no images.');
  const images = j.data.filter((d) => typeof d?.b64_json === 'string').map((d) => {
    const data = Buffer.from(d.b64_json as string, 'base64');
    return output === 'svg' ? { mime: 'image/svg+xml', data, ext: 'svg' } : { mime: 'image/png', data, ext: 'png' };
  });
  if (!images.length) throw new Error('Recraft returned no images.');
  if (output === 'svg') for (const i of images) if (!/<svg[\s>]/i.test(i.data.subarray(0, 2048).toString('utf8'))) throw new Error('Recraft returned something that is not an SVG.');
  return { images, credits: typeof j.credits === 'number' ? j.credits : null };
}

async function failure(res: Response): Promise<Error> {
  let detail = '';
  try {
    const j = (await res.json()) as { message?: string; error?: { message?: string } | string };
    detail = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? '';
  } catch { /* not JSON */ }
  const why = res.status === 401 || res.status === 403 ? 'the key was rejected'
    : res.status === 402 ? 'not enough Recraft API units; buy units on recraft.ai'
    : res.status === 429 ? 'rate limit reached'
    : res.status === 400 ? 'the request was refused'
    : `HTTP ${res.status}`;
  return new Error(redact(`Recraft: ${why}${detail ? ` — ${detail.slice(0, 400)}` : ''}`, null));
}

export class RecraftService {
  private busy = false;
  constructor(private readonly d: GenerationDeps) {}

  async generate(raw: RecraftJob, requestedBy: 'user' | 'claude'): Promise<GenerateResult> {
    if (this.busy) throw new Error('A Recraft generation is already running. Wait for it to finish.');
    const job = normalizeRecraftJob(raw);
    const model = recraftModel(job.modelId)!;
    const key = await this.d.vault.status('recraft');
    if (key.unreadable) throw new Error("The saved Recraft API key can't be read on this PC. Add it again (Settings → Integrations).");
    if (!key.configured) throw new Error('Add your Recraft API key first (Settings → Integrations).');
    const store = await this.d.store();
    const estimate = estimateRecraft(job);
    const spend = await store.spending();
    if (spend.limitUsd !== null && spend.spentUsd + estimate.amount > spend.limitUsd) {
      throw new Error(`This would go over the project's spending limit of $${spend.limitUsd.toFixed(2)}: about $${spend.spentUsd.toFixed(2)} is already estimated as spent and this request is about $${estimate.amount.toFixed(2)}. Nothing was sent.`);
    }
    this.busy = true;
    try {
      const settings: Record<string, string> = { shape: job.aspect, ...(job.colors.length ? { colors: job.colors.join(' ') } : {}), ...(job.background ? { background: job.background } : {}) };
      const ok = await this.d.approve({
        provider: 'Recraft', model: model.label, prompt: job.prompt, count: job.count, settings, references: [],
        estimate, requestedBy, limitUsd: spend.limitUsd, spentUsd: spend.spentUsd,
      });
      if (ok !== true) throw new GenerationCancelled();

      const parsed = await this.d.vault.withKey('recraft', async (k) => {
        const res = await this.d.fetch(`${RECRAFT_BASE}/images/generations`, {
          method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(recraftBody(job)), signal: AbortSignal.timeout(this.d.timeoutMs ?? 180_000),
        });
        if (!res.ok) throw await failure(res);
        return parseRecraftImages(await res.json(), model.output);
      });

      const dir = path.join(await store.workDir(), 'generate');
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const slug = job.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
      const assets: Asset[] = [];
      let duplicates = 0;
      for (const [i, img] of parsed.images.entries()) {
        const name = `${slug}-${stamp}${parsed.images.length > 1 ? `-${i + 1}` : ''}.${img.ext}`;
        const file = path.join(dir, name);
        await fs.writeFile(file, img.data);
        const r = await store.addGeneratedFile(file, {
          name,
          provenance: {
            source: `Generated with Recraft · ${model.label} (${model.id})`,
            prompt: job.prompt, provider: 'recraft', model: model.id, settings,
            estimatedCostUsd: estimate.amount, requestedBy,
            licensingNotes: "AI-generated via Recraft. Check Recraft's terms for usage rights.",
          },
        });
        if (r.duplicateOf) duplicates++; else assets.push(r.asset);
      }
      // Recraft reports the units a request used (1 unit = $0.001 in its docs); the estimate is kept when it does not.
      const actual = parsed.credits !== null ? Math.round(parsed.credits) / 1000 : estimate.amount;
      await store.recordSpend({ at: new Date().toISOString(), provider: 'recraft', model: model.id, images: parsed.images.length, estimateUsd: actual, requestedBy });
      const kind = model.output === 'svg' ? 'SVG' : 'image';
      const message = `${assets.length} new ${kind}${assets.length === 1 ? '' : 's'} from ${model.label}${parsed.credits !== null ? ` (${parsed.credits} Recraft units, about $${actual.toFixed(3)})` : ` (estimated ${estimate.amount.toFixed(3)} USD)`}.${duplicates ? ` ${duplicates} identical result${duplicates === 1 ? ' was' : 's were'} already in the library.` : ''}`;
      return { assets, duplicates, estimate, message };
    } finally {
      this.busy = false;
    }
  }
}

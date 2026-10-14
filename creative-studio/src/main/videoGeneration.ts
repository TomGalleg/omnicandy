// AI video generation in the main process. Same rules as images: the key comes only from the vault,
// every billable submit needs the user's approval in a native dialog, the project spending limit is
// checked first, and results become new originals with provenance. Video takes minutes, so a job is
// saved with the project and tracked in the background; after a window change or restart the saved
// operation is polled again (Google keeps the file for 2 days).

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ACTIVE_VIDEO_STATES, estimateVideoCost, normalizeVideoJob, videoModelById, type VideoJob, type VideoJobRecord } from '@shared/video';
import { GEMINI_BASE, GenerationCancelled, type GenerationDeps } from './generation';
import { redact } from './credentialVault';
import type { ProjectStore } from './projectStore';
import { parseOperation, parseOperationName, veoBody, type RefImage } from './videoApis';

const REF_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const MAX_REF_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export interface VideoDeps extends Omit<GenerationDeps, 'timeoutMs'> {
  pollMs?: number;
  /** Give up waiting after this long (the provider may still finish and bill). */
  maxWaitMs?: number;
  onChange?: (r: VideoJobRecord) => void;
}

async function httpFailure(res: Response): Promise<Error> {
  let detail = '';
  try { const j = (await res.json()) as { error?: { message?: string } }; detail = j.error?.message ?? ''; } catch { /* not JSON */ }
  const why = res.status === 401 || res.status === 403 ? 'the key was rejected or has no video access'
    : res.status === 429 ? 'rate limit or quota reached'
    : res.status === 400 ? 'the request was refused'
    : `HTTP ${res.status}`;
  return new Error(redact(`Google Veo: ${why}${detail ? ` — ${detail.slice(0, 300)}` : ''}`, null));
}

export class VideoService {
  private tracking = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: VideoDeps) {}

  private async file(store: ProjectStore) { return path.join(await store.workDir('video'), 'jobs.json'); }

  private async read(store: ProjectStore): Promise<VideoJobRecord[]> {
    try {
      const j = JSON.parse(await fs.readFile(await this.file(store), 'utf8')) as { jobs?: VideoJobRecord[] };
      return Array.isArray(j.jobs) ? j.jobs : [];
    } catch { return []; }
  }

  private update(store: ProjectStore, id: string, patch: Partial<VideoJobRecord> | VideoJobRecord): Promise<VideoJobRecord | null> {
    const run = async () => {
      const jobs = await this.read(store);
      const i = jobs.findIndex((x) => x.id === id);
      const next = i < 0 ? ('job' in patch ? (patch as VideoJobRecord) : null) : { ...jobs[i]!, ...patch, updatedAt: new Date().toISOString() };
      if (!next) return null;
      if (i < 0) jobs.push(next); else jobs[i] = next;
      const f = await this.file(store);
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ version: 1, jobs: jobs.slice(-100) }, null, 2), 'utf8');
      await fs.rename(tmp, f);
      this.d.onChange?.(next);
      return next;
    };
    const p = this.writes.then(run, run);
    this.writes = p.catch(() => undefined);
    return p;
  }

  /** Saved jobs of the open project; also picks up any job that was still running. */
  async list(): Promise<VideoJobRecord[]> {
    const store = await this.d.store();
    const jobs = await this.read(store);
    for (const j of jobs) if (ACTIVE_VIDEO_STATES.includes(j.state) && j.operation) void this.track(store, j.id);
    return jobs.slice().reverse();
  }

  async submit(raw: VideoJob, requestedBy: 'user' | 'claude'): Promise<VideoJobRecord> {
    const job = normalizeVideoJob(raw);
    const model = videoModelById(job.modelId)!;
    if (!(await this.d.vault.status(model.provider)).configured) throw new Error('Add your Gemini API key first (AI Generate → Providers). Veo uses the same key.');
    const store = await this.d.store();
    const manifest = await store.loadManifest();
    let ref: RefImage | null = null;
    let refName: string | null = null;
    if (job.referenceAssetId) {
      const a = manifest.assets.find((x) => x.id === job.referenceAssetId);
      if (!a) throw new Error('The starting picture is no longer in the library.');
      const mime = REF_MIME[a.sourceFormat];
      if (!mime) throw new Error(`${a.name}: only PNG, JPEG or WebP pictures can start a video.`);
      const data = await fs.readFile(await store.resolveAssetPath(a.id));
      if (data.length > MAX_REF_BYTES) throw new Error(`${a.name} is too large to send (max 8 MB).`);
      ref = { mime, data };
      refName = a.name;
    }
    const estimate = estimateVideoCost(job);
    const spend = await store.spending();
    const inFlight = (await this.read(store)).filter((j) => ACTIVE_VIDEO_STATES.includes(j.state)).reduce((n, j) => n + j.estimateUsd, 0);
    if (spend.limitUsd !== null && spend.spentUsd + inFlight + estimate.amount > spend.limitUsd) {
      throw new Error(`This would go over the project's spending limit of $${spend.limitUsd.toFixed(2)}: about $${(spend.spentUsd + inFlight).toFixed(2)} is already estimated as spent or running and this video is about $${estimate.amount.toFixed(2)}. Nothing was sent. Raise the limit in AI Generate to continue.`);
    }
    const ok = await this.d.approve({
      kind: 'video', provider: 'Google', model: model.label, prompt: job.prompt, count: 1,
      settings: { aspect: job.aspectRatio, length: `${job.durationSeconds} s`, resolution: job.resolution },
      references: refName ? [refName] : [], estimate, requestedBy, limitUsd: spend.limitUsd, spentUsd: spend.spentUsd + inFlight,
    });
    if (ok !== true) throw new GenerationCancelled();

    const now = new Date().toISOString();
    const operation = await this.d.vault.withKey(model.provider, async (key) => {
      const res = await this.d.fetch(`${GEMINI_BASE}/models/${model.id}:predictLongRunning`, {
        method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(veoBody(job, ref)), signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw await httpFailure(res);
      return parseOperationName(await res.json());
    });
    const rec: VideoJobRecord = {
      id: randomUUID(), provider: model.provider, job, state: 'running', operation, estimateUsd: estimate.amount, requestedBy,
      createdAt: now, updatedAt: now, assetId: null, message: 'Google is making the video. This usually takes a few minutes.',
    };
    await this.update(store, rec.id, rec);
    void this.track(store, rec.id);
    return rec;
  }

  /** Veo has no documented cancel: this stops waiting; the provider may still finish and bill. */
  async cancel(id: string): Promise<VideoJobRecord> {
    const store = await this.d.store();
    const cur = (await this.read(store)).find((j) => j.id === id);
    if (!cur) throw new Error('That video job was not found.');
    if (!ACTIVE_VIDEO_STATES.includes(cur.state)) return cur;
    const next = await this.update(store, id, {
      state: 'cancelled',
      message: 'Stopped waiting. Google does not offer a way to cancel a running video, so it may still finish and be billed to your account; CreateCraft will not import it.',
    });
    return next!;
  }

  private async track(store: ProjectStore, id: string): Promise<void> {
    const k = `${store.root}|${id}`;
    if (this.tracking.has(k)) return;
    this.tracking.add(k);
    const pollMs = this.d.pollMs ?? 10_000;
    const maxWait = this.d.maxWaitMs ?? 30 * 60_000;
    let errors = 0;
    try {
      for (;;) {
        const rec = (await this.read(store)).find((j) => j.id === id);
        if (!rec || !ACTIVE_VIDEO_STATES.includes(rec.state) || !rec.operation) return;
        if (Date.now() - Date.parse(rec.createdAt) > maxWait) {
          await this.update(store, id, { state: 'failed', message: 'Stopped waiting after 30 minutes. Google may still finish it; check your Google account billing.' });
          return;
        }
        try {
          const done = await this.d.vault.withKey(rec.provider, async (key) => {
            const res = await this.d.fetch(`${GEMINI_BASE}/${rec.operation}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(60_000) });
            if (!res.ok) throw await httpFailure(res);
            return parseOperation(await res.json());
          });
          errors = 0;
          if (done.done && 'error' in done) { await this.update(store, id, { state: 'failed', message: done.error }); return; }
          if (done.done) { await this.finish(store, rec, done.uri); return; }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/rejected|refused/.test(msg) || ++errors >= 5) { await this.update(store, id, { state: 'failed', message: msg }); return; }
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } finally {
      this.tracking.delete(k);
    }
  }

  private async finish(store: ProjectStore, rec: VideoJobRecord, uri: string): Promise<void> {
    const now = (await this.read(store)).find((j) => j.id === rec.id);
    if (!now || !ACTIVE_VIDEO_STATES.includes(now.state)) return; // stopped while the last poll was in flight
    await this.update(store, rec.id, { state: 'downloading', message: 'Downloading the finished video…' });
    try {
      const bytes = await this.d.vault.withKey(rec.provider, async (key) => {
        const res = await this.d.fetch(uri, { headers: { 'x-goog-api-key': key }, redirect: 'follow', signal: AbortSignal.timeout(600_000) });
        if (!res.ok) throw await httpFailure(res);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_VIDEO_BYTES) throw new Error('The video file is larger than 500 MB; not imported.');
        if (buf.length < 1000) throw new Error('The downloaded video file was empty.');
        return buf;
      });
      const dir = await store.workDir('generate');
      const stamp = rec.createdAt.replace(/[:.]/g, '-').slice(0, 19);
      const slug = rec.job.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
      const name = `${slug}-${stamp}.mp4`;
      const file = path.join(dir, name);
      await fs.writeFile(file, bytes);
      const model = videoModelById(rec.job.modelId)!;
      const r = await store.addGeneratedFile(file, {
        name,
        provenance: {
          source: `Generated with Google · ${model.label} (${model.id})`,
          prompt: rec.job.prompt, provider: rec.provider, model: model.id,
          settings: { aspect: rec.job.aspectRatio, length: `${rec.job.durationSeconds} s`, resolution: rec.job.resolution },
          estimatedCostUsd: rec.estimateUsd, requestedBy: rec.requestedBy,
          ...(rec.job.referenceAssetId ? { referenceAssetIds: [rec.job.referenceAssetId] } : {}),
          licensingNotes: "AI-generated via Google Veo. Check Google's terms for usage rights. Carries Google's SynthID watermark.",
        },
      });
      await store.recordSpend({ at: new Date().toISOString(), provider: rec.provider, model: model.id, images: 0, estimateUsd: rec.estimateUsd, requestedBy: rec.requestedBy });
      await this.update(store, rec.id, {
        state: 'done', assetId: r.asset.id,
        message: `Video ready (estimated $${rec.estimateUsd.toFixed(2)})${r.duplicateOf ? '; an identical file was already in the library' : ' and added to the library'}.`,
      });
    } catch (e) {
      await this.update(store, rec.id, { state: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }
}

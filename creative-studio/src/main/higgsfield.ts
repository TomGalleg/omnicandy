// Higgsfield official API (async). Same rules as the other providers: the key is lent by the vault per call, a native approval
// comes first, the project's spending limit is respected, finished files become new originals with provenance, and a paid
// submit is never sent twice. Higgsfield jobs take minutes, so a job is saved with the project and its request id is polled
// (polling is free), including after a restart. Higgsfield documents no price list or estimate call, so the price is shown as
// unknown and a project with a spending limit refuses the request rather than pretending the limit can be checked.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HF_ACTIVE, HF_PRICE_UNKNOWN, HIGGSFIELD_BASE, hfModel, higgsfieldBody, isHiggsfieldApiUrl, normalizeHiggsfieldJob, parseHfStatus, parseHfStyles,
  type HfInputKind, type HfJobRecord, type HfStatus, type HfStyle, type HiggsfieldJob,
} from '@shared/higgsfield';
import { redact } from './credentialVault';
import { GenerationCancelled, type GenerationDeps } from './generation';
import type { ProjectStore } from './projectStore';

export interface HiggsfieldDeps extends Omit<GenerationDeps, 'timeoutMs'> {
  pollMs?: number;
  /** Give up waiting after this long (the provider may still finish and bill). */
  maxWaitMs?: number;
  onChange?: (r: HfJobRecord) => void;
}

/** What the upload endpoint accepts (file-uploads page): JPEG, PNG, WebP, GIF, WAV and MP4. */
const FORMATS: Record<string, { mime: string; kind: HfInputKind }> = {
  png: { mime: 'image/png', kind: 'image' }, jpg: { mime: 'image/jpeg', kind: 'image' }, jpeg: { mime: 'image/jpeg', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' }, gif: { mime: 'image/gif', kind: 'image' },
  wav: { mime: 'audio/wav', kind: 'audio' }, mp4: { mime: 'video/mp4', kind: 'video' },
};
// OmniCandy's own caps (the docs state none): keeps one request from reading a huge file into memory.
const MAX_BYTES: Record<HfInputKind, number> = { image: 25 * 1024 * 1024, audio: 50 * 1024 * 1024, video: 300 * 1024 * 1024 };
const MAX_OUTPUT_BYTES = 800 * 1024 * 1024;

async function failure(res: Response): Promise<Error> {
  let detail = '';
  try {
    const j = (await res.json()) as { detail?: unknown; message?: unknown; error?: { message?: string } | string };
    const d = typeof j.detail === 'string' ? j.detail : typeof j.message === 'string' ? j.message : typeof j.error === 'string' ? j.error : j.error?.message ?? '';
    detail = d;
  } catch { /* not JSON */ }
  const why = res.status === 401 || res.status === 403 ? 'the key was rejected'
    : res.status === 429 ? 'rate limit reached'
    : res.status === 400 || res.status === 422 ? 'the request was refused'
    : `HTTP ${res.status}`;
  return new Error(redact(`Higgsfield: ${why}${detail ? ` — ${detail.slice(0, 400)}` : ''}`, null));
}

/** Pictures, MP4 and WAV by their first bytes, so a mislabelled download is not saved as media. */
export function sniffMedia(b: Buffer): 'png' | 'jpg' | 'webp' | 'gif' | 'mp4' | 'mov' | 'wav' | null {
  if (b.length < 12) return null;
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return b.subarray(8, 12).toString('latin1') === 'qt  ' ? 'mov' : 'mp4';
  return null;
}

export class HiggsfieldService {
  private tracking = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: HiggsfieldDeps) {}

  private async file(store: ProjectStore) { return path.join(await store.workDir('higgsfield'), 'jobs.json'); }

  /** Reads wait their turn behind any write: on Windows a rename fails while a reader holds the file, even our own. */
  private read(store: ProjectStore): Promise<HfJobRecord[]> {
    const p = this.writes.then(() => this.readRaw(store), () => this.readRaw(store));
    this.writes = p.then(() => undefined, () => undefined);
    return p;
  }

  private async readRaw(store: ProjectStore): Promise<HfJobRecord[]> {
    try {
      const j = JSON.parse(await fs.readFile(await this.file(store), 'utf8')) as { jobs?: HfJobRecord[] };
      return Array.isArray(j.jobs) ? j.jobs : [];
    } catch { return []; }
  }

  private update(store: ProjectStore, id: string, patch: Partial<HfJobRecord> | HfJobRecord): Promise<HfJobRecord | null> {
    const run = async () => {
      const jobs = await this.readRaw(store);
      const i = jobs.findIndex((x) => x.id === id);
      const next = i < 0 ? ('job' in patch ? (patch as HfJobRecord) : null) : { ...jobs[i]!, ...patch, updatedAt: new Date().toISOString() };
      if (!next) return null;
      if (i < 0) jobs.push(next); else jobs[i] = next;
      const f = await this.file(store);
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ version: 1, jobs: jobs.slice(-100) }, null, 2), 'utf8');
      for (let attempt = 0; ; attempt++) { // Windows may briefly lock the target (scanner, reader)
        try { await fs.rename(tmp, f); break; } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
          await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
        }
      }
      this.d.onChange?.(next);
      return next;
    };
    const p = this.writes.then(run, run);
    this.writes = p.catch(() => undefined);
    return p;
  }

  /** Saved jobs of the open project, newest first. A running one is picked up again; one that never got a request id is failed (it is never re-sent). */
  async list(): Promise<HfJobRecord[]> {
    const store = await this.d.store();
    const jobs = await this.read(store);
    for (const j of jobs) {
      if (!HF_ACTIVE.includes(j.state)) continue;
      if (j.requestId) void this.track(store, j.id);
      else await this.update(store, j.id, { state: 'failed', message: "OmniCandy closed while this request was being sent, so it is unknown whether Higgsfield received it. It was not sent again. Check your Higgsfield console before trying once more." });
    }
    return (await this.read(store)).slice().reverse();
  }

  private async api(key: string, url: string, init: RequestInit = {}): Promise<Response> {
    if (!isHiggsfieldApiUrl(url)) throw new Error('Refusing to send the Higgsfield key to an address that is not api.higgsfield.ai.');
    return this.d.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Key ${key}` }, signal: init.signal ?? AbortSignal.timeout(60_000) });
  }

  private async upload(key: string, mime: string, data: Buffer): Promise<string> {
    const res = await this.api(key, `${HIGGSFIELD_BASE}/files/generate-upload-url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content_type: mime }) });
    if (!res.ok) throw await failure(res);
    const j = (await res.json()) as { public_url?: unknown; upload_url?: unknown; upload_headers?: Record<string, unknown> };
    if (typeof j.public_url !== 'string' || typeof j.upload_url !== 'string' || !/^https:\/\//.test(j.upload_url) || !/^https:\/\//.test(j.public_url)) throw new Error('Higgsfield sent an upload address that is not usable.');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(j.upload_headers ?? {})) if (typeof v === 'string') headers[k] = v;
    // The storage address is not Higgsfield's API: the Higgsfield key is deliberately NOT sent there.
    const put = await this.d.fetch(j.upload_url, { method: 'PUT', headers, body: new Uint8Array(data), signal: AbortSignal.timeout(600_000) });
    if (!put.ok) throw new Error(`Higgsfield: uploading a file failed (HTTP ${put.status}).`);
    return j.public_url;
  }

  async submit(raw: HiggsfieldJob, requestedBy: 'user' | 'claude'): Promise<HfJobRecord> {
    const job = normalizeHiggsfieldJob(raw);
    const model = hfModel(job.modelId)!;
    const st = await this.d.vault.status('higgsfield');
    if (st.unreadable) throw new Error("The saved Higgsfield key can't be read on this PC. Add it again (Settings → Integrations).");
    if (!st.configured) throw new Error('Add your Higgsfield API key first (Settings → Integrations).');

    const store = await this.d.store();
    const manifest = await store.loadManifest();
    const files: Array<{ key: string; name: string; mime: string; data: Buffer }> = [];
    for (const spec of model.inputs) {
      for (const id of job.inputs[spec.key] ?? []) {
        const a = manifest.assets.find((x) => x.id === id);
        if (!a) throw new Error(`${spec.label}: a chosen file is no longer in the library.`);
        const f = FORMATS[a.sourceFormat.toLowerCase()];
        if (!f || f.kind !== spec.kind) throw new Error(`${a.name}: ${spec.label} needs ${spec.kind === 'image' ? 'a PNG, JPEG, WebP or GIF picture' : spec.kind === 'video' ? 'an MP4 video' : 'a WAV sound'}.`);
        const data = await fs.readFile(await store.resolveAssetPath(a.id));
        if (data.length > MAX_BYTES[spec.kind]) throw new Error(`${a.name} is too large to send (max ${MAX_BYTES[spec.kind] / 1024 / 1024} MB).`);
        files.push({ key: spec.key, name: a.name, mime: f.mime, data });
      }
    }

    const spend = await store.spending();
    if (spend.limitUsd !== null) {
      throw new Error(`This project has a spending limit of $${spend.limitUsd.toFixed(2)}, but Higgsfield publishes no price for ${model.label}, so the limit cannot be checked. Nothing was sent. Remove the limit in AI Generate to use Higgsfield.`);
    }
    const settings: Record<string, string> = {};
    for (const [k, v] of Object.entries(job.params)) settings[k] = String(v);
    const ok = await this.d.approve({
      kind: model.output === 'video' ? 'video' : 'image', provider: 'Higgsfield', model: model.label, prompt: job.prompt || '(no prompt)', count: 1, settings,
      references: files.map((f) => f.name), estimate: { amount: 0, perImage: 0, currency: 'USD', approximate: true, basis: HF_PRICE_UNKNOWN },
      requestedBy, limitUsd: null, spentUsd: spend.spentUsd, priceUnknown: HF_PRICE_UNKNOWN,
      footnote: 'Nothing is sent until you click the button. Higgsfield can only cancel a request while it is still queued; once it starts it finishes and is charged.',
    });
    if (ok !== true) throw new GenerationCancelled();

    const now = new Date().toISOString();
    const rec: HfJobRecord = { id: randomUUID(), job, state: 'submitting', requestId: '', requestedBy, createdAt: now, updatedAt: now, assetIds: [], message: 'Sending to Higgsfield…' };
    await this.update(store, rec.id, rec);
    try {
      const st1 = await this.d.vault.withKey('higgsfield', async (key) => {
        const urls: Record<string, string[]> = {};
        for (const f of files) (urls[f.key] ??= []).push(await this.upload(key, f.mime, f.data));
        const res = await this.api(key, `${HIGGSFIELD_BASE}/${model.id}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': rec.id }, body: JSON.stringify(higgsfieldBody(job, urls)), signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) throw await failure(res);
        return parseHfStatus(await res.json());
      });
      if (!st1.requestId) throw new Error('Higgsfield accepted the request but sent no request id.');
      const safe = (u: string) => (isHiggsfieldApiUrl(u) ? u : undefined);
      const next = await this.update(store, rec.id, {
        requestId: st1.requestId, state: 'queued', message: 'Waiting in the Higgsfield queue…',
        ...(safe(st1.statusUrl) ? { statusUrl: st1.statusUrl } : {}), ...(safe(st1.cancelUrl) ? { cancelUrl: st1.cancelUrl } : {}),
      });
      void this.track(store, rec.id);
      return next!;
    } catch (e) {
      // Not sent twice: a failed submit is recorded and stays failed until the user starts a new one.
      const msg = e instanceof Error ? e.message : String(e);
      await this.update(store, rec.id, { state: 'failed', message: `${msg} Nothing was retried.` });
      throw e;
    }
  }

  private styleCache = new Map<string, { at: number; list: HfStyle[] }>();

  /** The styles a Soul model accepts. A free read with the key; small preview pictures are fetched here (no key sent to them) and returned inline. */
  async styles(modelId: string): Promise<HfStyle[]> {
    const m = hfModel(modelId);
    if (!m?.stylesPath) return [];
    const hit = this.styleCache.get(modelId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
    const st = await this.d.vault.status('higgsfield');
    if (!st.configured) throw new Error('Add your Higgsfield API key first (Settings → Integrations).');
    const raw = await this.d.vault.withKey('higgsfield', async (key) => {
      const res = await this.api(key, `${HIGGSFIELD_BASE}${m.stylesPath}`);
      if (!res.ok) throw await failure(res);
      return parseHfStyles(await res.json());
    });
    const list: HfStyle[] = raw.slice(0, 60).map((s) => ({ id: s.id, name: s.name, description: s.description, preview: null }));
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < raw.length && i < list.length; i = next++) {
        const url = raw[i]!.previewUrl;
        if (!/^https:\/\//.test(url)) continue;
        try {
          const res = await this.d.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          const kind = buf.length <= 250 * 1024 ? sniffMedia(buf) : null;
          if (kind === 'png' || kind === 'jpg' || kind === 'webp' || kind === 'gif') list[i]!.preview = `data:image/${kind === 'jpg' ? 'jpeg' : kind};base64,${buf.toString('base64')}`;
        } catch { /* a missing preview just means the style shows its name only */ }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    this.styleCache.set(modelId, { at: Date.now(), list });
    return list;
  }

  /** Only a request that is still queued can be cancelled (a refund follows). Once it runs it cannot be stopped. */
  async cancel(id: string): Promise<HfJobRecord> {
    const store = await this.d.store();
    const cur = (await this.read(store)).find((j) => j.id === id);
    if (!cur) throw new Error('That Higgsfield job was not found.');
    if (!HF_ACTIVE.includes(cur.state)) return cur;
    if (cur.state !== 'queued' || !cur.requestId) {
      return (await this.update(store, id, { message: 'Higgsfield cannot stop a request once it has started. It will finish and be charged; OmniCandy keeps waiting and will save the result.' }))!;
    }
    const url = cur.cancelUrl ?? `${HIGGSFIELD_BASE}/requests/${encodeURIComponent(cur.requestId)}/cancel`;
    try {
      const res = await this.d.vault.withKey('higgsfield', (key) => this.api(key, url, { method: 'POST' }));
      if (res.status === 400) return (await this.update(store, id, { state: 'running', message: 'Too late to cancel: Higgsfield had already started it. It will finish and be charged; OmniCandy will save the result.' }))!;
      if (!res.ok) throw await failure(res);
      return (await this.update(store, id, { state: 'canceled', message: 'Cancelled while queued. Higgsfield refunds a cancelled queued request.' }))!;
    } catch (e) {
      return (await this.update(store, id, { message: `Could not confirm the cancel (${e instanceof Error ? e.message : String(e)}). The request may still run and be charged.` }))!;
    }
  }

  private async track(store: ProjectStore, id: string): Promise<void> {
    const k = `${store.root}|${id}`;
    if (this.tracking.has(k)) return;
    this.tracking.add(k);
    const pollMs = this.d.pollMs ?? 5_000;
    const maxWait = this.d.maxWaitMs ?? 45 * 60_000;
    let errors = 0;
    try {
      for (;;) {
        const rec = (await this.read(store)).find((j) => j.id === id);
        if (!rec || !HF_ACTIVE.includes(rec.state) || !rec.requestId) return;
        if (Date.now() - Date.parse(rec.createdAt) > maxWait) {
          await this.update(store, id, { state: 'failed', message: 'Stopped waiting after 45 minutes. Higgsfield may still finish it and charge your balance; check console.higgsfield.ai.' });
          return;
        }
        try {
          const url = rec.statusUrl ?? `${HIGGSFIELD_BASE}/requests/${encodeURIComponent(rec.requestId)}/status`;
          const s = await this.d.vault.withKey('higgsfield', async (key) => {
            const res = await this.api(key, url);
            if (!res.ok) throw await failure(res);
            return parseHfStatus(await res.json());
          });
          errors = 0;
          if (await this.apply(store, rec, s)) return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Polling is free, so a flaky connection is tolerated; a rejected key or a refused request is not.
          if (/rejected|refused/.test(msg) || ++errors >= 8) { await this.update(store, id, { state: 'failed', message: `${msg} The request may still finish at Higgsfield; check console.higgsfield.ai.` }); return; }
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } finally {
      this.tracking.delete(k);
    }
  }

  /** Returns true when the job reached an end state. */
  private async apply(store: ProjectStore, rec: HfJobRecord, s: HfStatus): Promise<boolean> {
    switch (s.status) {
      case 'queued': if (rec.state !== 'queued') await this.update(store, rec.id, { state: 'queued', message: 'Waiting in the Higgsfield queue…' }); return false;
      case 'in_progress': if (rec.state !== 'running') await this.update(store, rec.id, { state: 'running', message: 'Higgsfield is making it. This can take a few minutes.' }); return false;
      case 'failed': await this.update(store, rec.id, { state: 'failed', message: `Higgsfield could not make it${s.error ? `: ${s.error}` : '.'} Failed requests are not charged.` }); return true;
      case 'nsfw': await this.update(store, rec.id, { state: 'moderated', message: "Higgsfield's content check rejected the input or the result. Moderated requests are not charged." }); return true;
      case 'canceled': await this.update(store, rec.id, { state: 'canceled', message: 'Cancelled before it started. Higgsfield refunds it.' }); return true;
      case 'completed': await this.finish(store, rec, s); return true;
    }
  }

  /** Result links expire (seven days by default), so the files are downloaded straight away and saved as new originals. */
  private async finish(store: ProjectStore, rec: HfJobRecord, s: HfStatus): Promise<void> {
    const now = (await this.read(store)).find((j) => j.id === rec.id);
    if (!now || !HF_ACTIVE.includes(now.state)) return;
    await this.update(store, rec.id, { state: 'downloading', message: 'Downloading the finished result…' });
    try {
      if (!s.outputs.length) throw new Error('Higgsfield reported it finished but sent no file.');
      const model = hfModel(rec.job.modelId)!;
      const dir = await store.workDir('generate');
      const stamp = rec.createdAt.replace(/[:.]/g, '-').slice(0, 19);
      const slug = (rec.job.prompt || model.family).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'higgsfield';
      const refs = Object.values(rec.job.inputs).flat();
      const settings: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec.job.params)) settings[k] = String(v);
      const assetIds: string[] = [];
      let duplicates = 0;
      for (const [i, out] of s.outputs.entries()) {
        if (!/^https:\/\//.test(out.url)) throw new Error('Higgsfield sent a result address that is not https.');
        // Higgsfield result links are signed links on other hosts: no credentials go with them.
        const res = await this.d.fetch(out.url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
        if (!res.ok) throw new Error(`Higgsfield: downloading the result failed (HTTP ${res.status}).`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_OUTPUT_BYTES) throw new Error('The result file is larger than 800 MB; not imported.');
        const ext = sniffMedia(buf);
        if (!ext || (out.kind === 'video' && ext !== 'mp4' && ext !== 'mov') || (out.kind === 'image' && !['png', 'jpg', 'webp', 'gif'].includes(ext)) || (out.kind === 'audio' && ext !== 'wav')) {
          throw new Error(`The downloaded ${out.kind} was not a valid ${out.kind} file.`);
        }
        const name = `${slug}-${stamp}${s.outputs.length > 1 ? `-${i + 1}` : ''}.${ext}`;
        const file = path.join(dir, name);
        await fs.writeFile(file, buf);
        const r = await store.addGeneratedFile(file, {
          name,
          provenance: {
            source: `Generated with Higgsfield · ${model.label} (${model.id})`,
            prompt: rec.job.prompt, provider: 'higgsfield', model: model.id, settings, requestedBy: rec.requestedBy,
            ...(refs.length ? { referenceAssetIds: refs } : {}),
            licensingNotes: "AI-generated via Higgsfield. Check Higgsfield's and the underlying model's terms for usage rights.",
          },
        });
        if (r.duplicateOf) duplicates++; else assetIds.push(r.asset.id);
      }
      // No price is known, so no dollar amount is recorded; the count still shows in the spending record.
      await store.recordSpend({ at: new Date().toISOString(), provider: 'higgsfield', model: model.id, images: model.output === 'image' ? s.outputs.length : 0, estimateUsd: 0, requestedBy: rec.requestedBy });
      await this.update(store, rec.id, {
        state: 'done', assetIds,
        message: `Ready: ${assetIds.length} new file${assetIds.length === 1 ? '' : 's'} added to the library${duplicates ? ` (${duplicates} identical already there)` : ''}. Check your Higgsfield balance for the cost.`,
      });
    } catch (e) {
      await this.update(store, rec.id, { state: 'failed', message: `${e instanceof Error ? e.message : String(e)} The request itself may have been charged; check console.higgsfield.ai.` });
    }
  }
}

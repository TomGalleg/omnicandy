// Pictures of an application (Blender's viewport) through the real agent loop and external tools: only for models that can see,
// rationed, size-checked, temporary, never an edit, and never proof. Blender itself is faked; the live test proves the real picture.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, ExternalAppInfo } from '@shared/integrations';
import { BLENDER_MANIFEST } from '../integrations/adapters/blender';
import { VIEW_ONLY_COMMANDS, isTrustedReadbackCommand, isViewOnlyCommand } from '../integrations/readback';
import { MAX_PREVIEWS_PER_TASK, MAX_PREVIEW_BYTES, addExternalTools } from './externalTools';
import { runAgent } from './loop';
import { ScriptedProvider } from './providers/scripted';
import { ToolRegistry } from './registry';
import type { Message, ModelProvider, ProviderReply } from './types';
import type { LiveTaskController } from '../liveTask';

const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const texts = (m: Message[]) => m.filter((x) => x.role === 'tool').map((x) => x.content);
const PNG_SIG = Buffer.from('89504e470d0a1a0a', 'hex');
const png = (extra = 64) => Buffer.concat([PNG_SIG, Buffer.alloc(extra, 7)]);

const app = { key: 'blender-1', name: 'Blender', status: 'connected', adapterId: 'blender', adapterName: 'Blender', commands: BLENDER_MANIFEST.commands } as unknown as ExternalAppInfo;
const view = (id: string, params: Record<string, unknown> = {}) => call(id, 'external_command', { app_key: 'blender-1', command: 'scene.viewport', params });
const build = (id: string) => call(id, 'external_command', { app_key: 'blender-1', command: 'scene.build', params: { file_name: 'a.blend', spec: { batch_id: 'b1', objects: [{ id: 'a', kind: 'box' }] } } });

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });

async function rig(opts: { bytes?: Buffer; width?: number; height?: number } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-view-'));
  roots.push(dir);
  const files: string[] = [];
  const executed: string[] = [];
  const backend = {
    list: async () => [app], isBuiltin: (id: string) => id === 'blender',
    execute: async (_k: string, command: string, params: Record<string, unknown>): Promise<CommandResult> => {
      executed.push(command);
      if (command !== 'scene.viewport') return { ok: true, verified: true, message: 'ok', evidence: [], outputs: [], durationMs: 1, data: {} };
      const file = path.join(dir, `view-${files.length}.png`);
      await fs.writeFile(file, opts.bytes ?? png());
      files.push(file);
      return { ok: true, verified: false, message: 'Picture of the Blender window', evidence: [], outputs: [], durationMs: 1,
        data: { image: { path: file, width: opts.width ?? 800, height: opts.height ?? 600, bytes: 64 }, view: params.view ?? 'iso', source: 'open-window', proof: false } };
    },
  } as unknown as Parameters<typeof addExternalTools>[1];
  return { backend, files, executed };
}
/** A provider that records every request it receives. */
function spy(script: ProviderReply[], vision = true) {
  const inner = new ScriptedProvider(script);
  const seen: Message[][] = [];
  const p: ModelProvider = { id: 'spy', supportsVision: vision, complete: async (i) => { seen.push(structuredClone(i.messages)); return inner.complete(i); } };
  return { p, seen };
}
const run = (b: Awaited<ReturnType<typeof rig>>, provider: ModelProvider, vision: boolean) =>
  runAgent({ goal: 'look at the castle', ctl: idle(), registry: addExternalTools(new ToolRegistry(), b.backend, { supportsVision: vision }), provider });

describe('classification of picture commands', () => {
  it('scene.viewport is a built-in view-only inspection: not an edit, not read-back evidence', () => {
    const spec = BLENDER_MANIFEST.commands.find((c) => c.id === 'scene.viewport')!;
    expect(spec).toMatchObject({ preview: true, idempotent: true });
    expect(isViewOnlyCommand(() => true, 'blender', spec)).toBe(true);
    expect(isTrustedReadbackCommand(() => true, 'blender', spec)).toBe(false); // never stored for evidence_verify or recovery
    expect(isViewOnlyCommand(() => false, 'blender', spec)).toBe(false); // an installed adapter cannot claim it
    expect(isViewOnlyCommand(() => true, 'blender', { ...spec, permissions: [...spec.permissions, 'write-files'] })).toBe(false);
    expect(isViewOnlyCommand(() => true, 'blender', { ...spec, preview: false })).toBe(false);
    expect(Object.values(VIEW_ONLY_COMMANDS).flat()).toEqual(['scene.viewport']);
    expect(BLENDER_MANIFEST.commands.filter((c) => c.preview).map((c) => c.id)).toEqual(['scene.viewport']);
  });
});

describe('a picture of Blender for a vision-capable model', () => {
  it('reaches the provider as an image, is deleted from disk afterwards, and is labelled as not proof', async () => {
    const b = await rig();
    const { p, seen } = spy([view('1', { view: 'top', focus: 'tower-a' }), final]);
    const r = await run(b, p, true);
    const last = seen.at(-1)!;
    const imageMsg = last.find((m) => m.role === 'user' && m.imageDataUrl);
    expect((imageMsg as { imageDataUrl?: string } | undefined)?.imageDataUrl).toBe(`data:image/png;base64,${png().toString('base64')}`);
    expect(texts(r.messages)[0]).toContain('NOT proof of saved state');
    expect(texts(r.messages)[0]).not.toContain(b.files[0]!); // the temporary path is not shown to the model
    await expect(fs.stat(b.files[0]!)).rejects.toThrow(); // temporary: gone
    expect(JSON.parse(texts(r.messages)[0]!.split('\n')[0]!).data.image).toEqual({ width: 800, height: 600, bytes: png().length });
  });

  it('is not an edit (no journal, no lock) and never counts as verification of a change', async () => {
    const b = await rig();
    const began: string[] = [];
    const { p } = spy([build('1'), view('2'), final, final]);
    const r = await runAgent({ goal: 'x', ctl: idle(), registry: addExternalTools(new ToolRegistry(), b.backend, { supportsVision: true }), provider: p, onEditBegin: async (_t, c) => { began.push(c); } });
    expect(began).toEqual(['scene.build']); // only the build was journalled
    expect(r.status).toBe('limit'); // a picture after an edit is not the structured, fresh read-back completion requires
    expect(r.uncertainEdit).toBeUndefined();
  });

  it('is refused, without touching Blender, for a model that cannot see images', async () => {
    const b = await rig();
    const { p } = spy([view('1'), final], false);
    const r = await run(b, p, false);
    expect(b.executed).toEqual([]);
    expect(texts(r.messages)[0]).toMatch(/cannot see images.*scene\.inspect_detail/);
  });

  it('is rationed: not more often than every few seconds, and at most a few per task', async () => {
    const b = await rig();
    const quick = spy([view('1'), view('2'), final]);
    const r1 = await run(b, quick.p, true);
    expect(texts(r1.messages)[1]).toMatch(/one every few seconds/);
    expect(b.executed).toEqual(['scene.viewport']);

    const b2 = await rig();
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 3000));
    const many = spy([...Array.from({ length: MAX_PREVIEWS_PER_TASK + 1 }, (_, i) => view(String(i + 1))), final]);
    const r2 = await run(b2, many.p, true);
    expect(b2.executed.length).toBe(MAX_PREVIEWS_PER_TASK);
    expect(texts(r2.messages).at(-1)).toMatch(/Picture limit reached/);
  });

  it('is checked before it is sent: real PNG, size and dimension limits', async () => {
    const cases: Array<[string, Parameters<typeof rig>[0]]> = [
      ['not a png', { bytes: Buffer.from('GIF89a-not-a-png-file') }],
      ['too large', { bytes: png(MAX_PREVIEW_BYTES) }],
      ['too wide', { width: 4000, height: 3000 }],
      ['empty', { bytes: Buffer.alloc(0) }],
    ];
    for (const [name, o] of cases) {
      const b = await rig(o);
      const { p, seen } = spy([view('1'), final]);
      const r = await run(b, p, true);
      expect(texts(r.messages)[0], name).toMatch(/no usable picture/);
      expect(seen.flat().some((m) => 'imageDataUrl' in m && !!m.imageDataUrl), name).toBe(false);
      await expect(fs.stat(b.files[0]!), name).rejects.toThrow(); // even a rejected picture is not left behind
    }
  });
});

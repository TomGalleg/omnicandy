import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compareEvidence, parseEvidencePath, resolveEvidencePath, summarizeObserved } from './evidencePath';
import { runAgent } from './loop';
import { ToolRegistry, tool } from './registry';
import { ScriptedProvider } from './providers/scripted';
import type { LiveTaskController } from '../liveTask';
import type { ProviderReply } from './types';

// Shape of the real Blender `scene.inspect` data (see blenderScene.ts _details): objects are an ARRAY of {name, location, ..., materials:[{name,color:[r,g,b,a]}]}.
const data = {
  count: 3, blender: '4.0.2',
  details: [
    { name: 'Cube', type: 'MESH', location: [0, 0, 0], rotation_deg: [0, 0, 0], scale: [1, 1, 1], materials: [{ name: 'M1', color: [0.8, 0.8, 0.8, 1] }] },
    { name: 'Ball.001', type: 'MESH', location: [3, 0, 0], rotation_deg: [0, 0, 45], scale: [1.5, 1.5, 1.5], materials: [{ name: 'Red', color: [1, 0, 0, 1] }] },
    { name: 'Cone', type: 'MESH', location: [-3, 0, 0], rotation_deg: [0, 0, 0], scale: [1, 1, 1], materials: [{ name: 'Green', color: [0, 1, 0, 1] }] },
  ],
  scene: { engine: 'BLENDER_WORKBENCH' },
};
const get = (path: string) => { const t = parseEvidencePath(path); return t ? resolveEvidencePath({ data }, t) : undefined; };

describe('evidence paths', () => {
  it('keeps dotted keys and numeric indexes', () => {
    expect(get('data.details.1.location.0')).toEqual({ exists: true, value: 3 });
    expect(get('data.scene.engine')).toEqual({ exists: true, value: 'BLENDER_WORKBENCH' });
  });
  it('supports bracket indexes into nested arrays, including materials and colours', () => {
    expect(get('data.details[1].location[0]')).toEqual({ exists: true, value: 3 });
    expect(get('data.details[1].materials[0].color[0]')).toEqual({ exists: true, value: 1 });
    expect(get('data.details[2].materials[0].color')).toEqual({ exists: true, value: [0, 1, 0, 1] });
    expect(get('data.details[9].location')).toEqual({ exists: false });
  });
  it('selects an array element by key, also for names with dots and spaces', () => {
    expect(get('data.details[name=Ball.001].scale[1]')).toEqual({ exists: true, value: 1.5 });
    expect(get('data.details[name=Cone].materials[0].name')).toEqual({ exists: true, value: 'Green' });
    expect(get('data.details[name=Nope].scale')).toMatchObject({ exists: false, reason: expect.stringContaining('no element') });
  });
  it('refuses an ambiguous selector instead of guessing', () => {
    const dup = { details: [{ name: 'A', x: 1 }, { name: 'A', x: 2 }] };
    const r = resolveEvidencePath(dup, parseEvidencePath('details[name=A].x')!);
    expect(r).toMatchObject({ exists: false, reason: expect.stringContaining('select by index') });
  });
  it('rejects malformed, oversized and unsafe paths', () => {
    for (const bad of ['', '.a', 'a..b', 'a[', 'a[]', 'a[x]', 'a[=1]', 'a[name=]', 'a[name=x;y]', 'a[1', '1a', 'a.b-c', 'a[name=' + 'x'.repeat(65) + ']', 'a[100000]', 'a.100000',
      'a' + '.b'.repeat(12), 'x'.repeat(161), 'a[name=b]c', 'a[0]]'])
      expect(parseEvidencePath(bad), bad).toBeUndefined();
    expect(parseEvidencePath('a' + '.b'.repeat(11))).toBeDefined(); // exactly 12 steps
    expect(parseEvidencePath('a[9999]')).toBeDefined();
  });
  it('only walks own properties of parsed data', () => {
    expect(resolveEvidencePath({ a: 1 }, parseEvidencePath('constructor')!)).toEqual({ exists: false });
    expect(resolveEvidencePath({ a: [1] }, parseEvidencePath('a.length')!)).toEqual({ exists: false });
    expect(resolveEvidencePath(JSON.parse('{"__proto__":{"x":1}}'), parseEvidencePath('toString')!)).toEqual({ exists: false });
  });
});

describe('comparison of vectors and colours', () => {
  it('compares a whole vector element by element with tolerance', () => {
    expect(compareEvidence([3, 0, 0], [3, 0, 0], undefined)).toBe(true);
    expect(compareEvidence([3.0004, 0, 0], [3, 0, 0], 0.001)).toBe(true);
    expect(compareEvidence([3.2, 0, 0], [3, 0, 0], 0.001)).toBe(false);
    expect(compareEvidence([3, 0], [3, 0, 0], 0.001)).toBe(false);
    expect(compareEvidence('x', [3], 0.1)).toBe(false);
    expect(compareEvidence(['a', 1], ['a', 1], undefined)).toBe(true);
  });
  it('compares #rrggbb with a colour array (Blender rounds to 3 decimals)', () => {
    expect(compareEvidence([1, 0, 0, 1], '#ff0000', undefined)).toBe(true);
    expect(compareEvidence([0.8, 0.8, 0.8, 1], '#cccccc', undefined)).toBe(true);
    expect(compareEvidence([0.502, 0.2, 0.2, 1], '#803333', undefined)).toBe(true);
    expect(compareEvidence([0.9, 0, 0, 1], '#ff0000', undefined)).toBe(false);
    expect(compareEvidence([1, 0], '#ff0000', undefined)).toBe(false);
    expect(compareEvidence('#ff0000', '#ff0000', undefined)).toBe(true); // plain string equality still works
  });
  it('keeps exact primitive behaviour and never matches objects', () => {
    expect(compareEvidence(5, 5, undefined)).toBe(true);
    expect(compareEvidence(5.0001, 5, undefined)).toBe(false);
    expect(compareEvidence('5', 5, undefined)).toBe(false);
    expect(compareEvidence({ a: 1 }, 'x', undefined)).toBe(false);
    expect(compareEvidence([1, 2, 3], Array.from({ length: 17 }, () => 1), undefined)).toBe(false);
  });
  it('bounds what is echoed back', () => {
    expect(summarizeObserved([1, 2, 3])).toEqual([1, 2, 3]);
    expect(summarizeObserved(Array.from({ length: 500 }, (_, i) => ({ i })))).toMatchObject({ type: 'array', length: 500 });
  });
});

// ---- through the real loop: trusted external read-back with the real Blender data shape
const ctl = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };
/** A fake external_command whose scene.inspect returns Blender-shaped data; `trusted` mimics the host's trusted-readback decision. */
const registry = (trusted: boolean) => new ToolRegistry([{
  ...tool('external_command', 'cmd', z.object({ command: z.string() }).passthrough(), async ({ command }) => command === 'scene.inspect'
    ? { text: JSON.stringify({ ok: true, data }), readback: { ok: true, data }, ...(trusted ? { trustedReadback: true } : {}) } : { text: '{"ok":true,"verified":true}' }),
  readOnly: async (args: unknown) => trusted && (args as { command?: string }).command === 'scene.inspect',
}]);
const run = (script: ProviderReply[], trusted = true) => runAgent({ goal: 'g', ctl: ctl(), registry: registry(trusted), provider: new ScriptedProvider(script) });
const edit = call('1', 'external_command', { command: 'object.add' });
const inspect = call('2', 'external_command', { command: 'scene.inspect' });
const verify = (args: Record<string, unknown>) => call('3', 'evidence_verify', { receipt_id: 'r2', ...args });
const tools = (m: Array<{ role: string; content?: string | null }>) => m.filter((x) => x.role === 'tool').map((x) => x.content ?? '');

describe('evidence_verify against trusted Blender-shaped read-back (through runAgent)', () => {
  it('verifies object, vector and colour values with bracket and selector paths', async () => {
    const checks: Array<Record<string, unknown>> = [
      { path: 'data.details[name=Ball.001].location[0]', expected: 3 },
      { path: 'data.details[name=Ball.001].location', expected: [3, 0, 0] },
      { path: 'data.details[1].materials[0].color', expected: '#ff0000' },
      { path: 'data.details[name=Cone].materials[0].color[1]', expected: 1 },
      { path: 'data.details[name=Cone].materials[0].name', expected: 'Green' },
      { path: 'data.details[name=Ball.001].rotation_deg[2]', expected: 45.001, tolerance: 0.01 },
    ];
    for (const c of checks) {
      const r = await run([edit, inspect, verify(c), final]);
      expect(tools(r.messages).pop(), JSON.stringify(c)).toContain('"passed":true');
      expect(r.status, JSON.stringify(c)).toBe('completed');
    }
  });
  it('fails a wrong value, wrong colour or wrong vector and keeps the task incomplete', async () => {
    for (const c of [{ path: 'data.details[name=Ball.001].location', expected: [4, 0, 0] }, { path: 'data.details[1].materials[0].color', expected: '#00ff00' }, { path: 'data.details[1].location[0]', expected: 9 }]) {
      const r = await run([edit, inspect, verify(c), final, final]);
      expect(tools(r.messages)[2], JSON.stringify(c)).toContain('"passed":false');
      expect(r.status).toBe('limit');
    }
  });
  it("still requires a trusted read-back and refuses the command's own envelope fields", async () => {
    const untrusted = await run([edit, inspect, verify({ path: 'data.details[1].location[0]', expected: 3 }), final, final], false);
    expect(untrusted.status).toBe('limit');
    expect(tools(untrusted.messages)[2]).toContain('no eligible structured read-back');
    for (const path of ['ok', 'data']) {
      const r = await run([edit, inspect, verify({ path, expected: true }), final, final]);
      expect(tools(r.messages)[2]).toContain('data.*');
      expect(r.status).toBe('limit');
    }
  });
  it('rejects unsupported paths with a clear message and reports an ambiguous selector', async () => {
    const bad = await run([edit, inspect, verify({ path: 'data.details[name=x;y].location', expected: 1 }), final, final]);
    expect(tools(bad.messages)[2]).toMatch(/Invalid tool arguments|Unsupported path/);
    expect(bad.status).toBe('limit');
  });
  it('keeps freshness: a read-back taken before the latest edit does not verify it', async () => {
    const stale = await run([inspect, edit, call('3', 'evidence_verify', { receipt_id: 'r1', path: 'data.details[1].location[0]', expected: 3 }), final, final]);
    expect(stale.status).toBe('limit');
  });
});

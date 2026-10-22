import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from './loop';
import { ToolRegistry, tool } from './registry';
import { ScriptedProvider } from './providers/scripted';
import { compactToolSchema } from './contextBudget';
import { familiesUsedIn, OPTIONAL_FAMILY_NAMES, OPTIONAL_TOOL_FAMILIES, optionalFamiliesPrompt, registerSharedTools } from './toolFamilies';
import { SHARED_CLAUDE_TOOL_NAMES } from './sharedClaudeTools';
import { nativeToolRegistry } from './nativeTools';
import { addExternalTools } from './externalTools';
import { ClaudePartner, type ClaudePartnerDeps } from '../claudePartner';
import type { LiveTaskController } from '../liveTask';
import type { ProjectStore } from '../projectStore';
import type { Message, ModelProvider, ProviderReply, ToolDef } from './types';

const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
const call = (id: string, name: string, args: unknown): ProviderReply => ({ text: null, toolCalls: [{ id, name, args }] });
const final: ProviderReply = { text: 'done', toolCalls: [] };

describe('compactToolSchema', () => {
  it('drops execution-time validation keywords but keeps what the model needs', () => {
    const full = z.toJSONSchema(z.object({
      name: z.string().min(1).max(64).describe('The name'), kind: z.enum(['a', 'b']), n: z.number().int().min(1).max(250).default(5),
      list: z.array(z.string().max(20)).min(1).max(5), rec: z.record(z.string().max(64), z.unknown()).optional(),
    }).strict()) as Record<string, unknown>;
    const c = compactToolSchema(full) as { properties: Record<string, Record<string, unknown>>; required: string[]; [k: string]: unknown };
    expect(c.$schema).toBeUndefined();
    expect(c.additionalProperties).toBeUndefined();
    expect(c.properties.name).toEqual({ type: 'string', description: 'The name' });
    expect(c.properties.kind).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(c.properties.n).toMatchObject({ type: 'integer', minimum: 1, maximum: 250, default: 5 });
    expect(c.properties.list).toEqual({ type: 'array', items: { type: 'string' } });
    expect(c.properties.rec).toEqual({ type: 'object', additionalProperties: {} });
    expect(c.required).toEqual(['name', 'kind', 'n', 'list']);
  });
  it('never treats a property NAME as a keyword and does not change its input', () => {
    const schema = { type: 'object', properties: { maxLength: { type: 'number', maximum: 3 }, $schema: { type: 'string' } }, additionalProperties: false };
    const copy = JSON.stringify(schema);
    const c = compactToolSchema(schema) as { properties: Record<string, unknown> };
    expect(Object.keys(c.properties)).toEqual(['maxLength', '$schema']);
    expect(JSON.stringify(schema)).toBe(copy);
  });
  it('is what the model receives, while execution still validates with the full schema', async () => {
    let sent: Array<{ parameters: Record<string, unknown> }> = [];
    let turn = 0;
    const provider: ModelProvider = { id: 'cap', supportsVision: false, complete: async (i) => { sent = i.tools as never; return turn++ === 0 ? call('1', 't', { name: '' }) : final; } };
    const executed: unknown[] = [];
    const registry = new ToolRegistry([tool('t', 'd', z.object({ name: z.string().min(1).max(5) }).strict(), async (a) => { executed.push(a); return 'ok'; })]);
    const r = await runAgent({ goal: 'g', ctl: idle(), registry, provider, maxTurns: 3 });
    expect(JSON.stringify(sent[0]!.parameters)).not.toContain('maxLength');
    expect(executed).toEqual([]); // the empty name was still rejected by the full zod schema
    expect(r.messages.some((m) => m.role === 'tool' && m.content.includes('Invalid tool arguments'))).toBe(true);
  });
});

describe('optional tool families', () => {
  const def = (name: string): ToolDef => tool(name, `desc of ${name}`, z.object({}).strict(), async () => `ran ${name}`);
  const all = SHARED_CLAUDE_TOOL_NAMES.map(def);
  const names = (r: ToolRegistry) => r.snapshot().map((t) => t.name);

  it('keeps timeline and PhotoCraft tools always on and defers only the four optional families', () => {
    const r = new ToolRegistry();
    registerSharedTools(r, all);
    const on = names(r);
    for (const core of ['timeline_add', 'timeline_move_clip', 'timeline_remove_clip', 'photocraft_command']) expect(on).toContain(core);
    for (const f of OPTIONAL_FAMILY_NAMES) for (const t of OPTIONAL_TOOL_FAMILIES[f].tools) expect(on).not.toContain(t);
    expect(on).toContain('enable_tools');
    // every shared tool is either core or in exactly one family: nothing is lost
    const covered = new Set<string>([...on, ...OPTIONAL_FAMILY_NAMES.flatMap((f) => OPTIONAL_TOOL_FAMILIES[f].tools)]);
    for (const n of SHARED_CLAUDE_TOOL_NAMES) expect(covered.has(n), n).toBe(true);
  });
  it('enable_tools adds the family from the next step with the same handlers; unknown calls get a hint', async () => {
    const r = new ToolRegistry();
    registerSharedTools(r, all);
    const snap = r.snapshot();
    const early = await r.call(snap, 'planner_packages', {});
    expect(early.isError).toBe(true);
    expect(early.text).toContain('enable_tools {"family":"planner"}');
    const res = await r.call(snap, 'enable_tools', { family: 'planner' });
    expect(res.text).toContain('planner_claim');
    expect(await r.call(snap, 'planner_packages', {})).toMatchObject({ isError: true }); // not in THIS turn's snapshot
    expect((await r.call(r.snapshot(), 'planner_packages', {})).text).toBe('ran planner_packages');
    expect((await r.call(r.snapshot(), 'enable_tools', { family: 'planner' })).text).toContain('already enabled');
    expect((await r.call(r.snapshot(), 'enable_tools', { family: 'shell' })).isError).toBe(true);
  });
  it('gives a resumed task back the families its transcript used', () => {
    const messages: Message[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: '1', name: 'generate_image', args: {} }, { id: '2', name: 'enable_tools', args: { family: 'planner' } }, { id: '3', name: 'app_command', args: {} }] },
    ];
    expect([...familiesUsedIn(messages)].sort()).toEqual(['generation', 'planner']);
    const r = new ToolRegistry();
    registerSharedTools(r, all, familiesUsedIn(messages));
    expect(names(r)).toEqual(expect.arrayContaining(['generate_image', 'list_image_models', 'planner_report']));
    expect(names(r)).not.toContain('run_workflow');
    expect(familiesUsedIn(undefined).size).toBe(0);
  });
  it('through the loop: the family line is in the system prompt, the tool is enabled on request and then used', async () => {
    const r = new ToolRegistry();
    registerSharedTools(r, all);
    const seen: Array<{ system: string; tools: string[] }> = [];
    const script = [call('1', 'enable_tools', { family: 'planner' }), call('2', 'planner_packages', {}), final];
    const provider = new ScriptedProvider(script);
    const orig = provider.complete.bind(provider);
    provider.complete = async (i) => { seen.push({ system: i.system, tools: i.tools.map((t) => t.name) }); return orig(i); };
    const out = await runAgent({ goal: 'g', ctl: idle(), registry: r, provider });
    expect(out.status).toBe('completed');
    expect(seen[0]!.system).toContain(optionalFamiliesPrompt().trim());
    expect(seen[0]!.tools).not.toContain('planner_packages');
    expect(seen[1]!.tools).toContain('planner_packages');
    expect(out.messages.filter((m) => m.role === 'tool').map((m) => m.content)[1]).toBe('ran planner_packages');
    const noFamilies = await runAgent({ goal: 'g', ctl: idle(), registry: new ToolRegistry(), provider: new ScriptedProvider([final]) });
    expect(noFamilies.status).toBe('completed');
  });
});

describe('measured size of what is sent every turn (real tool definitions)', () => {
  const fakeCtl = { snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined, statusForClaude: async () => ({}) };
  const store = { loadManifest: async () => ({ assets: [] }) } as unknown as ProjectStore;
  const partner = new ClaudePartner({ live: async () => fakeCtl, store: async () => store, emit: () => undefined, history: { load: async () => [], save: async () => undefined }, imageModels: async () => [] } as unknown as ClaudePartnerDeps);
  const sizeOf = (r: ToolRegistry, compact: boolean) => JSON.stringify(r.snapshot().map((t) => ({ name: t.name, description: t.description, parameters: compact ? compactToolSchema(t.parameters) : t.parameters }))).length;

  it('deferring optional families and compacting schemas cuts the per-turn tool text substantially', async () => {
    const shared = await partner.agentToolDefs(SHARED_CLAUDE_TOOL_NAMES);
    const base = () => {
      const r = nativeToolRegistry(fakeCtl as unknown as LiveTaskController, store, { supportsVision: true, createBlank: async () => ({ id: 'x', name: 'x' }) });
      return addExternalTools(r, { list: async () => [], execute: async () => { throw new Error('unused'); }, jobs: () => [], job: () => null, cancelJob: () => false } as never);
    };
    const before = base(); for (const d of shared) before.add(d);                 // previous behaviour: everything advertised, full schemas
    const after = base(); registerSharedTools(after, shared);                       // now: optional families on request, compact schemas
    const fullChars = sizeOf(before, false), compactChars = sizeOf(after, true);
    const schemaOnly = sizeOf(before, true);
    console.log(`MEASURED tool definitions per turn: before=${fullChars} chars (${before.snapshot().length} tools), schema compaction only=${schemaOnly}, after=${compactChars} chars (${after.snapshot().length} tools)`);
    expect(schemaOnly).toBeLessThan(fullChars * 0.95);       // compaction alone
    expect(compactChars).toBeLessThan(fullChars * 0.5);      // both together: more than half gone
    // nothing was removed: every deferred tool can still be enabled and called
    expect(before.snapshot().length - after.snapshot().length).toBe(OPTIONAL_FAMILY_NAMES.flatMap((f) => OPTIONAL_TOOL_FAMILIES[f].tools).length - 1); // minus the one enable_tools
  });
});

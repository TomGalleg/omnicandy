// Offline regression tests for how ClaudeAuthor talks to the Claude SDK (the SDK is replaced by a recording fake: Claude is never
// called). Covers the request configuration and error reporting, after the second live run failed in 12 ms because the working folder
// did not exist and the real reason was replaced by a generic message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Call { prompt: string; options: Record<string, unknown>; cwdExistedAtStart: boolean }
const calls: Call[] = [];
let behaviour: 'ok' | 'throw-launch' | 'is-error' | 'structured' = 'ok';

const research = { application: { name: 'FreeCAD', publisher: null, platforms: [], version: null }, summary: 'x', sources: [{ title: 't', url: 'https://example.com/a', kind: 'official' }], methods: [], sourcesConsulted: true };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (a: { prompt: string; options: Record<string, unknown> }) => {
    calls.push({ prompt: a.prompt, options: a.options, cwdExistedAtStart: fs.existsSync(String(a.options.cwd)) });
    return (async function* () {
      if (behaviour === 'throw-launch') throw new Error('Claude Code native binary at X exists but failed to launch.');
      if (behaviour === 'is-error') { yield { type: 'result', is_error: true, subtype: 'error_max_turns', errors: ['too many turns'], total_cost_usd: 0 }; return; }
      if (behaviour === 'structured') { yield { type: 'result', is_error: false, subtype: 'success', result: '', structured_output: research, total_cost_usd: 0.01 }; return; }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: `Here you go:\n\`\`\`json\n${JSON.stringify(research)}\n\`\`\`` }] } };
      yield { type: 'result', is_error: false, subtype: 'success', result: '', total_cost_usd: 0.02 };
    })();
  },
}));

const { ClaudeAuthor, buildQueryOptions } = await import('./author');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sdkreq-')), 'not-created-yet', 'work');

afterEach(() => { calls.length = 0; behaviour = 'ok'; });

describe('SDK request configuration', () => {
  it('research: web tools only, nothing else allowed, structured output requested, no user settings', async () => {
    const cwd = tmp();
    await new ClaudeAuthor({ model: 'm', cwd, web: true }).research({ appName: 'FreeCAD', docs: [] });
    const o = calls[0]!.options;
    expect(o.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(o.allowedTools).toEqual(['WebSearch', 'WebFetch']);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.settingSources).toEqual([]);
    expect(o.mcpServers).toBeUndefined();
    expect((o.outputFormat as { type: string }).type).toBe('json_schema');
    expect(o.maxTurns).toBe(30);
    expect(o.model).toBe('m');
  });

  it('generation and repair: no tools at all, one turn, no structured schema (the blueprint relies on strict validation)', () => {
    const o = buildQueryOptions('m', 'C:/x', 'sys', { tools: [], maxTurns: 1 }, new AbortController());
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual([]);
    expect('outputFormat' in o).toBe(false);
  });

  it('the working folder exists before the SDK starts (the cause of the 12 ms failure in the second live run)', async () => {
    const cwd = tmp();
    expect(fs.existsSync(cwd)).toBe(false);
    await new ClaudeAuthor({ model: 'm', cwd, web: true }).research({ appName: 'FreeCAD', docs: [] });
    expect(calls[0]!.cwdExistedAtStart).toBe(true);
  });

  it('the environment handed to the SDK is the app environment plus the client tag only (no extra secrets are added)', () => {
    const o = buildQueryOptions('m', 'C:/x', 'sys', { tools: [], maxTurns: 1 }, new AbortController());
    const extra = Object.keys(o.env).filter((k) => !(k in process.env));
    expect(extra).toEqual(['CLAUDE_AGENT_SDK_CLIENT_APP']);
  });

  it('reads the answer from structured output when the SDK provides it, and from fenced text otherwise', async () => {
    behaviour = 'structured';
    const a = await new ClaudeAuthor({ model: 'm', cwd: tmp(), web: true }).research({ appName: 'FreeCAD', docs: [] });
    expect(a.value.application.name).toBe('FreeCAD');
    expect(a.usage.costUsd).toBeCloseTo(0.01);
    behaviour = 'ok';
    const b = await new ClaudeAuthor({ model: 'm', cwd: tmp(), web: true }).research({ appName: 'FreeCAD', docs: [] });
    expect(b.value.sources).toHaveLength(1);
  });
});

describe('error reporting', () => {
  it('keeps the real SDK error instead of replacing it with a generic message', async () => {
    behaviour = 'throw-launch';
    await expect(new ClaudeAuthor({ model: 'm', cwd: tmp(), web: true }).research({ appName: 'X', docs: [] })).rejects.toThrow(/failed to launch/);
  });

  it('reports the result subtype and errors when the SDK finishes in error', async () => {
    behaviour = 'is-error';
    await expect(new ClaudeAuthor({ model: 'm', cwd: tmp(), web: true }).research({ appName: 'X', docs: [] })).rejects.toThrow(/error_max_turns: too many turns/);
  });

  it('redacts credentials from an error before it is shown', async () => {
    behaviour = 'throw-launch';
    const orig = new Error('boom Bearer abcdefghijklmnop and sk-abcdefgh12345678');
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => ({ [Symbol.asyncIterator]() { return { next: () => Promise.reject(orig) }; } }) }));
    vi.resetModules();
    const { ClaudeAuthor: Fresh } = await import('./author');
    const err = await new Fresh({ model: 'm', cwd: tmp(), web: true }).research({ appName: 'X', docs: [] }).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/abcdefghijklmnop|sk-abcdefgh/);
    expect((err as Error).message).toMatch(/\[redacted\]/);
  });

  it('keeps the raw answer only when it cannot be used, and deletes it when it parses', async () => {
    const cwd = tmp();
    const raw = path.join(cwd, 'last-ai-response.txt');
    // unusable: no application name
    behaviour = 'ok';
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => (async function* () { yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"summary":"x Bearer abcdefghijklmnop"}' }] } }; yield { type: 'result', is_error: false, total_cost_usd: 0 }; })() }));
    vi.resetModules();
    const { ClaudeAuthor: Bad } = await import('./author');
    await expect(new Bad({ model: 'm', cwd, web: true }).research({ appName: 'X', docs: [] })).rejects.toThrow(/does not name the application/);
    expect(fs.readFileSync(raw, 'utf8')).not.toMatch(/abcdefghijklmnop/);
    expect(fs.readFileSync(raw, 'utf8')).toMatch(/\[redacted\]/);
    // usable: the file is removed
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => (async function* () { yield { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(research) }] } }; yield { type: 'result', is_error: false, total_cost_usd: 0 }; })() }));
    vi.resetModules();
    const { ClaudeAuthor: Good } = await import('./author');
    await new Good({ model: 'm', cwd, web: true }).research({ appName: 'X', docs: [] });
    expect(fs.existsSync(raw)).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { runAgent } from '../loop';
import { ToolRegistry } from '../registry';
import type { ModelProvider } from '../types';
import type { LiveTaskController } from '../../liveTask';
import { GeminiProvider } from './gemini';
import { OpenAICompatibleProvider } from './openaiCompatible';
import { MAX_RETRY_WAIT_MS, RETRY_ATTEMPTS, explainHttp, fetchWithRetry, providerErrorCode, retryAfterMs } from './retry';

const res = (status: number, headers: Record<string, string> = {}, body: unknown = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body }) as unknown as Response;
const signal = () => new AbortController().signal;
const noSleep = vi.fn(async () => undefined);

describe('retrying a rate-limited or briefly unavailable provider', () => {
  it('waits and tries again on 429 and 5xx, honouring Retry-After (capped), and returns the first good answer', async () => {
    const sleep = vi.fn(async () => undefined);
    const answers = [res(429, { 'retry-after': '3' }), res(503), res(200)];
    const doFetch = vi.fn(async () => answers.shift()!);
    const r = await fetchWithRetry(doFetch, signal(), sleep);
    expect(r.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[0]![0]).toBe(3000);
    expect(sleep.mock.calls[1]![0]).toBeGreaterThanOrEqual(3000); // backoff without a header: 1.5s * 2 + jitter
    expect(retryAfterMs(res(429, { 'retry-after': '9999' }))).toBe(MAX_RETRY_WAIT_MS);
    expect(retryAfterMs(res(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toBeUndefined();
  });
  it('gives up after a few attempts, never retries a client error, and stops when the task is cancelled', async () => {
    const always = vi.fn(async () => res(429));
    expect((await fetchWithRetry(always, signal(), noSleep)).status).toBe(429);
    expect(always).toHaveBeenCalledTimes(RETRY_ATTEMPTS);
    const bad = vi.fn(async () => res(400));
    expect((await fetchWithRetry(bad, signal(), noSleep)).status).toBe(400);
    expect(bad).toHaveBeenCalledTimes(1);
    const ac = new AbortController();
    const once = vi.fn(async () => { ac.abort(); return res(429); });
    await fetchWithRetry(once, ac.signal, noSleep);
    expect(once).toHaveBeenCalledTimes(1);
  });
  it('explains the failure in plain words and reads only a short machine code from the error body', async () => {
    expect(await providerErrorCode(res(429, {}, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota, sk-secret' } }))).toBe('insufficient_quota');
    expect(await providerErrorCode(res(429, {}, { error: { code: 'has spaces and sk-secret' } }))).toBeUndefined();
    expect(await providerErrorCode({ json: async () => { throw new Error('not json'); } })).toBeUndefined();
    expect(explainHttp(429)).toMatch(/rate limit.*press Continue Task/);
    expect(explainHttp(429, 'insufficient_quota')).toMatch(/out of quota or credit/);
    expect(explainHttp(503)).toMatch(/temporary problem/);
    expect(explainHttp(401)).toBe('');
  });
});

describe('providers use it', () => {
  const ask = (p: ModelProvider) => p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: signal() });
  it('OpenAI-compatible: recovers from a rate limit and reports quota exhaustion without the provider text', async () => {
    const answers = [res(429, { 'retry-after': '0' }), res(200, {}, { choices: [{ message: { content: 'ok' } }] })];
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: (async () => answers.shift()!) as typeof fetch });
    expect((await ask(p)).text).toBe('ok');
    const dead = new OpenAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: (async () => res(429, { 'retry-after': '0' }, { error: { code: 'insufficient_quota', message: 'secret details sk-123' } })) as typeof fetch });
    const err = await ask(dead).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^Provider HTTP 429 \(the account is out of quota or credit/);
    expect((err as Error).message).not.toContain('sk-123');
  });
  it('Gemini: recovers from a 503 and keeps the HTTP code in the error', async () => {
    const answers = [res(503, { 'retry-after': '0' }), res(200, {}, { candidates: [{ content: { parts: [{ text: 'hello' }] } }] })];
    const g = new GeminiProvider({ model: 'gemini-x', getKey: async () => 'k', fetchImpl: (async () => answers.shift()!) as typeof fetch });
    expect((await ask(g)).text).toBe('hello');
    const down = new GeminiProvider({ model: 'gemini-x', getKey: async () => 'k', fetchImpl: (async () => res(429, { 'retry-after': '0' })) as typeof fetch });
    await expect(ask(down)).rejects.toThrow(/^Gemini HTTP 429 \(rate limit/);
  });
});

describe('the agent loop and a provider limit', () => {
  const idle = () => ({ snapshot: () => ({ collab: { phase: 'idle', lockOwner: null, activeOperation: null }, asset: null, history: [], savedVersionIds: [] }), claudeDone: () => undefined }) as unknown as LiveTaskController;
  const failing = (message: string): ModelProvider => ({ id: 'x', supportsVision: false, complete: async () => { throw new Error(message); } });
  it('keeps the task resumable (limit, plan saved) on 429 and 5xx, and still fails on other errors', async () => {
    const limited = await runAgent({ goal: 'g', ctl: idle(), registry: new ToolRegistry(), provider: failing('Provider HTTP 429 (rate limit: too many tokens or requests per minute; wait a minute, then press Continue Task)') });
    expect(limited.status).toBe('limit');
    expect(limited.text).toMatch(/Nothing was lost.*press Continue Task/);
    expect((await runAgent({ goal: 'g', ctl: idle(), registry: new ToolRegistry(), provider: failing('Gemini HTTP 503 (the provider had a temporary problem)') })).status).toBe('limit');
    expect((await runAgent({ goal: 'g', ctl: idle(), registry: new ToolRegistry(), provider: failing('Provider HTTP 401') })).status).toBe('failed');
    expect((await runAgent({ goal: 'g', ctl: idle(), registry: new ToolRegistry(), provider: failing('Model request failed or returned invalid data.') })).status).toBe('failed');
  });
});

// The planning chat: prompt content, request shapes, limits, key handling. Providers are faked; no real call is made.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatSystemPrompt, connectedAppsLine, MAX_CHAT_MESSAGE_CHARS, MAX_CHAT_MESSAGES, trimChat } from '@shared/plannerChat';
import { parseSuggestionText } from '@shared/plannerPaste';
import { geminiChatBody, openaiChatBody, parseGeminiChat, parseOpenAIChat, PlannerChat, textModels, type ChatDeps } from './chat';
import { PlannerService, userCtx } from './service';
import { PlannerStore } from './store';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-plan-chat-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const user = userCtx();
const KEY = 'sk-test-SECRET-123';

interface Call { url: string; init: RequestInit }
function fake(over: { configured?: string[]; respond?: (url: string) => Response; claude?: (system: string, prompt: string, model?: string) => Promise<string> } = {}) {
  const calls: Call[] = [];
  const claudeCalls: Array<{ system: string; prompt: string; model?: string }> = [];
  const deps: ChatDeps = {
    vault: { status: async (id) => ({ configured: (over.configured ?? ['openai', 'gemini']).includes(id) }), withKey: async (_id, fn) => fn(KEY) },
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return over.respond ? over.respond(String(url)) : new Response('{}'); }) as unknown as typeof fetch,
    claude: () => ({ planChat: async (system, prompt, model) => { claudeCalls.push({ system, prompt, model }); return over.claude ? over.claude(system, prompt, model) : 'Sure.'; } }),
  };
  return { chat: new PlannerChat(deps), calls, claudeCalls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

describe('what the AI is told', () => {
  it('a short plan summary and the rules of the chat, but no file locations, ideas or task details', async () => {
    const svc = new PlannerService(new PlannerStore(path.join(tmp, 'sys')));
    const p = await svc.createProject(user, { title: 'Poster', goal: 'A dragon poster' });
    await svc.addItem(user, p.id, { type: 'requirement', title: 'Teal and gold palette' });
    await svc.addItem(user, p.id, { type: 'idea', title: 'Secret idea about robots' });
    await svc.addTask(user, p.id, { title: 'Sketch the dragon', description: 'private C:\\Users\\me\\notes.txt' });
    await svc.addAsset(user, p.id, { role: 'reference', title: 'ref', source: 'file', path: 'C:\\Users\\me\\ref.png' });
    const sys = chatSystemPrompt(await svc.getProject(user, p.id));
    expect(sys).toContain('A dragon poster');
    expect(sys).toContain('Teal and gold palette');
    expect(sys).toContain('Sketch the dragon');
    expect(sys).toContain('the user decides what joins the plan');
    expect(sys).not.toContain('Secret idea');
    expect(sys).not.toContain('private');
    expect(sys).not.toMatch(/C:\\Users/);
  });

  it('what comes back reads as suggestions the owner can tick (same reader as Paste back)', () => {
    const r = parseSuggestionText('Here is a start.\n\n## Requirements\n- Print at A2\n## Tasks\n- Sketch it\n  - Looks good at thumbnail size\n## Questions\n- Which paper?');
    expect(r.changes.map((c) => c.op)).toEqual(['add_item', 'add_task', 'add_item']);
  });
});

describe('the General Manager guides the first conversation', () => {
  it('is told to say who on the team it would lean on, and keeps the ready question and the format', async () => {
    const svc = new PlannerService(new PlannerStore(path.join(tmp, 'gm')));
    const p = await svc.createProject(user, { title: 'Dragons' });
    const sys = chatSystemPrompt(await svc.getProject(user, p.id));
    expect(sys).toContain('which people on your team you would lean on');
    expect(sys).toContain('[[READY]]');
    expect(sys).toContain('App: the connected application');
  });

  it('names connected applications once each, at most twenty, and says nothing when there are none', () => {
    expect(connectedAppsLine([])).toEqual([]);
    expect(connectedAppsLine(['  ', ''])).toEqual([]);
    const one = connectedAppsLine(['Blender', 'Blender', 'Unreal Engine']);
    expect(one).toHaveLength(1);
    expect(one[0]).toContain('Blender, Unreal Engine');
    expect(one[0]).toContain('never name others');
    expect(connectedAppsLine(Array.from({ length: 40 }, (_, i) => `App${i}`))[0]).not.toContain('App25');
  });

  it('reads an App line under a chunk as the application, not as a check, and ignores "none"', () => {
    const r = parseSuggestionText('## Tasks\n1. Model the dragon\n   - Looks right from every side\n   - App: Blender\n2. Write the story\n   - App: none\n3. Draw the logo\n   - App: PhotoCraft');
    const tasks = r.changes.filter((c) => c.op === 'add_task') as Array<Extract<(typeof r.changes)[number], { op: 'add_task' }>>;
    expect(tasks[0]!.appRef).toEqual({ kind: 'external', id: 'Blender', note: '' });
    expect(tasks[0]!.completionChecks).toEqual(['Looks right from every side']);
    expect(tasks[1]!.appRef ?? null).toBeNull();
    expect(tasks[2]!.appRef!.kind).toBe('native');
  });

  it('keeps the application on the task once the owner adds the chunk', async () => {
    const svc = new PlannerService(new PlannerStore(path.join(tmp, 'gm2')));
    const p = await svc.createProject(user, { title: 'Dragons' });
    const r = parseSuggestionText('## Tasks\n1. Model the dragon\n   - Looks right\n   - App: Blender');
    const pr = await svc.importSuggestions(user, p.id, { note: 'chunks', changes: r.changes, rawText: 'x' });
    await svc.decideProposal(user, p.id, pr.id, true);
    expect((await svc.getProject(user, p.id)).tasks[0]!.appRef).toEqual({ kind: 'external', id: 'Blender', note: '' });
  });
});

describe('limits that bound the cost', () => {
  it('keeps only the newest messages and cuts long ones', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `m${i}` }));
    const t = trimChat(many);
    expect(t).toHaveLength(MAX_CHAT_MESSAGES);
    expect(t[t.length - 1]?.text).toBe('m59');
    expect(trimChat([{ role: 'user', text: 'x'.repeat(MAX_CHAT_MESSAGE_CHARS + 500) }])[0]?.text).toHaveLength(MAX_CHAT_MESSAGE_CHARS);
  });
  it('asks for a bounded reply and never sends more than the newest messages', async () => {
    const f = fake({ respond: () => json({ choices: [{ message: { content: 'ok' } }] }) });
    const messages = Array.from({ length: 41 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `m${i}` }));
    await f.chat.reply({ system: 'S', provider: 'openai', model: 'gpt-x', messages });
    const body = JSON.parse(String(f.calls[0]?.init.body)) as { messages: unknown[]; max_completion_tokens: number };
    expect(body.messages).toHaveLength(MAX_CHAT_MESSAGES + 1); // + the system message
    expect(body.max_completion_tokens).toBeLessThanOrEqual(3000);
  });
  it('needs a user message last', async () => {
    const f = fake();
    await expect(f.chat.reply({ system: 'S', provider: 'openai', model: 'gpt-x', messages: [{ role: 'assistant', text: 'hi' }] })).rejects.toThrow(/Write a message/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('providers', () => {
  it('OpenAI: key in the header only, system message first, text read back', async () => {
    const f = fake({ respond: () => json({ choices: [{ message: { content: '  Hello there  ' } }] }) });
    const r = await f.chat.reply({ system: 'SYS', provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', text: 'Hi' }] });
    expect(r.text).toBe('Hello there');
    expect(f.calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((f.calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(String(f.calls[0]?.init.body)).not.toContain(KEY);
    expect(openaiChatBody('m', 'SYS', [{ role: 'user', text: 'Hi' }]).messages[0]).toEqual({ role: 'system', content: 'SYS' });
  });
  it('Gemini: model in the path, key in the header, roles mapped, text joined', async () => {
    const f = fake({ respond: () => json({ candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] }) });
    const r = await f.chat.reply({ system: 'SYS', provider: 'gemini', model: 'gemini-test-1', messages: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Yo' }, { role: 'user', text: 'Again' }] });
    expect(r.text).toBe('AB');
    expect(f.calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test-1:generateContent');
    expect((f.calls[0]?.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    expect(f.calls[0]?.url).not.toContain(KEY);
    expect(geminiChatBody('S', [{ role: 'assistant', text: 'x' }]).contents[0]?.role).toBe('model');
  });
  it('Claude: only the listed models, the transcript goes as one prompt', async () => {
    const f = fake({ claude: async () => '  Plan:\n- a  ' });
    const r = await f.chat.reply({ system: 'SYS', provider: 'claude', model: 'claude-sonnet-5-5', messages: [{ role: 'user', text: 'Hi' }] });
    expect(r.text).toBe('Plan:\n- a');
    expect(f.claudeCalls[0]).toMatchObject({ system: 'SYS', model: 'claude-sonnet-5-5' });
    expect(f.claudeCalls[0]?.prompt).toContain('User: Hi');
    await expect(f.chat.reply({ system: 'S', provider: 'claude', model: 'not-a-model', messages: [{ role: 'user', text: 'Hi' }] })).rejects.toThrow(/listed Claude models/);
    expect(f.calls).toHaveLength(0); // no HTTP for Claude
  });
  it('refuses a model name that could change the address', async () => {
    const f = fake();
    await expect(f.chat.reply({ system: 'S', provider: 'gemini', model: '../../x?y=1', messages: [{ role: 'user', text: 'Hi' }] })).rejects.toThrow(/not valid/);
    expect(f.calls).toHaveLength(0);
  });
  it('says plainly when a provider refuses and never repeats the key', async () => {
    const f = fake({ respond: () => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401) });
    const err = await f.chat.reply({ system: 'S', provider: 'openai', model: 'gpt-x', messages: [{ role: 'user', text: 'Hi' }] }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/refused the request \(401\).*Settings > Integrations/);
    expect((err as Error).message).not.toContain(KEY); // even when the provider echoes it back
    expect((err as Error).message).toContain('[key]');
  });
  it('lists what can chat from each provider\'s own models list, and who is ready', async () => {
    const openai = { data: [{ id: 'gpt-4o' }, { id: 'gpt-image-1' }, { id: 'text-embedding-3' }, { id: 'whisper-1' }, { id: 'o3-mini' }, { id: 'gpt-4o-audio-preview' }, { id: 'dall-e-3' }] };
    expect(textModels('openai', openai).sort()).toEqual(['gpt-4o', 'o3-mini']);
    const gem = { models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }, { name: 'models/imagen-4', supportedGenerationMethods: ['predict'] },
    ] };
    expect(textModels('gemini', gem)).toEqual(['gemini-2.5-pro']);
    const f = fake({ configured: ['gemini'], respond: (u) => (u.includes('googleapis') ? json(gem) : json(openai)) });
    expect(await f.chat.models('gemini')).toEqual(['gemini-2.5-pro']);
    const ps = await f.chat.providers();
    expect(ps.map((p) => [p.id, p.ready])).toEqual([['claude', true], ['openai', false], ['gemini', true]]);
    expect(ps[1]?.note).toMatch(/Settings > Integrations/);
    expect(parseOpenAIChat({ choices: [{ message: { content: 'x' } }] })).toBe('x');
    expect(() => parseOpenAIChat({})).toThrow();
    expect(() => parseGeminiChat({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/declined/);
  });
});

describe('it only ever calls out when asked, and never writes to a plan', () => {
  it('the chat modules use only the injected fetch and import nothing that edits a plan', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const f of ['./chat.ts', '../../shared/plannerChat.ts']) {
      const src = await fs.readFile(path.join(here, f), 'utf8');
      expect(src, f).not.toMatch(/(^|[^.\w])fetch\(|globalThis\.fetch|node:https?|XMLHttpRequest|WebSocket/);
      expect(src, f).not.toMatch(/PlannerService|decideProposal|importSuggestions|addItem|addTask/);
    }
    const ipc = await fs.readFile(path.join(here, './ipc.ts'), 'utf8');
    const chatMethods = ipc.slice(ipc.indexOf('chatProviders:'), ipc.indexOf('connectionInfo:'));
    expect(chatMethods).not.toMatch(/s\.(add|update|set|remove|decide|import|review|create)/);
  });
});

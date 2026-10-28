import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlannerService, userCtx } from './service';
import { CHAT_KEEP_MESSAGES, CHAT_MAX_CHARS, PlannerStore, type StoreWrite } from './store';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitown-chat-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const make = (events: StoreWrite[] = []) => {
  const store = new PlannerStore(tmp, undefined, { onWrite: (w) => events.push(w) });
  return { store, svc: new PlannerService(store), u: userCtx() };
};
const chatFile = (id: string, f = 'chat.json') => path.join(tmp, 'projects', id, f);
const msg = (n: number, role: 'user' | 'assistant' = 'user') => ({ role, text: `message ${n}` });

describe('the planning conversation file', () => {
  it('loads a file written before it had a version, unchanged', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Old chat' });
    fs.writeFileSync(chatFile(p.id), JSON.stringify({ messages: [msg(1), msg(2, 'assistant')], provider: 'claude', model: 'claude-sonnet-5-5', savedAt: '2026-01-01T00:00:00Z' }));
    const c = await store.readChat(p.id);
    expect(c.messages).toHaveLength(2);
    expect(c).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5' });
  });

  it('appends, keeps the newest 48, and cuts long messages', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Long' });
    for (let i = 0; i < 60; i++) await store.appendChat(p.id, { messages: [msg(i)] });
    const c = await store.readChat(p.id);
    expect(c.messages).toHaveLength(CHAT_KEEP_MESSAGES);
    expect(c.messages.at(-1)?.text).toBe('message 59');
    expect(c.messages[0]?.text).toBe('message 12');
    await store.appendChat(p.id, { messages: [{ role: 'user', text: 'x'.repeat(CHAT_MAX_CHARS + 500) }] });
    expect((await store.readChat(p.id)).messages.at(-1)?.text).toHaveLength(CHAT_MAX_CHARS);
    expect(JSON.parse(fs.readFileSync(chatFile(p.id), 'utf8')).version).toBe(2);
  });

  it('loses nothing when appends overlap', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Parallel' });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.appendChat(p.id, { messages: [msg(i)] })));
    const texts = (await store.readChat(p.id)).messages.map((m) => m.text).sort();
    expect(texts).toHaveLength(20);
    expect(new Set(texts).size).toBe(20);
  });

  it('uses the copy from before the last write when the file is damaged, and sets the damaged one aside', async () => {
    const events: StoreWrite[] = [];
    const { store, svc, u } = make(events);
    const p = await svc.createProject(u, { title: 'Hurt chat' });
    await store.appendChat(p.id, { messages: [msg(1)] });
    await store.appendChat(p.id, { messages: [msg(2)] });
    fs.writeFileSync(chatFile(p.id), '{{{ broken');
    const c = await store.readChat(p.id);
    expect(c.messages.map((m) => m.text)).toEqual(['message 1']);
    expect(fs.readdirSync(path.dirname(chatFile(p.id))).some((f) => f.startsWith('chat.corrupt-'))).toBe(true);
    expect(events.some((e) => e.kind === 'recovered' && e.what === 'chat')).toBe(true);
  });

  it('starts empty when both copies are unusable, and when there is no file at all', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Nothing' });
    expect((await store.readChat(p.id)).messages).toEqual([]);
    fs.writeFileSync(chatFile(p.id), 'nope');
    fs.writeFileSync(chatFile(p.id, 'chat.prev.json'), 'nope');
    expect((await store.readChat(p.id)).messages).toEqual([]);
  });

  it('keeps the legacy full save working and never stores more than the schema', async () => {
    const { store, svc, u } = make();
    const p = await svc.createProject(u, { title: 'Legacy' });
    await store.writeChat(p.id, { messages: [msg(1), msg(2, 'assistant')], provider: 'openai', model: 'gpt-x' });
    const raw = JSON.parse(fs.readFileSync(chatFile(p.id), 'utf8'));
    expect(Object.keys(raw).sort()).toEqual(['messages', 'model', 'provider', 'savedAt', 'version']);
  });
});

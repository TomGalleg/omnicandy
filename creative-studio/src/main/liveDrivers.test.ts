// Driver-level regressions that need no app window: a fake MCP connection stands in for the app.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveDeckCraft, LiveWordCraft } from './liveApps';

type Call = { name: string; args: Record<string, unknown> };
function withFake<T extends object>(driver: T, reply: (c: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  (driver as unknown as { mcp: unknown }).mcp = {
    alive: true,
    callTool: async (name: string, args: Record<string, unknown>) => { const c = { name, args }; calls.push(c); return reply(c); },
    close() {},
  };
  return calls;
}
const opts = { installDir: 'C:/none', readRoot: '', writeRoot: '', headless: true };

describe('DeckCraft history', () => {
  // inspect_document reports the newest undo step as ONE label string; spreading it made one entry per letter.
  it('shows a single undo label as one entry, not one per letter', async () => {
    const d = new LiveDeckCraft(opts);
    withFake(d, () => ({ undo: 'Set Text' }));
    expect(await d.history()).toEqual(['Open', 'Set Text']);
  });
  it('still accepts a list, and an empty or missing undo', async () => {
    const d = new LiveDeckCraft(opts);
    withFake(d, () => ({ undo: ['Set Text', 'Add Slide'] }));
    expect(await d.history()).toEqual(['Open', 'Set Text', 'Add Slide']);
    const e = new LiveDeckCraft(opts);
    withFake(e, () => ({ undo: null }));
    expect(await e.history()).toEqual(['Open']);
    const f = new LiveDeckCraft(opts);
    withFake(f, () => ({}));
    expect(await f.history()).toEqual(['Open']);
  });
});

describe('WordCraft baseline', () => {
  it('saves the just-opened document through save_document so unchanged saves can be recognised', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-wc-base-'));
    const w = new LiveWordCraft(opts);
    const calls = withFake(w, async (c) => { if (c.name === 'save_document') await fs.writeFile(String(c.args.path), 'docx-bytes'); return {}; });
    const file = await w.writeBaseline(dir, 'baseline-1');
    expect(file).toBe(path.join(dir, 'baseline-1.docx'));
    expect(calls.map((c) => c.name)).toEqual(['save_document']);
    expect(await fs.readFile(file, 'utf8')).toBe('docx-bytes');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

import { describe, expect, it } from 'vitest';
import { runBounded } from './shutdown';

describe('runBounded', () => {
  it('waits for every task, even when one fails or throws at once', async () => {
    const done: string[] = [];
    const r = await runBounded([
      async () => { await new Promise((x) => setTimeout(x, 20)); done.push('slow'); },
      async () => { throw new Error('bad'); },
      () => { throw new Error('sync bad'); },
    ], 2000);
    expect(r.finished).toBe(true);
    expect(done).toEqual(['slow']);
  });

  it('gives up after the time limit when a task never ends', async () => {
    const t0 = Date.now();
    const r = await runBounded([() => new Promise(() => undefined)], 100);
    expect(r.finished).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

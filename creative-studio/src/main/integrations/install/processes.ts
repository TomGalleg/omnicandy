import { runProcess } from '../process';

/** Is any of these programs running? Reads the task list only; never ends a process. False when it cannot tell. */
export async function anyRunning(names: string[]): Promise<boolean> {
  if (process.platform !== 'win32' || !names.length) return false;
  try {
    const r = await runProcess('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 8000, label: 'the task list', env: { SystemRoot: process.env.SystemRoot ?? '', windir: process.env.windir ?? '', PATH: process.env.PATH ?? '' } });
    const want = new Set(names.map((n) => n.toLowerCase()));
    return r.out.split(/\r?\n/).some((l) => want.has((/^"([^"]+)"/.exec(l)?.[1] ?? '').toLowerCase()));
  } catch { return false; }
}

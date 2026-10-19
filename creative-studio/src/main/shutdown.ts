/** Runs clean-up tasks at exit. Each one is allowed to fail, and the whole group is given at most `ms` so quitting never hangs. */
export async function runBounded(tasks: Array<() => Promise<unknown>>, ms: number): Promise<{ finished: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const all = Promise.allSettled(tasks.map((t) => { try { return t(); } catch (e) { return Promise.reject(e); } })).then(() => true);
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try { return { finished: await Promise.race([all, timeout]) }; } finally { clearTimeout(timer); }
}

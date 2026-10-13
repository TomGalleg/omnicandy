import { useCallback, useEffect, useState } from 'react';
import type { LiveSnapshot } from '@shared/live';

/** Live PhotoCraft session state pushed from main, plus a helper that surfaces action errors. */
export function useLive(log: (source: string, msg: string) => void) {
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.studio.live.state().then(setLive);
    return window.studio.live.onChange(setLive);
  }, []);

  // Keep the history fresh while you might be editing by hand in PhotoCraft.
  const idle = live?.status === 'ready' && !live.collab.activeOperation && live.collab.phase !== 'running';
  useEffect(() => {
    if (!idle) return;
    const t = setInterval(() => { void window.studio.live.refresh().catch(() => {}); }, 2000);
    return () => clearInterval(t);
  }, [idle]);

  const act = useCallback(async (label: string, fn: () => Promise<LiveSnapshot>) => {
    setBusy(true);
    try {
      const s = await fn();
      setLive(s);
      if (s.message) log('photocraft', s.message);
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
      log('photocraft', `${label} failed: ${msg}`);
      setLive((l) => (l ? { ...l, message: msg } : l));
    } finally {
      setBusy(false);
    }
  }, [log]);

  return { live, busy, act };
}

export type LiveApi = ReturnType<typeof useLive>;

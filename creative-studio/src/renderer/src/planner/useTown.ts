import { useCallback, useEffect, useState } from 'react';
import type { TownState } from '@shared/town';

const api = () => window.studio.planner;

/** The town of a plan, kept up to date as it changes (here or in another window). Made the first time it is asked for. */
export function useTown(planId: string) {
  const [town, setTown] = useState<TownState | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => {
    void api().townLoad(planId).then((r) => { setTown((cur) => (cur && cur.rev > r.town.rev ? cur : r.town)); if (r.recovered) setNote('The saved town could not be read, so a fresh one was started. The old file was kept.'); }).catch(() => {});
  }, [planId]);
  useEffect(() => {
    setTown(null);
    load();
    const off = api().onEvent((e) => { if (e.type === 'town.changed' && e.planId === planId) load(); });
    return off;
  }, [planId, load]);
  return { town, setTown, note, clearNote: () => setNote(null), reload: load };
}

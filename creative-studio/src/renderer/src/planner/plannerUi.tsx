import { useCallback, useState, type ReactNode } from 'react';
import { TASK_STATUS_LABEL, type PlannerProject, type TaskStatus } from '@shared/planner';

export type TabId = 'overview' | 'plan' | 'tasks' | 'assets' | 'handoffs' | 'history';
export interface TabProps { p: PlannerProject; reload: () => Promise<void>; go: (t: TabId) => void }

/** Electron prefixes errors that cross the bridge; the user only needs the message. */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '');

/** Runs one user action: busy while it runs, the error shown in place, the project reloaded afterwards. */
export function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { const r = await fn(); await reload(); return r; } catch (e) { setError(errMsg(e)); await reload().catch(() => {}); return undefined; } finally { setBusy(false); }
  }, [reload]);
  return { busy, error, run, setError };
}

export function ErrorLine({ error }: { error: string | null }) { return error ? <p className="pl-error" role="alert">{error}</p> : null; }

export const STATUS_TONE: Record<TaskStatus, string> = { todo: 'off', in_progress: 'warn', blocked: 'bad', reported: 'warn', revision: 'warn', accepted: 'ok', cancelled: 'off' };
export function StatusChip({ status }: { status: TaskStatus }) { return <span className={`chip pl-status ${STATUS_TONE[status]}`}><span className="dot" />{TASK_STATUS_LABEL[status]}</span>; }

export function Section({ title, hint, children, actions }: { title: string; hint?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="pl-section">
      <header><h3>{title}</h3>{actions}</header>
      {hint && <p className="pl-hint">{hint}</p>}
      {children}
    </section>
  );
}

export const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
export const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button className="btn small" onClick={async () => { setState((await copyText(text)) ? 'ok' : 'fail'); setTimeout(() => setState('idle'), 1800); }}>
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
    </button>
  );
}

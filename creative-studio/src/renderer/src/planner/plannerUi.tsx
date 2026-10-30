import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { TASK_STATUS_LABEL, type PlannerProject, type PlanTask, type TaskStatus } from '@shared/planner';
import { displayStatus, plainError, SIMPLE_LABEL } from '@shared/plannerView';

export type TabId = 'studio' | 'town' | 'plan' | 'tasks' | 'handoffs';
export interface TabProps {
  /** The open OmniCandy project's manifest (what it already contains). */
  manifest?: import('@shared/types').ProjectManifest | null;
  p: PlannerProject; reload: () => Promise<void>; go: (t: TabId) => void;
  /** Tasks chosen for Send to AI (kept here so a task's Send button can open the AI area with it ticked). */
  sendSel?: string[]; setSendSel?: (ids: string[]) => void;
  /** The OmniCandy project that is open now (a task can point at its workflow). */
  projectKey?: string | null; projectName?: string;
  /** The task being worked on (opened from Plan, or picked up from where the owner left off). */
  focusTaskId?: string | null; setFocusTaskId?: (id: string | null) => void;
  /** Something for OmniTown to open the moment it shows: the plan as cards, or one task in its director's office. Used in Simplified mode, which has no other tabs. */
  townCmd?: { kind: 'plan' } | { kind: 'task'; id: string } | null; clearTownCmd?: () => void;
  /** Show only this director's tasks (their office), instead of the whole plan. */
  forDirector?: import('@shared/town').DirectorKey;
}

/** Electron prefixes errors that cross the bridge; the user only needs the message. */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '');

/** Runs one user action: busy while it runs, the error shown in place, the project reloaded afterwards. */
export function useAction(reload: () => Promise<void>) {
  const plain = useContext(PlainWords);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { const r = await fn(); await reload(); return r; } catch (e) { setError(plain ? plainError(errMsg(e)) : errMsg(e)); await reload().catch(() => {}); return undefined; } finally { setBusy(false); }
  }, [reload, plain]);
  return { busy, error, run, setError };
}

export function ErrorLine({ error }: { error: string | null }) { return error ? <p className="pl-error" role="alert">{error}</p> : null; }

export const STATUS_TONE: Record<TaskStatus, string> = { todo: 'off', in_progress: 'warn', blocked: 'bad', reported: 'warn', revision: 'warn', accepted: 'ok', cancelled: 'off' };
/** True in the plain-words view (Advanced off): five task labels instead of the seven stored statuses. */
export const PlainWords = createContext(false);

export function StatusChip({ status, task, p, inColumn }: { status: TaskStatus; task?: PlanTask; p?: PlannerProject; inColumn?: boolean }) {
  const plain = useContext(PlainWords);
  if (plain && task && p) {
    const d = displayStatus(task, p);
    // On the board the column already says the label; only the explanation is left.
    if (inColumn) return d.chip ? <span className={`pl-status-note ${d.tone}`}>{d.chip}</span> : null;
    return <span className={`chip pl-status ${d.tone}`} title={d.chip}><span className="dot" />{d.label}{d.chip ? <small className="pl-hint"> {d.chip}</small> : null}</span>;
  }
  if (plain) return <span className={`chip pl-status ${STATUS_TONE[status]}`}><span className="dot" />{SIMPLE_LABEL[status]}</span>;
  return <span className={`chip pl-status ${STATUS_TONE[status]}`}><span className="dot" />{TASK_STATUS_LABEL[status]}</span>;
}

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

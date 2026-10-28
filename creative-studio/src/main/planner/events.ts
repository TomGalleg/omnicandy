// Turns what the store writes into events for the windows, and notices changes made by someone else (the stand-alone planner connection
// that Claude Code or another tool starts writes the same files from another process). One check of one file every few seconds, in the main
// process, replaces every window polling for itself.
import fs from 'node:fs/promises';
import type { PlannerEvent } from '@shared/plannerEvents';
import type { StoreWrite } from './store';

export interface WatchTarget { planId: string; file: string }

export class PlannerEventHub {
  private readonly lastRevision = new Map<string, number>();
  private readonly lastSeen = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(private readonly opts: { broadcast: (e: PlannerEvent) => void; now?: () => Date; pollMs?: number }) {}

  private at() { return (this.opts.now?.() ?? new Date()).toISOString(); }
  private send(e: PlannerEvent) { try { this.opts.broadcast(e); } catch { /* a window that is gone must not stop the rest */ } }

  /** Something this app just wrote. */
  emitWrite(w: StoreWrite): void {
    switch (w.kind) {
      case 'plan':
        this.lastRevision.set(w.planId, w.revision);
        return this.send({ type: 'plan.changed', planId: w.planId, revision: w.revision, planRevision: w.planRevision, origin: 'app', at: this.at() });
      case 'canvas': return this.send({ type: 'canvas.changed', planId: w.planId, layoutRev: w.layoutRev, origin: 'app', at: this.at() });
      case 'chat': return this.send({ type: 'chat.changed', planId: w.planId, messages: w.messages, at: this.at() });
      case 'town': return this.send({ type: 'town.changed', planId: w.planId, rev: w.rev, at: this.at() });
      case 'recovered': return this.send({ type: 'plan.recovered', planId: w.planId, what: w.what, note: w.note, at: this.at() });
    }
  }

  /**
   * Looks at the plan file once. The first look only remembers where things stand. When the file changed and holds a revision this app did
   * not write itself, an `external` event is sent. Exposed so tests (and a caller that wants an immediate look) need no timers.
   */
  async check(resolve: () => Promise<WatchTarget | null>): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const t = await resolve();
      if (!t) return;
      const st = await fs.stat(t.file).catch(() => null);
      if (!st) return;
      const sig = `${st.mtimeMs}:${st.size}`;
      if (this.lastSeen.get(t.planId) === sig) return;
      this.lastSeen.set(t.planId, sig);
      let j: { revision?: unknown; planRevision?: unknown };
      try { j = JSON.parse(await fs.readFile(t.file, 'utf8')) as typeof j; } catch { return; } // half-written: look again next time
      if (typeof j.revision !== 'number') return;
      const known = this.lastRevision.get(t.planId);
      this.lastRevision.set(t.planId, j.revision);
      if (known !== undefined && known !== j.revision) {
        this.send({ type: 'plan.changed', planId: t.planId, revision: j.revision, planRevision: typeof j.planRevision === 'number' ? j.planRevision : 0, origin: 'external', at: this.at() });
      }
    } finally { this.checking = false; }
  }

  watch(resolve: () => Promise<WatchTarget | null>): void {
    this.stop();
    this.timer = setInterval(() => { void this.check(resolve).catch(() => undefined); }, this.opts.pollMs ?? 3000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

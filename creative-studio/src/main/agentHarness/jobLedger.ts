export interface AgentJob { id: string; appKey: string; commandId: string }
export interface JobBackend {
  job(id: string): { status: string } | null;
  cancelJob(id: string): boolean;
}

/**
 * Background jobs the Independent AI agent started and has not been seen to finish.
 *
 * IntegrationManager keeps jobs in memory only, so after an interruption or restart a job can be gone while the
 * external program may still be working (or may have finished). An entry therefore stays until the manager itself
 * reports the job in a terminal state; a job that is simply missing stays blocked. That is what stops a resumed
 * task from launching the same long-running command a second time on a guess. The ledger holds ids and command names
 * only (no parameters, paths or credentials) and is persisted in the encrypted task checkpoint.
 */
export class AgentJobLedger {
  private entries: AgentJob[] = [];
  constructor(private readonly backend: JobBackend, private readonly persist?: (jobs: AgentJob[]) => Promise<void>) {}

  snapshot(): AgentJob[] { return this.entries.map((e) => ({ ...e })); }
  restore(jobs: readonly AgentJob[] | undefined): void { this.entries = (jobs ?? []).map((e) => ({ ...e })); }
  clear(): void { this.entries = []; }

  async started(job: AgentJob): Promise<void> {
    this.entries.push({ ...job });
    this.entries = this.entries.slice(-20);
    try { await this.persist?.(this.snapshot()); } catch { /* the in-memory entry still blocks relaunch for this session */ }
  }

  /** Drops entries the manager reports as finished (succeeded, failed or cancelled). Missing or running jobs stay. */
  reconcile(): void {
    this.entries = this.entries.filter((e) => { const j = this.backend.job(e.id); return !j || j.status === 'running'; });
  }

  /** A reason when this command must not be launched again, otherwise undefined. */
  guard(appKey: string, commandId: string): string | undefined {
    this.reconcile();
    const e = this.entries.find((x) => x.appKey === appKey && x.commandId === commandId);
    if (!e) return undefined;
    return this.backend.job(e.id)
      ? `Job ${e.id} for this command is still running.`
      : `Job ${e.id} for this command was started earlier and its status is unknown (jobs are lost when the application restarts).`;
  }

  /** Cancels what is still running (takeover, stop). Returns the ids that were asked to cancel. */
  cancelRunning(): string[] {
    const cancelled: string[] = [];
    for (const e of this.entries) {
      if (this.backend.job(e.id)?.status !== 'running') continue;
      try { if (this.backend.cancelJob(e.id)) cancelled.push(e.id); } catch { /* already finished */ }
    }
    return cancelled;
  }

  /** A new task starts clean, but never forgets a job that is verifiably still running. */
  resetForNewTask(): void {
    this.entries = this.entries.filter((e) => this.backend.job(e.id)?.status === 'running');
  }
}

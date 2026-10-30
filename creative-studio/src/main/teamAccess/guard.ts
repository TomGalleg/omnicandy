// The guard at the point where tools actually run. It asks the access rules (shared/teamAccess.ts) about EVERY call, reading the worker's CURRENT policy each time,
// so switching someone off takes effect at their very next action. The same guard sits in front of the agent harness registry and the Claude panel's tool
// handlers, so the rules and the log are the same whichever AI is working. Telling the AI not to, or hiding a tool, is never the control: this is.
import { consumeGrant, decideChain, makeGrants, type AccessPolicy, type ActivityEntry, type AccessRequest, type ApprovalOffer, type Decision, type Grant, type WorkerRef } from '../../shared/teamAccess';
import { classifyToolCall } from '../../shared/teamToolAccess';

export type { ActivityEntry };
export interface GuardDeps {
  worker: WorkerRef;
  /** The worker's policy and every policy above them (a hired expert's director), read fresh on each call. */
  chain: () => readonly AccessPolicy[] | Promise<readonly AccessPolicy[]>;
  taskId?: () => string | undefined;
  /** The tools this worker's toolbox lists. Anything else is refused, even if their access level would allow it. */
  tools?: readonly string[];
  now?: () => Date;
  /** Shows the owner what is about to happen and returns their answer. With none, anything that needs approval is refused. */
  approve?: (info: { worker: WorkerRef; request: AccessRequest; why: string; offer: ApprovalOffer[] }) => Promise<ApprovalOffer | 'deny'>;
  log?: (e: ActivityEntry) => void | Promise<void>;
  /** Called when a call is refused because the owner switched access off, so the run can be stopped. */
  onRevoked?: () => void;
  newId?: () => string;
}
export type GuardResult = { ok: true; done: (failed: boolean, note?: string) => void } | { ok: false; text: string };

export class AccessGuard {
  private grants: Grant[] = [];
  private n = 0;
  constructor(private readonly d: GuardDeps) {}

  private now() { return this.d.now?.() ?? new Date(); }
  private record(e: Omit<ActivityEntry, 'at' | 'workerId' | 'worker'>) {
    try { void Promise.resolve(this.d.log?.({ at: this.now().toISOString(), workerId: this.d.worker.id, worker: this.d.worker.name, ...e })).catch(() => undefined); } catch { /* a log problem never decides an action */ }
  }

  /** Decides one tool call. When allowed, call `done` after it ran so the log says what happened. */
  async before(tool: string, args: unknown): Promise<GuardResult> {
    const taskId = this.d.taskId?.();
    const req = classifyToolCall(tool, args, taskId);
    const refuse = (verdict: 'ask' | 'deny', why: string, r?: AccessRequest): GuardResult => {
      this.record({ tool, label: r?.label ?? tool, ...(r?.target ? { target: r.target } : {}), ...(taskId ? { taskId } : {}), verdict, why, outcome: 'refused' });
      return { ok: false, text: `Error: Not allowed. ${why}` };
    };
    if (!req) return refuse('deny', 'This tool has not been cleared for AI workers.');
    if (this.d.tools && !this.d.tools.includes(tool)) return refuse('deny', 'This tool is not in this worker\'s toolbox.', req);
    const chain = await this.d.chain();
    let decision: Decision = decideChain(chain, req, { now: this.now(), grants: this.grants });
    if (decision.verdict === 'deny') {
      if (chain.some((p) => p.revoked)) { try { this.d.onRevoked?.(); } catch { /* ignore */ } }
      return refuse('deny', decision.why, req);
    }
    let approvedBy: 'rule' | 'owner' = 'rule';
    if (decision.verdict === 'ask') {
      if (!this.d.approve) return refuse('ask', `${decision.why} It needs your OK, and there is no way to ask yet.`, req);
      let answer: ApprovalOffer | 'deny';
      try { answer = await this.d.approve({ worker: this.d.worker, request: req, why: decision.why, offer: decision.offer }); } catch { answer = 'deny'; }
      if (answer === 'deny' || !decision.offer.includes(answer)) return refuse('ask', 'You said no.', req);
      this.grants = [...this.grants, ...makeGrants(chain, req, answer, this.now(), this.d.newId ?? (() => `grant-${++this.n}-${Date.now().toString(36)}`))];
      // the owner may have switched access off while the question was open: ask the rules again with the new approval
      decision = decideChain(await this.d.chain(), req, { now: this.now(), grants: this.grants });
      if (decision.verdict !== 'allow') return refuse(decision.verdict, decision.why, req);
      approvedBy = 'owner';
    }
    if (decision.verdict === 'allow' && decision.usedGrantId) {
      // one-time approvals are used up by the action they covered; each link in the chain holds its own copy
      const used = this.grants.filter((g) => g.scope === 'once' && g.capability === req.capability && g.kind === req.kind && g.target === req.target && chain.some((p) => p.workerId === g.workerId));
      for (const g of used) this.grants = consumeGrant(this.grants, g.id, this.now());
    }
    return { ok: true, done: (failed, note) => this.record({ tool, label: req.label, ...(req.target ? { target: req.target } : {}), ...(taskId ? { taskId } : {}), verdict: 'allow', why: decision.why, approvedBy, outcome: failed ? 'failed' : 'done', ...(note ? { note: note.slice(0, 200) } : {}) }) };
  }
}

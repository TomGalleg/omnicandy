// The question the owner is asked when a worker needs an OK: who is asking, what exactly, on what, and why it is asking. Nothing here runs the action; the
// answer goes back to the guard, which records it as an approval that names this action, expires, and is used up (see shared/teamAccess.ts).
import type { ApprovalOffer, AccessRequest, WorkerRef } from '../../shared/teamAccess';

export interface BoxOptions { type: 'question'; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: true }
export type ShowBox = (o: BoxOptions) => Promise<{ response: number }>;

const COST = (c: number | undefined) => (c && c > 0 ? ` About $${(c / 100).toFixed(2)}.` : '');

/** The dialog for one question. "No" is always first, the default, and what closing the box means. */
export function approvalBox(info: { worker: WorkerRef; request: AccessRequest; why: string; offer: ApprovalOffer[]; via?: WorkerRef }): { options: BoxOptions; answers: Array<ApprovalOffer | 'deny'> } {
  const r = info.request;
  const answers: Array<ApprovalOffer | 'deny'> = ['deny', 'once', ...(info.offer.includes('task') ? (['task'] as const) : [])];
  const labels = ['No', 'Yes, just this once', 'Yes, for this whole task'];
  return {
    answers,
    options: {
      type: 'question', title: 'Your team is asking', message: `${info.worker.name}${info.via ? ` (through the ${info.via.name})` : ''} wants to: ${r.label}`,
      detail: [r.target ? `On: ${r.target}` : '', `Why you are being asked: ${info.why}${COST(r.costCents)}`, 'The approval covers only this, and runs out soon. You can switch this worker\'s access off at any time.'].filter(Boolean).join('\n'),
      buttons: labels.slice(0, answers.length), defaultId: 0, cancelId: 0, noLink: true,
    },
  };
}

/** Builds the `approve` the guard needs from a function that shows a native message box. Closing the box, or any problem, means No. */
export function nativeApprover(show: ShowBox) {
  return async (info: { worker: WorkerRef; request: AccessRequest; why: string; offer: ApprovalOffer[]; via?: WorkerRef }): Promise<ApprovalOffer | 'deny'> => {
    const { options, answers } = approvalBox(info);
    try { const res = await show(options); return answers[res.response] ?? 'deny'; } catch { return 'deny'; }
  };
}

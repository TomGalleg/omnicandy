import type { EditIntent } from './editIntentJournal';
import type { AgentRecoveryInfo } from '@shared/agentHarness';

/** Present only bounded, explicit metadata already recorded before dispatch.
 * No arguments, paths, document content, or model-generated claims are exposed. */
export function recoveryPresentation(intent: EditIntent | null, unreadable = false): AgentRecoveryInfo | undefined {
  if (unreadable) return { status: 'unreadable', message: 'The encrypted edit journal cannot be read. Editing remains blocked. Preserve the project and journal for review.' };
  if (!intent) return undefined;
  return {
    status: 'unresolved',
    tool: intent.tool,
    command: intent.command,
    startedAt: intent.startedAt,
    ...(intent.expected ? { expected: { kind: intent.expected.kind, layer: intent.expected.layer, rect: [...intent.expected.rect] as [number,number,number,number] } } : {}),
    message: 'The edit may have changed the document. Actual state is not verified. Continue Task must inspect and reconcile it before more editing.',
  };
}

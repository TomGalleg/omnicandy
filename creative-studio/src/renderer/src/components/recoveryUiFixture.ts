import type { AgentRecoveryInfo } from '@shared/agentHarness';

/** Synthetic, renderer-only recovery preview. Never writes a journal, calls an app or alters agent state. */
export type RecoveryFixture = 'off' | 'unresolved' | 'mismatch' | 'matching' | 'unreadable';
const expected = { kind: 'photocraft.shape.edit.rect' as const, layer: 33, rect: [300, 400, 150, 150] as [number,number,number,number] };
export function recoveryUiFixture(kind: RecoveryFixture): { info?: AgentRecoveryInfo; actual: string; explanation: string } {
  if (kind === 'off') return { actual: '', explanation: '' };
  if (kind === 'unreadable') return {
    info: {status:'unreadable',message:'SIMULATION: Journal unreadable; editing must remain blocked.'},
    actual:'Unavailable', explanation:'Read-back cannot be trusted. Do not retry the edit.'
  };
  const actual = kind === 'mismatch' ? [300,400,150,149] : [300,400,150,150];
  return {
    info: {
      status:'unresolved', tool:'app_command', command:'shape.edit', startedAt:'2026-10-21T12:00:00.000Z',
      expected, message:'SIMULATION: An edit may have succeeded despite a lost response. No real command was executed.'
    },
    actual: kind === 'unresolved' ? 'Not inspected' : `Mock shape.info: layer 33, rect [${actual.join(', ')}]`,
    explanation: kind === 'unresolved' ? 'Editing stays blocked until fresh state is checked.' :
      kind === 'matching' ? 'Mock comparison matches. The real engine would require authenticated evidence_verify before releasing its lock.' :
      'Mock comparison differs. Editing must remain blocked; never replay the command blindly.'
  };
}

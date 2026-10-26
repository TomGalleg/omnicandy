import { describe, expect, it } from 'vitest';
import { EMPTY_WORKSPACE } from '@shared/buildSession';
import type { EditWorkspace } from './editWorkspace';
import { BuildSession, describeToolUse, needsApproval } from './devSession';

describe('Build chat approvals', () => {
  it('lets Claude read freely but asks before changing anything', () => {
    for (const t of ['Read', 'Glob', 'Grep']) expect(needsApproval(t)).toBe(false);
    for (const t of ['Edit', 'Write', 'Bash', 'MultiEdit', 'SomethingNew']) expect(needsApproval(t)).toBe(true);
  });
  it('describes a request in one plain line', () => {
    expect(describeToolUse('Bash', { command: 'npm run check' })).toBe('Run: npm run check');
    expect(describeToolUse('Edit', { file_path: 'src/a.ts' })).toBe('Change src/a.ts');
  });
});

describe('BuildSession', () => {
  it('starts empty and says when the source is missing', async () => {
    const seen: unknown[] = [];
    const s = new BuildSession({ workspace: { sourceRoot: async () => null, refresh: async () => undefined, state: () => ({ ...EMPTY_WORKSPACE, state: 'needs-setup' as const }) } as unknown as EditWorkspace, env: async () => ({}), scrub: async (t) => t, emit: (st) => seen.push(st) });
    expect(s.state().items).toEqual([]);
    await s.send('hello');
    expect(s.state().unavailable).toMatch(/Set up editing/);
    expect(s.state().status).toBe('idle');
  });
});

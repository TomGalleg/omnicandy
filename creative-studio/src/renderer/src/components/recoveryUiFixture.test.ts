import { describe, expect, it } from 'vitest';
import { recoveryUiFixture } from './recoveryUiFixture';

describe('development recovery panel fixtures', () => {
  it('does not show synthetic recovery when off', () => {
    expect(recoveryUiFixture('off').info).toBeUndefined();
  });
  it('renders recorded edit intent and unverified status', () => {
    const state = recoveryUiFixture('unresolved');
    expect(state.info?.expected).toEqual({kind:'photocraft.shape.edit.rect',layer:33,rect:[300,400,150,150]});
    expect(state.actual).toBe('Not inspected');
  });
  it('distinguishes matching and mismatching mock readbacks without unlocking anything', () => {
    const good = recoveryUiFixture('matching');
    const bad = recoveryUiFixture('mismatch');
    expect(good.actual).toContain('300, 400, 150, 150');
    expect(bad.actual).toContain('300, 400, 150, 149');
    expect(bad.explanation).toContain('remain blocked');
    expect(good.info?.status).toBe('unresolved');
  });
  it('shows unreadable journal as blocked', () => {
    expect(recoveryUiFixture('unreadable').info?.status).toBe('unreadable');
  });
});

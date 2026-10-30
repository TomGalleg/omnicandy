import { describe, expect, it } from 'vitest';
import { claudeReadyToWork, DESTINATIONS } from './plannerSend';

describe('when OmniCandy\'s own Claude can start work', () => {
  it('is ready when it is installed and signed in', () => {
    expect(claudeReadyToWork({ installed: true, signedIn: true, status: 'idle', billing: { mode: 'signin' } })).toBe(true);
  });

  it('is not ready when it is missing, signed out, or the sign-in has not been checked as failed', () => {
    expect(claudeReadyToWork({ installed: false, signedIn: true })).toBe(false);
    expect(claudeReadyToWork({ installed: true, signedIn: false })).toBe(false);
    expect(claudeReadyToWork({ installed: true, signedIn: null, status: 'signed-out' })).toBe(false);
    expect(claudeReadyToWork(null)).toBe(false);
    expect(claudeReadyToWork(undefined)).toBe(false);
  });

  it('follows the key instead of the sign-in when it is billed to an API key', () => {
    expect(claudeReadyToWork({ installed: false, signedIn: false, billing: { mode: 'api-key', keyReady: true } })).toBe(true);
    expect(claudeReadyToWork({ installed: true, signedIn: true, billing: { mode: 'api-key', keyReady: false } })).toBe(false);
  });

  it('lists OmniCandy\'s Claude first, so it is the first thing offered', () => {
    expect(DESTINATIONS[0]!.id).toBe('createcraft');
  });
});

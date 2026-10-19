import { describe, expect, it } from 'vitest';
import { claudeBilling, claudeEnv } from './claudeEnv';

describe('claudeEnv', () => {
  it('removes an inherited API key and token so the sign-in is used', () => {
    const e = claudeEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'sk-ant-abc', ANTHROPIC_AUTH_TOKEN: 't' });
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(e.PATH).toBe('x');
    expect(e.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('CreateCraft/0.1');
  });

  it('keeps the key only when the user opted in on purpose', () => {
    const e = claudeEnv({ ANTHROPIC_API_KEY: 'sk-ant-abc', CREATECRAFT_USE_ANTHROPIC_API_KEY: '1' });
    expect(e.ANTHROPIC_API_KEY).toBe('sk-ant-abc');
  });

  it('does not touch other variables and ignores an opt-in without a key', () => {
    expect(claudeEnv({ HOME: '/h', CREATECRAFT_USE_ANTHROPIC_API_KEY: 'true' }).HOME).toBe('/h');
  });
});

describe('claudeBilling', () => {
  it('says sign-in when there is no key', () => {
    expect(claudeBilling({})).toEqual({ mode: 'sign-in', keyIgnored: false });
  });
  it('says the sign-in is used and a key was ignored', () => {
    expect(claudeBilling({ ANTHROPIC_API_KEY: 'k' })).toEqual({ mode: 'sign-in', keyIgnored: true });
  });
  it('says api-key only for a deliberate opt-in with a key', () => {
    expect(claudeBilling({ ANTHROPIC_API_KEY: 'k', CREATECRAFT_USE_ANTHROPIC_API_KEY: '1' })).toEqual({ mode: 'api-key', keyIgnored: false });
    expect(claudeBilling({ CREATECRAFT_USE_ANTHROPIC_API_KEY: '1' })).toEqual({ mode: 'sign-in', keyIgnored: false });
  });
});

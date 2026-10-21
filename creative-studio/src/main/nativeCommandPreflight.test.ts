import { describe, expect, it } from 'vitest';
import { preflightNativeCommand } from './nativeCommandPreflight';

const cmd = 'image.adjustments.brightnessContrast';
const detail = JSON.stringify({ id: cmd, params: '{"brightness":-150..150=0,"contrast":-50..100=0,"legacy":bool=false}' });

describe('native shared preflight (not wired to execution)', () => {
  it('validates recognized parameters', () => {
    expect(preflightNativeCommand(detail, cmd, { brightness: 20 }).status).toBe('validated');
  });
  it('rejects demonstrably invalid values', () => {
    expect(preflightNativeCommand(detail, cmd, { brightness: 99999 }).status).toBe('rejected');
    expect(preflightNativeCommand(detail, cmd, { nonexistent: 1 }).status).toBe('rejected');
  });
  it('refuses to claim validation when details are unsupported', () => {
    expect(preflightNativeCommand(undefined, cmd, {}).status).toBe('unavailable');
    expect(preflightNativeCommand('not json', cmd, {}).status).toBe('unavailable');
    expect(preflightNativeCommand(JSON.stringify({id: cmd, params: '{path} | {data: base64, name}'}), cmd, {}).status).toBe('unavailable');
  });
  it('rejects a command-id mismatch', () => {
    expect(preflightNativeCommand(detail, 'another.command', {}).status).toBe('rejected');
  });
  it('does not label unknown supplied parameter types as validated', () => {
    const d = JSON.stringify({ id: 'file.open', params: '{path}' });
    expect(preflightNativeCommand(d, 'file.open', {path:'/tmp/file'}).status).toBe('unavailable');
  });
});

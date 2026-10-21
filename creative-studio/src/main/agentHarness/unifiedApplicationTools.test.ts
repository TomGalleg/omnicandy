import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, tool } from './registry';
import { nativeToolRegistry } from './nativeTools';
import { externalTools } from './externalTools';
import { buildUnifiedApplicationTools } from './unifiedApplicationTools';

vi.mock('./nativeTools', () => ({ nativeToolRegistry: vi.fn() }));
vi.mock('./externalTools', () => ({ externalTools: vi.fn() }));

const empty = z.object({}).strict();
const nativeHandler = vi.fn(async () => 'native result');
const externalHandler = vi.fn(async () => 'external result');
const makeNative = () => new ToolRegistry([
  tool('app_commands', 'Inspect native application commands', empty, nativeHandler),
]);

function setup() {
  vi.mocked(nativeToolRegistry).mockClear();
  vi.mocked(externalTools).mockClear();
  vi.mocked(nativeToolRegistry).mockReturnValue(makeNative());
  vi.mocked(externalTools).mockReturnValue([
    tool('external_commands', 'Inspect adapter commands', empty, externalHandler),
  ]);
  nativeHandler.mockClear();
  externalHandler.mockClear();
}

// These are deliberately unused in the mocked registration functions: no app
// or integration manager is started, and no network/API calls are made.
const controller = {} as Parameters<typeof buildUnifiedApplicationTools>[0];
const store = {} as Parameters<typeof buildUnifiedApplicationTools>[1];
const backend = {} as NonNullable<NonNullable<Parameters<typeof buildUnifiedApplicationTools>[2]>['external']>;

describe('shared application tool composition (offline)', () => {
  it('registers existing native and external tools once, with provider-neutral descriptions', async () => {
    setup();
    const unified = buildUnifiedApplicationTools(controller, store, { external: backend });
    const snapshot = unified.snapshot();
    expect(unified.advertise(snapshot).map(t => t.name)).toEqual(['app_commands', 'external_commands']);
    expect(unified.advertise(snapshot).every(t => !('execute' in t))).toBe(true);
    expect(unified.sourceOf('app_commands')).toBe('native');
    expect(unified.sourceOf('external_commands')).toBe('external');
    expect(await unified.call(snapshot, 'app_commands', {})).toMatchObject({ text: 'native result' });
    expect(await unified.call(snapshot, 'external_commands', {})).toMatchObject({ text: 'external result' });
    expect(nativeHandler).toHaveBeenCalledOnce();
    expect(externalHandler).toHaveBeenCalledOnce();
  });

  it('does not require an external integration to register native tools', () => {
    setup();
    const unified = buildUnifiedApplicationTools(controller, store);
    expect(unified.advertise().map(t => t.name)).toEqual(['app_commands']);
    expect(externalTools).not.toHaveBeenCalled();
  });

  it('rejects collisions with optional tools rather than shadowing an existing controller', () => {
    setup();
    expect(() => buildUnifiedApplicationTools(controller, store, {
      additional: [tool('app_commands', 'Conflicting definition', empty, async () => 'override')],
    })).toThrow('Duplicate tool name: app_commands');
  });

  it('rejects unadvertised commands without calling application handlers', async () => {
    setup();
    const unified = buildUnifiedApplicationTools(controller, store);
    const result = await unified.call(unified.snapshot(), 'filesystem_write', {});
    expect(result.isError).toBe(true);
    expect(nativeHandler).not.toHaveBeenCalled();
  });
});

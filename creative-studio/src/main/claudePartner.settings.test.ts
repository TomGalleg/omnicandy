import { describe, expect, it } from 'vitest';
import { externalRunSettings } from './claudePartner';
import { validateParams } from './integrations/manager';
import { BLENDER_MANIFEST } from './integrations/adapters/blender';

// Claude's external_run used to accept only short text, so it could never pass the Blender scene spec or a script (JSON settings).
describe('external_run settings for structured commands', () => {
  const spec = { batch_id: 'castle-1', objects: Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, kind: 'box', loc: [i, 0, 0], material: { color: '#aabbcc' } })) };
  it('accepts a scene spec as an object or as long JSON text, and still bounds everything else', () => {
    expect(externalRunSettings.safeParse({ file_name: 'a.blend', spec }).success).toBe(true);
    expect(externalRunSettings.safeParse({ file_name: 'a.blend', spec: JSON.stringify(spec) }).success).toBe(true);
    expect(externalRunSettings.safeParse({ cube_size: 2, flag: true }).success).toBe(true);
    expect(externalRunSettings.safeParse({ spec: 'x'.repeat(64001) }).success).toBe(false);
    expect(externalRunSettings.safeParse({ spec: null }).success).toBe(false);
  });
  it('is still enforced per command by the manager: only a json parameter takes long or structured values', () => {
    const build = BLENDER_MANIFEST.commands.find((c) => c.id === 'scene.build')!;
    expect(typeof validateParams(build, { file_name: 'a.blend', spec })).toBe('object');
    const add = BLENDER_MANIFEST.commands.find((c) => c.id === 'object.add')!;
    expect(validateParams(add, { file_name: 'a.blend', type: 'cube', name: 'x'.repeat(600) })).toMatch(/must be text \(up to 512 characters\)/);
    expect(validateParams(add, { file_name: 'a.blend', type: { nested: true } as never })).toMatch(/must be text/);
  });
});

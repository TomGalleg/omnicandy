import { describe, expect, it } from 'vitest';
import { checkAppCommand } from './appCommands';

describe('EffectCraft property tools', () => {
  it('accepts property paths and keyframes', () => {
    expect(checkAppCommand('tool:set_property', { layer: '#2', path: 'transform/position', value: [200, 540], time: 1 }).ok).toBe(true);
    expect(checkAppCommand('tool:add_keyframe', { layer: 'Clouds', path: 'effects/#1/blurriness', value: 5, time: 0 }).ok).toBe(true);
    expect(checkAppCommand('tool:get_property', { layer: 3, path: '@57' }).ok).toBe(true);
  });
  it('still rejects real file paths', () => {
    expect(checkAppCommand('tool:set_property', { layer: 1, path: 'C:/secret/x.png', value: 1 }).ok).toBe(false);
    expect(checkAppCommand('tool:set_property', { layer: 1, path: '../x', value: 1 }).ok).toBe(false);
    expect(checkAppCommand('tool:add_effect', { layer: 1, effect: 'Glow', file: 'a/b.png' }).ok).toBe(false);
  });
});

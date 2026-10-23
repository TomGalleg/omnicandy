// What Claude's panel is shown about external apps must fit in one answer. All apps' full command lists at once grew to ~97,000 characters
// (too big to read, so Claude could not even see Unreal's commands); now the list is short and one app's commands are asked for by name.
import { describe, expect, it } from 'vitest';
import { describeAppForModel } from '../agentHarness/externalTools';
import { BLENDER_MANIFEST } from './adapters/blender';
import { RESOLVE_MANIFEST } from './adapters/resolve';
import { UNREAL_MANIFEST } from './adapters/unreal';

const asApp = (m: { name: string; commands: Array<{ id: string }> }, key: string) => ({ name: m.name, key, status: 'connected', commands: m.commands as never });

describe('what the AI is shown about external apps', () => {
  it('shows one app\'s commands whole and within what a model can read', () => {
    for (const m of [BLENDER_MANIFEST, UNREAL_MANIFEST, RESOLVE_MANIFEST]) {
      const text = describeAppForModel(asApp(m, `key-${m.id}`));
      expect(text.length, m.id).toBeLessThan(30_000);
      for (const c of m.commands) expect(text, `${m.id} ${c.id}`).toContain(c.id);
    }
  });
  it('keeps the list of every app (names, status, command ids only) short however many commands exist', () => {
    const brief = [BLENDER_MANIFEST, UNREAL_MANIFEST, RESOLVE_MANIFEST].map((m) => ({ app_key: `key-${m.id}`, name: m.name, status: 'connected', detail: '', adapter: m.id, maturity: m.maturity, commands: m.commands.map((c) => c.id) }));
    expect(JSON.stringify(brief, null, 2).length).toBeLessThan(6_000);
  });
  it('puts the commands to reach for first and says how to run one from Claude\'s panel', () => {
    const text = describeAppForModel(asApp(BLENDER_MANIFEST, 'k'));
    expect(text).toMatch(/run one with external_run \{app, command, settings\}/);
    expect(text.indexOf('scene.build')).toBeLessThan(text.indexOf('object.add'));
  });
});

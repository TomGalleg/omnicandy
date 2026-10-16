// The builder pipeline against the FreeCAD enclosure blueprint (authored by Claude, fixtures/ai-generated) and a set of
// deliberately bad blueprints. The simulated stage uses a MOCK program; nothing here talks to real FreeCAD.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBlueprint, type Blueprint } from './blueprint';
import { buildCandidate } from './pipeline';

const fixture = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'ai-generated', 'freecad-enclosure.blueprint.json');
const load = (): Blueprint => parseBlueprint(JSON.parse(fs.readFileSync(fixture, 'utf8')));
const opts = { version: '1.0.0', createdAt: '2026-01-01T00:00:00Z', author: { kind: 'scripted' as const }, projectId: 't1' };
const mut = (f: (b: Blueprint) => void): Blueprint => { const b = load(); f(b); return b; };

describe('builder pipeline: FreeCAD enclosure blueprint', () => {
  it('builds a package that passes static, security and simulated stages', async () => {
    const r = await buildCandidate(load(), opts);
    const detail = r.reports.flatMap((x) => x.checks.filter((c) => c.state === 'failed').map((c) => `${x.stage}/${c.id}: ${c.detail}`));
    expect(detail).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.reports.map((x) => x.stage)).toEqual(['static', 'security', 'simulated']);
    expect(r.reports[2]!.mock).toBe(true);
    expect(r.bytes!.length).toBeGreaterThan(1000);
    const m = JSON.parse(r.files!.get('adapter.json')!.toString('utf8'));
    expect(m.id).toBe('custom.freecad');
    expect(m.publisher.name).toBe('Created on this computer (AI-generated)');
    expect(m.commands.map((c: { id: string }) => c.id)).toEqual(['app.health', 'enclosure.create', 'enclosure.measure']);
    expect(m.commands[2].permissions).toContain('read-project');
  }, 180_000);

  const refused: Array<[string, (b: Blueprint) => void, RegExp]> = [
    ['os import', (b) => { b.commands[0]!.python!.source = b.commands[0]!.python!.source.replace('import Part', 'import Part\nimport os'); }, /import of 'os'/],
    ['eval call', (b) => { b.commands[0]!.python!.source = b.commands[0]!.python!.source.replace('outer = Part', 'eval("1")\n    outer = Part'); }, /eval/],
    ['dunder escape', (b) => { b.commands[0]!.python!.source = b.commands[0]!.python!.source.replace('outer = Part', 'x = H.__class__\n    outer = Part'); }, /__class__|double underscores/],
    ['absolute path', (b) => { b.commands[0]!.python!.source = b.commands[0]!.python!.source.replace('outer = Part', 'x = "C:\\\\Windows\\\\x"\n    outer = Part'); }, /file path/],
    ['undocumented API', (b) => { b.commands[0]!.python!.source = b.commands[0]!.python!.source.replace('shell = outer.cut(inner)', 'shell = outer.cut(inner)\n    shell = shell.removeSplitter()'); }, /removeSplitter|without documenting/],
    ['network permission', (b) => { b.commands[0]!.permissions.push('network'); }, /never given|permissions/],
    ['source not in research', (b) => { b.commands[0]!.docRefs[0]!.url = 'https://example.org/x'; }, /not one of the research sources/],
    ['no documentation consulted', (b) => { b.research.sourcesConsulted = false; }, /No documentation was consulted/],
    ['insufficient information', (b) => { b.research.insufficient = 'Only a product page was found.'; }, /Not enough trustworthy/],
    ['reserved health id', (b) => { b.commands[0]!.id = 'app.health'; }, /app\.health/],
    ['bad example', (b) => { b.commands[0]!.mock.params.width = 5; }, /at least 10/],
  ];
  for (const [name, change, re] of refused) {
    it(`refuses: ${name}`, async () => {
      const r = await buildCandidate(mut(change), opts, { simulate: false });
      expect(r.safe).toBe(false);
      expect(r.bytes).toBeNull();
      const text = r.reports.flatMap((x) => x.checks.filter((c) => c.state === 'failed').map((c) => c.detail)).join(' | ');
      expect(text).toMatch(re);
    }, 60_000);
  }
});

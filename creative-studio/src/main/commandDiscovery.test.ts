import { describe, expect, it } from 'vitest';
import { formatDiscoveredCommands, parsePlainCommandCatalog, compactParameterHints } from './commandDiscovery';

describe('engine command catalog formatting', () => {
  it('filters a JSON command list without changing ids', () => {
    const result = formatDiscoveredCommands([{ id: 'type.create', params: { text: 'string' }, label: 'Add text' }, { id: 'shape.ellipse', label: 'Ellipse' }], 'type', 'PhotoCraft');
    expect(result).toContain('type.create');
    expect(result).not.toContain('shape.ellipse');
  });
  it('handles wrapped MCP command catalogs', () => {
    expect(formatDiscoveredCommands({ commands: [{ id: 'timeline.place' }] }, '', 'FilmCraft')).toContain('timeline.place');
  });
  it('rejects malformed catalogs without inventing commands', () => {
    expect(() => formatDiscoveredCommands({ result: 'unknown' })).toThrow(/unsupported/);
  });
});


describe('multi-line catalog and pagination', () => {
  it('counts paired description lines as one command and keeps descriptions searchable', () => {
    const plain = 'shape.circle\n  Draw a circle\nshape.rectangle\n  Draw a rectangle';
    const rows = parsePlainCommandCatalog(plain);
    expect(rows).toHaveLength(2);
    expect(formatDiscoveredCommands(rows, 'rectangle', 'LightCraft')).toContain('shape.rectangle');
    expect(formatDiscoveredCommands(rows, 'rectangle', 'LightCraft')).not.toContain('shape.circle');
  });
  it('finds commands after the first 80 and paginates filtered results', () => {
    const rows = Array.from({ length: 185 }, (_, i) => ({ id: `shape.command${i}` }));
    const second = formatDiscoveredCommands(rows, 'page:2', 'GridCraft');
    expect(second).toContain('shape.command80');
    expect(second).not.toContain('shape.command0\n');
    expect(second).toContain('page 2/3');
    expect(formatDiscoveredCommands(rows, 'page:3', 'GridCraft')).toContain('shape.command184');
  });
  it('rejects out of range pages without returning unrelated commands', () => {
    expect(formatDiscoveredCommands([{ id: 'a' }], 'page:999', 'FigCraft')).toContain('does not exist');
  });
});

describe('plain catalog parsing regressions', () => {
  it('accepts an id followed by a single space and a description (LightCraft)', () => {
    const rows = parsePlainCommandCatalog('edit.undo   Undo\n                params: {}\nlibrary.emptyRecentlyDeleted Empty Recently Deleted\n                params: {} → {deleted}\nbeforeAfter.copyAfterToBefore Copy After\'s Settings to Before\n                params: {}');
    expect(rows.map((r) => r.id)).toEqual(['edit.undo', 'library.emptyRecentlyDeleted', 'beforeAfter.copyAfterToBefore']);
    expect(rows[1]?.label).toContain('Empty Recently Deleted');
  });
  it('accepts ids with a trailing * marker and keeps the executable id (FigCraft)', () => {
    const rows = parsePlainCommandCatalog('node.create*  Create layer\n    {type: rectangle, x?, y?}\nframe.presets  List frame presets\n    {}\nshape.rectangle*  Rectangle\n    {x, y}');
    expect(rows.map((r) => r.id)).toEqual(['node.create', 'frame.presets', 'shape.rectangle']);
    expect(rows[0]?.label).toContain('Create layer');
  });
  it('never treats indented description or parameter lines as commands', () => {
    const rows = parsePlainCommandCatalog('a.one  First\n  Looks like an id\n  params: {}\na.two  Second\n    word  with gap');
    expect(rows.map((r) => r.id)).toEqual(['a.one', 'a.two']);
  });
});

describe('token-efficient schema inspection', () => {
  it('lists identifiers compactly and inspects untruncated ranges on exact match', () => {
    const rows = [{ id: 'shape.blur', params: { radius: { type: 'number', min: 5, max: 200 }, options: 'x'.repeat(400) } }];
    const summary = formatDiscoveredCommands(rows, '', 'PhotoCraft');
    expect(summary).toContain('inspect exact id');
    expect(summary).not.toContain('min');
    const detail = formatDiscoveredCommands(rows, 'shape.blur', 'PhotoCraft');
    expect(detail).toContain('"min":5');
    expect(detail).toContain('"max":200');
    expect(detail).toContain('x'.repeat(400));
  });
  it('never silently truncates a very large schema', () => {
    expect(formatDiscoveredCommands([{ id: 'huge', params: { text: 'x'.repeat(9000) } }], 'huge'))
      .toMatch(/too large/);
  });
});


describe('compact schema hints', () => {
  it('shows small type/range hints without leaking long descriptions', () => {
    const params = { type: 'object', required: ['radius'], properties: { radius: { type: 'number', minimum: 5, maximum: 200, description: 'x'.repeat(2000) }, mode: { type: 'string', enum: ['soft','hard'] } } };
    const text = formatDiscoveredCommands([{id:'shape.blur',params}], 'blur');
    expect(text).toContain('radius!:number(5..200)');
    expect(text).toContain('mode?:string{soft|hard}');
    expect(text).not.toContain('x'.repeat(100));
    expect(compactParameterHints(params).length).toBeLessThanOrEqual(180);
  });
});

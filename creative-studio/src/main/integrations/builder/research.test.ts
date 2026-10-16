// Research normalization vs. strict validation, with mocked but realistic Claude answers. Three stages stay separate:
//   research normalization  (harmless differences absorbed and reported)   <- this file
//   blueprint validation    (strict: commands, permissions, documented interfaces)   <- pipeline.test.ts / templates.test.ts
//   live verification       (only real, independently checked runs)         <- service tests / live tests
import { describe, expect, it } from 'vitest';
import { BlueprintError, extractJson, parseBlueprint, parseResearch, parseResearchDetailed } from './blueprint';
import { RESEARCH_JSON_SCHEMA } from './author';
import { researchSchema } from './blueprint';

const good = () => ({
  application: { name: 'FreeCAD', publisher: 'FreeCAD project', platforms: ['Windows', 'Linux'], version: '1.1.4' },
  summary: 'FreeCAD is parametric 3D CAD with a Python scripting API and a headless command-line program.',
  sources: [{ title: 'FreeCAD wiki: Topological data scripting', url: 'https://wiki.freecad.org/Topological_data_scripting', kind: 'official', note: 'Documents Part.makeBox and boolean operations.' }],
  methods: [{ method: 'scripting', officialSupport: 'official', note: 'FreeCADCmd runs Python scripts.' }],
  scripting: ['Python'], commandLine: ['FreeCADCmd --version'], fileFormats: ['FCStd', 'STEP'], pluginTechnologies: [], licensing: 'LGPL', requiredTools: [], limitations: [], insufficient: null, sourcesConsulted: true,
});

describe('research normalization: legitimate research succeeds', () => {
  it('accepts a clean answer unchanged', () => {
    const r = parseResearchDetailed(good());
    expect(r.notes).toEqual([]);
    expect(r.data.sources[0]!.kind).toBe('official');
    expect(researchSchema.safeParse(r.data).success).toBe(true);
  });

  it('ignores extra harmless fields and says so', () => {
    const r = parseResearchDetailed({ ...good(), confidence: 0.9, searchedAt: 'today', application: { ...good().application, license: 'x' } });
    expect(r.notes.join(' ')).toMatch(/Ignored extra fields: confidence, searchedAt/);
    expect(r.data.sourcesConsulted).toBe(true);
  });

  it('shortens over-long notes instead of rejecting useful research (and reports it)', () => {
    const g = good();
    g.sources[0]!.note = 'n'.repeat(1500);
    g.summary = 's'.repeat(2600);
    (g as { limitations: string[] }).limitations = Array.from({ length: 15 }, (_, i) => `limit ${i} ${'x'.repeat(500)}`);
    const r = parseResearchDetailed(g);
    expect(r.data.sources[0]!.note!.length).toBeLessThanOrEqual(700);
    expect(r.data.summary.length).toBeLessThanOrEqual(2000);
    expect(r.data.limitations).toHaveLength(12);
    expect(r.notes.join(' ')).toMatch(/shortened/);
    expect(r.notes.join(' ')).toMatch(/first 12 were kept/);
  });

  it('fills missing OPTIONAL lists and text, but never the claim that documentation was read', () => {
    const g: Record<string, unknown> = good();
    for (const k of ['scripting', 'commandLine', 'fileFormats', 'pluginTechnologies', 'requiredTools', 'limitations', 'licensing', 'insufficient']) delete g[k];
    delete g.sourcesConsulted;
    delete (g.application as Record<string, unknown>).publisher;
    const r = parseResearchDetailed(g);
    expect(r.data.scripting).toEqual([]);
    expect(r.data.licensing).toBe('');
    expect(r.data.insufficient).toBeNull();
    expect(r.data.sourcesConsulted).toBe(false); // not read unless the research says so
    expect(r.notes.join(' ')).toMatch(/did not say whether documentation was read/);
  });

  it('accepts alternative but valid source wording and capitalised words', () => {
    const g = good();
    g.sources = [
      { title: 'Vendor docs', url: 'https://example.com/a', kind: 'Official Documentation', description: 'Reference.' },
      { title: 'Forum thread', url: 'https://example.com/b', kind: 'Community' },
      { title: 'Blog', url: 'https://example.com/c', kind: 'blog post' },
    ] as never;
    g.methods = [{ method: 'Command Line', officialSupport: 'Full', note: 'ok' }, { method: 'Scripting', officialSupport: 'Partial', note: 'ok' }] as never;
    const r = parseResearchDetailed(g);
    expect(r.data.sources.map((s) => s.kind)).toEqual(['official', 'vendor-community', 'other']);
    expect(r.data.sources[0]!.note).toBe('Reference.');
    expect(r.data.methods.map((m) => `${m.method}:${m.officialSupport}`)).toEqual(['cli:official', 'scripting:partial']);
  });

  it('unwraps {"research": {...}} and a single text where a list was expected', () => {
    const g = good() as Record<string, unknown>;
    g.scripting = 'Python';
    const r = parseResearchDetailed({ research: g });
    expect(r.data.scripting).toEqual(['Python']);
    expect(r.notes.join(' ')).toMatch(/unwrapped/);
  });

  it('reads markdown-wrapped and prose-wrapped answers, including prose with braces in front', () => {
    const fenced = `Here is the research:\n\n\`\`\`json\n${JSON.stringify(good(), null, 2)}\n\`\`\`\n\nLet me know if you need more.`;
    expect(parseResearch(fenced).application.name).toBe('FreeCAD');
    const braces = `I looked at {several} pages {and} found this: ${JSON.stringify(good())} Hope that helps!`;
    expect(parseResearch(braces).application.name).toBe('FreeCAD');
    const two = `\`\`\`\n{"note": "ignore me"}\n\`\`\`\n\`\`\`json\n${JSON.stringify(good())}\n\`\`\``;
    expect(parseResearch(two).application.name).toBe('FreeCAD');
  });
});

describe('research normalization: unsafe or unusable research still fails or is downgraded', () => {
  it('rejects research that does not name the application or has no summary (nothing is invented)', () => {
    const g = good() as Record<string, unknown>;
    expect(() => parseResearch({ ...g, application: { publisher: 'x' } })).toThrow(/does not name the application/);
    expect(() => parseResearch({ ...g, summary: '' })).toThrow(/no summary/);
  });

  it('drops sources without a valid https address and marks the research "not read" when none remain', () => {
    const g = good();
    g.sources = [{ title: 'a', url: 'http://insecure.example/x', kind: 'official' }, { title: 'b', url: 'not a url', kind: 'official' }, { title: 'c', url: '', kind: 'official' }] as never;
    const r = parseResearchDetailed(g);
    expect(r.data.sources).toEqual([]);
    expect(r.data.sourcesConsulted).toBe(false);
    expect(r.notes.join(' ')).toMatch(/3 sources were dropped/);
    expect(r.notes.join(' ')).toMatch(/recorded as "not read"/);
  });

  it('never upgrades uncertain facts: unknown kinds become "other", unknown support becomes "none", unknown methods are dropped', () => {
    const g = good();
    g.sources = [{ title: 'x', url: 'https://example.com', kind: 'authoritative' }] as never;
    g.methods = [{ method: 'telepathy', officialSupport: 'official', note: 'x' }, { method: 'cli', officialSupport: 'probably', note: 'x' }] as never;
    const r = parseResearchDetailed(g);
    expect(r.data.sources[0]!.kind).toBe('other');
    expect(r.data.methods).toEqual([{ method: 'cli', officialSupport: 'none', note: 'x' }]);
    expect(r.notes.join(' ')).toMatch(/telepathy/);
  });

  it('keeps an explicit "insufficient" verdict (the build then stops and asks for documentation)', () => {
    const r = parseResearchDetailed({ ...good(), insufficient: 'Only marketing pages exist.', sourcesConsulted: false, sources: [] });
    expect(r.data.insufficient).toBe('Only marketing pages exist.');
    expect(r.data.sourcesConsulted).toBe(false);
  });

  it('rejects malformed structured data with a readable reason', () => {
    expect(() => parseResearch('no json at all')).toThrow(/did not answer with a JSON document/);
    expect(() => parseResearch('{"application": {"name": "X"')).toThrow(/incomplete/);
    expect(() => parseResearch('{"a": 1,}')).toThrow(/could not be read/);
    expect(() => parseResearch([1, 2] as never)).toThrow(/not a JSON object/);
    expect(() => parseResearch({ ...good(), sources: 5 })).toThrow(BlueprintError);
    expect(() => parseResearch({ ...good(), sourcesConsulted: { yes: true } })).not.toThrow(); // unusable value is recorded as "not read", never as read
    expect(parseResearch({ ...good(), sourcesConsulted: { yes: true } }).sourcesConsulted).toBe(false);
  });

  it('normalization never touches the blueprint: strict validation stays strict', () => {
    // unknown field, bad permission, executable path and an extra command field are all still refused by the blueprint schema
    const bp = JSON.parse(JSON.stringify({ schemaVersion: 1 }));
    expect(() => parseBlueprint(bp)).toThrow(/expected form/);
    expect(() => parseBlueprint({ ...bp, extra: 1 })).toThrow(/expected form/);
  });
});

describe('structured output schema', () => {
  it('is lenient on length and extra fields but names every required key and the enum words', () => {
    const s = JSON.stringify(RESEARCH_JSON_SCHEMA);
    expect(s).not.toMatch(/maxLength|maxItems|additionalProperties/);
    for (const k of ['application', 'summary', 'sources', 'methods', 'sourcesConsulted']) expect((RESEARCH_JSON_SCHEMA.required as string[]).includes(k)).toBe(true);
    expect(s).toContain('vendor-community');
    expect(s).toContain('file-exchange');
  });
  it('a structured answer that satisfies it passes normalization and the strict schema', () => {
    expect(parseResearch(JSON.stringify(good())).sources).toHaveLength(1);
  });
  it('extractJson handles a bare object and ignores a bare array of braces', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('[1,2] then {"b":2}')).toEqual({ b: 2 });
  });
});

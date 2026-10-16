// The other templates (file-exchange, add-in source), the Python scan on its own, the research/blueprint parsers, and tamper checks.
// Blueprints here are TEST DATA, not claims about real software.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePackage, readPackageSource } from '../packageFormat';
import { writeZip } from '../zip';
import { extractJson, parseBlueprint, parseResearch, type Blueprint } from './blueprint';
import { guardPython, lexicalFindings } from './pyguard';
import { buildCandidate } from './pipeline';
import { FRAMEWORK_FACTS, generatePrompt, ScriptedAuthor } from './author';
import { PYTHON_HOSTS } from './hosts';

const fx = (n: string): Blueprint => parseBlueprint(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'ai-generated', n), 'utf8')));
const opts = { version: '1.0.0', createdAt: '2026-01-01T00:00:00Z', author: { kind: 'scripted' as const }, projectId: 't' };

function fileBlueprint(): Blueprint {
  const b = fx('imagemagick.blueprint.json');
  b.application = { ...b.application, name: 'Test Plotter', exeNames: ['plotter.exe'], displayNames: ['Test Plotter'] };
  b.decision = { ...b.decision, template: 'file-exchange', methods: ['file-exchange'] };
  delete b.cli;
  b.commands = [{
    id: 'plot.square', label: 'Write a square', description: 'Writes an SVG square for the plotter to import.',
    params: { name: { type: 'string', description: 'File name.', required: true }, side: { type: 'number', description: 'Side in mm.', required: true, min: 1, max: 500 }, label: { type: 'string', description: 'Caption.', default: 'x' } },
    permissions: ['write-files'], docRefs: [{ symbol: 'SVG rect element', url: 'https://imagemagick.org/command-line-options/' }],
    file: { extension: '.svg', nameParam: 'name', template: '<svg xmlns="http://www.w3.org/2000/svg" width="{side}" height="{side}"><rect width="{side}" height="{side}"/><text>{label}</text></svg>', check: { kind: 'xml' } },
    mock: { params: { name: 'sq', side: 20, label: 'a<b' } },
  }];
  return b;
}

function pluginBlueprint(content: string, tech: 'dotnet-addin' | 'uxp' = 'uxp'): Blueprint {
  const b = fx('imagemagick.blueprint.json');
  b.application = { ...b.application, name: 'Test Paint', exeNames: ['paint.exe'], displayNames: ['Test Paint'] };
  b.decision = { ...b.decision, type: 'hybrid', template: tech === 'uxp' ? 'uxp-plugin' : 'dotnet-addin', methods: ['api'], hostProfile: 'adobe.photoshop' };
  delete b.cli;
  b.commands = [{
    id: 'doc.describe', label: 'Describe the open document', description: 'Reads the name of the open document.', params: {}, permissions: ['read-project'],
    docRefs: [{ symbol: 'app.activeDocument', url: 'https://imagemagick.org/identify/' }], plugin: { capability: 'doc.describe' }, mock: { params: {} },
  }];
  b.plugin = { technology: tech, files: [{ path: tech === 'uxp' ? 'index.js' : 'Plugin.cs', content }], capabilities: [{ id: 'doc.describe', permissions: ['read-project'] }] };
  return b;
}

describe('file-exchange template', () => {
  it('builds, escapes settings for the file format and passes the simulated run', async () => {
    const r = await buildCandidate(fileBlueprint(), opts);
    expect(r.reports.flatMap((x) => x.checks.filter((c) => c.state === 'failed').map((c) => `${x.stage}/${c.id}: ${c.detail}`))).toEqual([]);
    expect(r.passed).toBe(true);
    const main = r.files!.get('main.js')!.toString('utf8');
    expect(main).toContain('xmlEscape');
    expect(r.assembled.manifest.application).toMatchObject({ exeNames: ['plotter.exe'] });
  }, 120_000);

  it('refuses a file template that looks like a script', async () => {
    const b = fileBlueprint();
    b.commands[0]!.file!.template = '<svg><script>alert(1)</script></svg>';
    const r = await buildCandidate(b, opts, { simulate: false });
    expect(r.safe).toBe(false);
    expect(r.reports[1]!.checks.find((c) => c.id === 'ai-code')!.detail).toMatch(/script-like/);
  });
});

describe('add-in templates (source for review only)', () => {
  it('lays out clean UXP and C# source, builds no package, and says nothing was compiled', async () => {
    for (const [tech, code] of [['uxp', 'const { app } = require("photoshop"); exports.describe = () => app.activeDocument.name;'], ['dotnet-addin', 'namespace T { public class P { public string Name() { return "x"; } } }']] as const) {
      const r = await buildCandidate(pluginBlueprint(code, tech), opts);
      expect(r.safe).toBe(true);
      expect(r.bytes).toBeNull();
      expect(r.assembled.sourceOnly).toBe(true);
      expect([...r.assembled.pluginSource!.keys()]).toContain('plugin-src/bridge-contract.json');
      expect(r.reports[0]!.checks.find((c) => c.id === 'compile')!.state).toBe('skipped');
      expect(r.reports[1]!.checks.find((c) => c.id === 'integrity')!.state).toBe('warning');
      expect(r.reports.some((x) => x.stage === 'simulated')).toBe(false);
    }
  });
  it('refuses add-in source that starts processes, uses the network or deletes files', async () => {
    for (const [tech, code, re] of [
      ['uxp', 'fetch("http://x"); require("child_process")', /imports process|network/],
      ['dotnet-addin', 'class P { void M() { System.Diagnostics.Process.Start("cmd"); File.Delete("x"); new HttpClient(); } }', /starts processes|deletes files|network/],
    ] as const) {
      const r = await buildCandidate(pluginBlueprint(code, tech), opts);
      expect(r.safe).toBe(false);
      expect(r.reports[1]!.checks.filter((c) => c.state === 'failed').map((c) => c.detail).join(' ')).toMatch(re);
    }
  });
  it('refuses permissions the template never grants and unknown host profiles', async () => {
    const b = pluginBlueprint('exports.x = 1;');
    b.plugin!.capabilities[0]!.permissions = ['network'];
    expect((await buildCandidate(b, opts)).safe).toBe(false);
    const c = pluginBlueprint('exports.x = 1;');
    c.decision.hostProfile = 'made.up';
    const r = await buildCandidate(c, opts);
    expect(r.reports[1]!.checks.find((x) => x.id === 'destination')!.state).toBe('failed');
  });
});

describe('python scan (text layer, always on)', () => {
  const run = (text: string) => lexicalFindings({ name: 'x#run', kind: 'run', text }, PYTHON_HOSTS.freecad.hostModules);
  const wrap = (body: string) => `import FreeCAD\n\n\ndef run(P, H):\n    ${body}\n    return {}\n`;
  const bad: Array<[string, string, RegExp]> = [
    ['os import', 'import os\n\n\ndef run(P, H):\n    return {}\n', /os/],
    ['from subprocess', 'from subprocess import run as r\n\n\ndef run(P, H):\n    return {}\n', /subprocess/],
    ['exec', wrap('exec("1")'), /exec/],
    ['open()', wrap('open("x")'), /open/],
    ['getattr escape', wrap('getattr(H, "x")'), /getattr/],
    ['dunder', wrap('x = H.__dict__'), /double underscores/],
    ['class', 'class A:\n    pass\n\n\ndef run(P, H):\n    return {}\n', /classes/],
    ['url', wrap('x = "http://evil.example/x"'), /file path or address/],
    ['wrong signature', 'def go(P, H):\n    return {}\n', /def run\(P, H\)/],
    ['system attr', wrap('FreeCAD.system("x")'), /\.system/],
  ];
  for (const [name, code, re] of bad) it(`flags ${name}`, () => { const f = run(code); expect(f.ok).toBe(false); expect(f.problems.join(' ')).toMatch(re); });
  it('accepts plain computation with documented host calls and helpers', () => {
    const f = run(wrap('s = FreeCAD.Vector(1, 2, 3)\n    p = H.new_output("a", ".FCStd")\n    H.check(True, "ok")'));
    expect(f.ok).toBe(true);
    expect(f.usesNewOutput).toBe(true);
  });
  it('the syntax-tree layer agrees and also catches syntax errors and top-level code', async () => {
    const r = await guardPython([
      { name: 'a#run', kind: 'run', text: wrap('x = (') },
      { name: 'b#run', kind: 'run', text: 'import FreeCAD\nprint(1)\n\n\ndef run(P, H):\n    return {}\n' },
      { name: 'c#run', kind: 'run', text: wrap('s = FreeCAD.Vector(1, 2, 3)') },
    ], PYTHON_HOSTS.freecad.hostModules);
    if (r.engine === 'python-ast') {
      expect(r.findings[0]!.problems.join(' ')).toMatch(/syntax error/);
      expect(r.findings[1]!.ok).toBe(false);
      expect(r.findings[2]!.ok).toBe(true);
      expect(r.findings[2]!.moduleSymbols).toContain('FreeCAD.Vector');
    }
  });
});

describe('parsers and prompts', () => {
  it('extracts JSON from fences, prose and braces inside strings', () => {
    expect(extractJson('Sure!\n```json\n{"a": "x}y", "b": [1]}\n```\nDone.')).toEqual({ a: 'x}y', b: [1] });
    expect(() => extractJson('no json here')).toThrow(/JSON/);
    expect(() => extractJson('{"a": ')).toThrow(/incomplete/);
  });
  it('rejects unknown fields and malformed research or blueprints with readable problems', () => {
    expect(() => parseResearch({ nope: 1 })).toThrow(/expected form/);
    const b = JSON.parse(JSON.stringify(fx('imagemagick.blueprint.json')));
    b.commands[0].runShell = 'rm -rf /';
    expect(() => parseBlueprint(b)).toThrow(/expected form/);
    b.commands[0].runShell = undefined;
    b.commands[0].python = { source: 'x', verifySource: 'y', outputExtensions: ['.exe;'] };
    expect(() => parseBlueprint(b)).toThrow();
  });
  it('the generation prompt carries the framework rules and no secrets; a scripted author never claims to be Claude', async () => {
    const research = fx('imagemagick.blueprint.json').research;
    const p = generatePrompt({ appName: 'X', docs: [] }, research);
    expect(FRAMEWORK_FACTS).toMatch(/NEVER use UI automation/);
    expect(FRAMEWORK_FACTS).toMatch(/Never network, launch or ui-automation/);
    expect(p).toMatch(/not installed on this PC/);
    const out = await new ScriptedAuthor({ blueprint: fx('imagemagick.blueprint.json'), note: 'n' }).generate();
    expect(out.author.kind).toBe('scripted');
    expect(out.usage.costUsd).toBe(0);
  });
});

describe('tamper checks on a built package', () => {
  it('a changed generated script or connector no longer matches the manifest', async () => {
    const r = await buildCandidate(fx('freecad-enclosure.blueprint.json'), opts, { simulate: false });
    const files = new Map(r.files!);
    expect(parsePackage(files).problems).toEqual([]);
    const evil = new Map(files);
    evil.set('job_body.py', Buffer.from(`${files.get('job_body.py')!.toString('utf8')}\nimport os\n`));
    expect(parsePackage(evil).problems.join(' ')).toMatch(/job_body\.py.*SHA-256/);
    const evil2 = new Map(files);
    evil2.set('main.js', Buffer.from(`${files.get('main.js')!.toString('utf8')}\nrequire('child_process');`));
    expect(parsePackage(evil2).problems.join(' ')).toMatch(/main\.js.*SHA-256/);
    const extra = new Map(files);
    extra.set('payload.exe', Buffer.from('MZ'));
    expect(parsePackage(extra).problems.join(' ')).toMatch(/not listed/);
    // and the round trip through the zip writer and the defensive reader is lossless
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tpl-')), 'p.ccadapter');
    fs.writeFileSync(tmp, writeZip(files));
    const back = await readPackageSource(tmp);
    expect(parsePackage(back.files).problems).toEqual([]);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });
});

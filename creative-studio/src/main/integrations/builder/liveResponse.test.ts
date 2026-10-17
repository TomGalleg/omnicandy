// A REAL Claude answer (captured in the live run of 2026-10-16, credentials removed) replayed offline through the builder. It shows what
// normalization absorbs and what the strict stages still refuse, without calling Claude again. Provenance: live Claude output, replayed.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBlueprint, parseBlueprintDetailed } from './blueprint';
import { buildCandidate } from './pipeline';

// Simulates Windows (backslash paths, registry text, a compiled mock program): not meaningful on other systems.
const onWindows = process.platform === 'win32';

const raw = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'ai-generated', 'live-claude-blueprint-attempt1.raw.txt'), 'utf8');
const opts = { version: '1.0.0', createdAt: '2026-10-16T00:00:00Z', author: { kind: 'claude' as const, note: 'replayed live answer' }, projectId: 'replay' };

describe('replay of the real Claude blueprint (live run 2026-10-16)', () => {
  it('was refused by the old strict schema only for formatting (a 423-character description and "FCStd" without its dot)', () => {
    const j = JSON.parse(raw);
    expect(j.commands[0].description.length).toBeGreaterThan(400);
    expect(j.commands[0].python.outputExtensions).toEqual(['FCStd']);
    expect(() => parseBlueprint(JSON.parse(JSON.stringify({ ...j, commands: [{ ...j.commands[0], python: { ...j.commands[0].python, outputExtensions: ['FCStd;'] } }] })))).toThrow(/expected form/);
  });

  it('normalization absorbs exactly those two formatting differences and reports them; nothing technical changes', () => {
    const j = JSON.parse(raw);
    const p = parseBlueprintDetailed(raw);
    expect(p.notes).toEqual(['The description of enclosure.create was shortened from 423 to 400 characters.', 'An output file type of enclosure.create "FCStd" was written as ".FCStd".']);
    expect(p.data.commands.map((c) => c.id)).toEqual(j.commands.map((c: { id: string }) => c.id));
    expect(p.data.commands.map((c) => c.permissions)).toEqual(j.commands.map((c: { permissions: string[] }) => c.permissions));
    expect(p.data.commands.map((c) => c.python?.source)).toEqual(j.commands.map((c: { python?: { source: string } }) => c.python?.source));
    expect(p.data.application.exeNames).toEqual(j.application.exeNames);
  });

  it('then passes static validation but is refused by the security stage: its citations do not name the symbols its code uses', async () => {
    const p = parseBlueprintDetailed(raw);
    const r = await buildCandidate(p.data, opts, { simulate: false });
    expect(r.reports[0]!.state).not.toBe('failed');
    expect(r.safe).toBe(false);
    expect(r.bytes).toBeNull();
    const failed = r.reports[1]!.checks.filter((c) => c.state === 'failed');
    expect(failed.map((c) => c.id)).toEqual(['documented']);
    expect(failed[0]!.detail).toMatch(/without documenting it/);
  }, 60_000);

  it('the strict rule is not weakened: the same blueprint is accepted only once its citations cover the code', async () => {
    const p = parseBlueprintDetailed(raw);
    const bp = structuredClone(p.data);
    const url = bp.research.sources[0]!.url;
    for (const c of bp.commands) {
      const have = new Set(c.docRefs.map((d) => d.symbol));
      for (const sym of ['FreeCAD.Placement', 'FreeCAD.Rotation', 'FreeCAD.Vector', 'FreeCAD.closeDocument', 'FreeCAD.newDocument', 'FreeCAD.openDocument', 'Document.addObject', 'Document.recompute', 'Document.saveAs', 'Shape.cut', 'Shape.isValid', 'Spreadsheet.set', 'Spreadsheet.setAlias', 'Spreadsheet.setExpression', 'Document.getObject', 'Shape.isNull']) if (!have.has(sym)) c.docRefs.push({ symbol: sym, url });
    }
    const r = await buildCandidate(bp, opts, { simulate: false });
    const failed = r.reports.flatMap((x) => x.checks.filter((c) => c.state === 'failed').map((c) => `${x.stage}/${c.id}: ${c.detail}`));
    // whatever else the strict stages still say is reported, never hidden
    expect(failed).toEqual([]);
    expect(r.safe).toBe(true); // static and security pass with the completed citations
    expect(r.bytes).not.toBeNull(); // and the package is built (the simulated stage is not run here: see the docs)
  }, 60_000);

  it.skipIf(!onWindows)('the simulated stage reports the stand-in program being unable to judge a code check as a mock limit, not as a defect', async () => {
    const bp = structuredClone(parseBlueprintDetailed(raw).data);
    const url = bp.research.sources[0]!.url;
    for (const c of bp.commands) for (const sym of ['FreeCAD.Placement', 'FreeCAD.Rotation', 'FreeCAD.Vector', 'FreeCAD.closeDocument', 'FreeCAD.newDocument', 'FreeCAD.openDocument', 'Document.addObject', 'Document.recompute', 'Document.saveAs', 'Shape.cut', 'Shape.isValid', 'Spreadsheet.set', 'Spreadsheet.setAlias', 'Spreadsheet.setExpression', 'Document.getObject', 'Shape.isNull']) if (!c.docRefs.some((d) => d.symbol === sym)) c.docRefs.push({ symbol: sym, url });
    const r = await buildCandidate(bp, opts);
    const sim = r.reports.find((x) => x.stage === 'simulated')!;
    expect(sim.mock).toBe(true);
    expect(sim.checks.filter((c) => c.state === 'failed')).toEqual([]);
    expect(sim.checks.some((c) => /limit of the simulation/.test(c.detail))).toBe(true);
    expect(r.passed).toBe(true);
  }, 120_000);
});

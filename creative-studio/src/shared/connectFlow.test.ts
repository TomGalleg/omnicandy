import { describe, expect, it } from 'vitest';
import { classifyApp, INSTALL_CANCELLED_MESSAGE, type AdapterOffer, type ConnectEntry, type ConnectOutcome } from './connect';
import { initialRuns, runSetup, summarise, type AdapterDecision, type SetupDeps } from './connectFlow';
import type { ExternalAppInfo } from './integrations';

const base = (name: string, over: Partial<ExternalAppInfo> = {}): ExternalAppInfo => ({
  key: `c:\\${name}\\${name}.exe`, name, publisher: null, version: '1.0', exePath: `C:\\${name}\\${name}.exe`, installType: 'installed', source: 'registry',
  adapterId: name, adapterName: name, maturity: 'verified', methods: ['scripting'], status: 'available', statusDetail: '', commands: [], granted: [],
  permissionsNeeded: [], notes: null, adapterVersion: null, origin: 'built-in', trust: 'built-in', requirements: [], selfContained: false, ...over,
});
const ready = (n: string): ConnectEntry => classifyApp({ app: base(n), offer: null, forgettable: false });
const offerOf = (id: string): AdapterOffer => ({ source: 'bundled', path: `C:\\c\\${id}.ccadapter`, adapterId: id, name: id, version: '1.0.0', publisherName: 'P', signature: 'valid', publisherTrusted: false, permissions: ['read-info'], integrationType: 'external', hostName: null, simulated: false, closeHost: false, restartHost: false });
const needs = (n: string): ConnectEntry => classifyApp({ app: base(n, { adapterId: null, adapterName: null, maturity: null, status: 'unsupported' }), offer: offerOf(n), forgettable: false });

const verified = (key: string, name: string): ConnectOutcome => ({ key, state: 'verified', status: 'connected', headline: `${name} is connected and tested`, detail: '', evidence: ['checked'], technical: '' });
const failed = (key: string, name: string): ConnectOutcome => ({ key, state: 'failed', status: 'needs-repair', headline: `Could not connect to ${name}`, detail: 'try again', evidence: [], technical: 'raw' });

function deps(over: Partial<SetupDeps> & { outcomes?: Record<string, ConnectOutcome> } = {}): SetupDeps & { log: string[]; updates: number } {
  const log: string[] = [];
  const d = {
    log, updates: 0,
    askAdapter: async (e: ConnectEntry): Promise<AdapterDecision> => { log.push(`ask:${e.name}`); return { approval: { permissions: ['read-info'], trustPublisher: true } }; },
    installAdapter: async (e: ConnectEntry) => { log.push(`install:${e.name}`); },
    refresh: async () => [] as ConnectEntry[],
    connect: async (key: string) => { log.push(`connect:${key}`); return over.outcomes?.[key] ?? verified(key, key); },
    onUpdate: () => { d.updates++; },
    isCancelled: () => false,
    ...over,
  };
  return d as SetupDeps & { log: string[]; updates: number };
}

describe('runSetup: each program has its own outcome', () => {
  it('one failure does not mark the others connected or failed', async () => {
    const entries = [ready('a'), ready('b'), ready('c')];
    const d = deps({ outcomes: { [entries[1]!.key]: failed(entries[1]!.key, 'b') } });
    const runs = await runSetup(entries, d);
    expect(runs.map((r) => r.outcome)).toEqual(['verified', 'failed', 'verified']);
    expect(summarise(runs)).toBe('2 of 3 connected and tested. 1 needs attention.');
  });

  it('an exception while connecting one program is contained', async () => {
    const entries = [ready('a'), ready('b')];
    const d = deps({ connect: async (k) => { if (k.includes('\\a\\')) throw new Error("Error invoking remote method 'connect:app': Error: kaboom"); return verified(k, 'b'); } });
    const runs = await runSetup(entries, d);
    expect(runs[0]).toMatchObject({ outcome: 'failed', technical: 'kaboom' });
    expect(runs[1]!.outcome).toBe('verified');
  });

  it('a blocked program (not running) is "blocked", not failed, and does not stop the rest', async () => {
    const entries = [ready('a'), ready('b')];
    const d = deps({ outcomes: { [entries[0]!.key]: { ...failed(entries[0]!.key, 'a'), state: 'blocked', status: 'not-running' } } });
    const runs = await runSetup(entries, d);
    expect(runs.map((r) => r.outcome)).toEqual(['blocked', 'verified']);
  });

  it('never reports success for a program whose test did not pass: only verified outcomes count', async () => {
    const runs = await runSetup([ready('a')], deps({ outcomes: { 'c:\\a\\a.exe': failed('c:\\a\\a.exe', 'a') } }));
    expect(summarise(runs)).toBe('Not connected.');
    expect(runs[0]!.connect).toBe('failed');
  });
});

describe('runSetup: connectors', () => {
  it('asks per program, installs only what was approved, then connects the re-listed program (its key may change)', async () => {
    const e = needs('fc');
    const after = classifyApp({ app: base('fc', { key: 'c:\\fc\\fccmd.exe', exePath: 'C:\\fc\\bin\\fccmd.exe', adapterId: 'fc', status: 'available' }), offer: null, forgettable: false });
    const d = deps({ refresh: async () => [after] });
    const runs = await runSetup([e], d);
    expect(d.log).toEqual(['ask:fc', 'install:fc', 'connect:c:\\fc\\fccmd.exe']);
    expect(runs[0]).toMatchObject({ outcome: 'verified', adapter: 'done', appKey: 'c:\\fc\\fccmd.exe' });
  });

  it('declining the connector skips only that program; nothing is installed or connected for it', async () => {
    const entries = [needs('x'), ready('y')];
    const d = deps({ askAdapter: async () => null });
    const runs = await runSetup(entries, d);
    expect(d.log).toEqual(['connect:c:\\y\\y.exe']);
    expect(runs.map((r) => r.outcome)).toEqual(['skipped', 'verified']);
    expect(runs[0]!.detail).toMatch(/Nothing was changed/);
  });

  it('cancelling the native install confirmation skips that program only', async () => {
    const entries = [needs('x'), needs('z')];
    const installed: string[] = [];
    const d = deps({
      installAdapter: async (e) => { if (e.name === 'x') throw new Error(INSTALL_CANCELLED_MESSAGE); installed.push(e.name); },
      refresh: async () => [classifyApp({ app: base('z'), offer: null, forgettable: false })],
    });
    const runs = await runSetup(entries, d);
    expect(runs[0]).toMatchObject({ outcome: 'skipped', adapter: 'skipped', connect: 'skipped' });
    expect(installed).toEqual(['z']);
    expect(runs[1]!.outcome).toBe('verified');
  });

  it('a failed install is a failure for that program with the reason; the others continue', async () => {
    const d = deps({
      installAdapter: async (e) => { if (e.name === 'x') throw new Error("Error invoking remote method 'ext:pkg-install': Error: disk full"); },
      refresh: async () => [classifyApp({ app: base('z'), offer: null, forgettable: false })],
    });
    const runs = await runSetup([needs('x'), needs('z')], d);
    expect(runs[0]).toMatchObject({ outcome: 'failed', adapter: 'failed', technical: 'disk full' });
    expect(runs[0]!.detail).toMatch(/Nothing was left half-installed/);
    expect(runs[1]!.outcome).toBe('verified');
  });

  it('installed but the program is not found afterwards: honest failure, no connect attempt', async () => {
    const d = deps({ refresh: async () => [] });
    const runs = await runSetup([needs('x')], d);
    expect(runs[0]).toMatchObject({ outcome: 'failed', adapter: 'done', connect: 'skipped' });
    expect(d.log.some((l) => l.startsWith('connect:'))).toBe(false);
  });

  it('an incompatible version after the install is reported, not connected', async () => {
    const inc = classifyApp({ app: base('x', { status: 'incompatible', statusDetail: 'Version 9 is newer than the supported 1-2.' }), offer: null, forgettable: false });
    const d = deps({ refresh: async () => [inc] });
    const runs = await runSetup([needs('x')], d);
    expect(runs[0]!.outcome).toBe('failed');
    expect(runs[0]!.detail).toMatch(/newer than the supported/);
    expect(d.log.some((l) => l.startsWith('connect:'))).toBe(false);
  });
});

describe('runSetup: cancelling', () => {
  it('stops before the next program; the finished one keeps its real result, the rest are "Not set up"', async () => {
    let cancelled = false;
    const entries = [ready('a'), ready('b'), ready('c')];
    const d = deps({ connect: async (k) => { cancelled = true; return verified(k, 'a'); }, isCancelled: () => cancelled });
    const runs = await runSetup(entries, d);
    expect(runs.map((r) => r.outcome)).toEqual(['verified', 'cancelled', 'cancelled']);
    expect(runs[1]!.detail).toMatch(/Nothing was changed/);
    expect(summarise(runs)).toBe('1 of 3 connected and tested. 2 need attention.');
  });

  it('cancelling while the connector review is open installs nothing and connects nothing', async () => {
    let cancelled = false;
    const d = deps({ askAdapter: async () => { cancelled = true; return null; }, isCancelled: () => cancelled });
    const runs = await runSetup([needs('x'), ready('y')], d);
    expect(runs.map((r) => r.outcome)).toEqual(['cancelled', 'cancelled']);
    expect(d.log).toEqual([]);
  });

  it('cancelled before anything starts', async () => {
    const d = deps({ isCancelled: () => true });
    const runs = await runSetup([ready('a')], d);
    expect(runs[0]!.outcome).toBe('cancelled');
    expect(d.log).toEqual([]);
  });
});

describe('progress and summary', () => {
  it('streams updates and starts every program as pending', async () => {
    expect(initialRuns([ready('a'), needs('b')]).map((r) => [r.needsAdapter, r.adapter, r.outcome])).toEqual([[false, 'skipped', 'pending'], [true, 'todo', 'pending']]);
    const d = deps();
    await runSetup([ready('a')], d);
    expect(d.updates).toBeGreaterThan(2);
  });

  it('summaries', () => {
    expect(summarise([])).toBe('Nothing was set up.');
    const v = initialRuns([ready('a')]).map((r) => ({ ...r, outcome: 'verified' as const }));
    expect(summarise(v)).toBe('Connected and tested.');
    expect(summarise([...v, ...v])).toBe('All 2 programs are connected and tested.');
  });
});

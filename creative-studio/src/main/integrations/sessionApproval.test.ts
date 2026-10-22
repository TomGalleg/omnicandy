// "Allow for this session": a destructive command (deleting one object) can be allowed once for the session instead of asking every
// single time. Scripts, anything needing a new permission and unsigned packages keep asking; nothing is ever saved to disk.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalDetail } from '@shared/connect';
import { ADAPTER_SDK_VERSION, type AdapterManifest, type ApprovalAnswer } from '@shared/integrations';
import { BLENDER_MANIFEST } from './adapters/blender';
import { IntegrationManager } from './index';
import type { DiscoveryEnv } from './discovery';
import type { AdapterFactory } from './sdk';

let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-session-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const fakeEnv = (files: string[]): DiscoveryEnv => ({ env: { ProgramFiles: 'C:\\Program Files', PATH: '' }, exists: async (p) => files.map((f) => f.toLowerCase()).includes(p.toLowerCase()), listDir: async () => [], run: async () => '' });
const manifest = (): AdapterManifest => ({
  id: 'sess.app', platforms: ['win32', 'linux'], name: 'Sess', vendor: 'Test', sdkVersion: ADAPTER_SDK_VERSION, maturity: 'experimental',
  exeNames: ['sessapp.exe'], displayNames: ['^sess.app'], versions: { min: '0.1' }, methods: ['scripting'], capabilities: ['executeCommand', 'connect', 'disconnect'],
  commands: [
    { id: 'delete', label: 'Delete', description: 'deletes one thing', params: {}, permissions: [], destructive: true },
    { id: 'script', label: 'Script', description: 'runs code', params: {}, permissions: [], destructive: true, confirmEveryTime: true },
    { id: 'delete_files', label: 'Delete files', description: 'needs a permission nobody granted', params: {}, permissions: ['write-files'], destructive: true },
    { id: 'rename', label: 'Rename', description: 'harmless', params: {}, permissions: [] },
  ],
});
const factory = (calls: string[], extra: Partial<AdapterFactory> = {}): AdapterFactory => ({
  manifest: manifest(), ...extra,
  create: () => ({ probe: async () => ({ version: '1.0' }), connect: async () => undefined, disconnect: async () => undefined, healthCheck: async () => ({ ok: true, detail: 'ok' }), dispose: async () => undefined,
    execute: async (cmd) => { calls.push(cmd.id); return { message: 'ok', outputs: [] }; } }),
});

async function rig(opts: { answers: ApprovalAnswer[]; sessionStore?: boolean; unsigned?: boolean }) {
  const exe = path.join(tmp, `app-${Math.random().toString(36).slice(2)}`, 'sessapp.exe');
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(exe, 'x');
  const calls: string[] = [];
  const asked: string[] = [];
  const allowed = new Set<string>();
  const answers = [...opts.answers];
  const mgr = new IntegrationManager({
    workDir: async (id) => path.join(tmp, 'work', id), permissions: { load: async () => ({}), save: async () => undefined },
    approve: async (r) => { asked.push(r.command.id); return answers.shift() ?? 'deny'; },
    ...(opts.sessionStore === false ? {} : { sessionAllowed: { has: (k, c) => allowed.has(`${k}|${c}`), add: (k, c) => { allowed.add(`${k}|${c}`); } } }),
    discovery: fakeEnv([exe]), userPaths: async () => [exe],
  });
  mgr.register(factory(calls, opts.unsigned ? { alwaysAsk: true } : {}));
  const key = (await mgr.scan()).apps[0]!.key;
  return { mgr, key, calls, asked, allowed };
}

describe('allowing a destructive command for the session', () => {
  it('asks once, then lets the same command run without asking again (and only that command)', async () => {
    const r = await rig({ answers: ['session'] });
    for (let i = 0; i < 4; i++) expect((await r.mgr.execute(r.key, 'delete')).ok).toBe(true);
    expect(r.asked).toEqual(['delete']);
    expect(r.calls).toEqual(['delete', 'delete', 'delete', 'delete']);
    expect([...r.allowed]).toEqual([`${r.key}|delete`]);
    expect((await r.mgr.execute(r.key, 'script')).error?.kind).toBe('permission-denied'); // another destructive command still asks (and nobody answered)
    expect(r.asked).toEqual(['delete', 'script']);
  });
  it('"Allow once" still asks every time, and a refusal runs nothing and allows nothing', async () => {
    const r = await rig({ answers: ['once', 'once', 'deny'] });
    expect((await r.mgr.execute(r.key, 'delete')).ok).toBe(true);
    expect((await r.mgr.execute(r.key, 'delete')).ok).toBe(true);
    expect((await r.mgr.execute(r.key, 'delete')).error?.kind).toBe('permission-denied');
    expect(r.asked.length).toBe(3);
    expect(r.calls.length).toBe(2);
    expect(r.allowed.size).toBe(0);
  });
  it('never applies to a command marked confirm-every-time (a script), a command needing a new permission, or an unsigned package', async () => {
    const s = await rig({ answers: ['session', 'session', 'deny'] });
    expect((await s.mgr.execute(s.key, 'script')).ok).toBe(true); // the answer is accepted as "once"
    expect((await s.mgr.execute(s.key, 'script')).ok).toBe(true);
    expect(s.asked).toEqual(['script', 'script']);
    expect(s.allowed.size).toBe(0);

    const p = await rig({ answers: ['session', 'session'] });
    expect((await p.mgr.execute(p.key, 'delete_files')).ok).toBe(true);
    expect((await p.mgr.execute(p.key, 'delete_files')).ok).toBe(true);
    expect(p.asked).toEqual(['delete_files', 'delete_files']);
    expect(p.allowed.size).toBe(0);

    const u = await rig({ answers: ['session', 'session'], unsigned: true });
    await u.mgr.execute(u.key, 'delete');
    await u.mgr.execute(u.key, 'delete');
    expect(u.asked).toEqual(['delete', 'delete']);
  });
  it('is harmless when the host keeps no session list, and does not change commands that are not destructive', async () => {
    const r = await rig({ answers: ['session', 'session'], sessionStore: false });
    await r.mgr.execute(r.key, 'delete');
    await r.mgr.execute(r.key, 'delete');
    expect(r.asked).toEqual(['delete', 'delete']);
    const q = await rig({ answers: ['always'] });
    expect((await q.mgr.execute(q.key, 'rename')).ok).toBe(true); // no permission needed, not destructive: no question at all
    expect(q.asked).toEqual([]);
  });
});

describe('what the user is told', () => {
  it('names the session option for deletes, and keeps "asked every time" for scripts', () => {
    const del = BLENDER_MANIFEST.commands.find((c) => c.id === 'object.delete')!;
    const script = BLENDER_MANIFEST.commands.find((c) => c.id === 'script.run')!;
    expect(del.destructive).toBe(true);
    expect(del.confirmEveryTime).toBeUndefined();
    expect(script).toMatchObject({ destructive: true, confirmEveryTime: true });
    expect(approvalDetail({ command: del, params: {}, needed: [], destructive: true })).toMatch(/unless you choose "Allow for this session"/);
    expect(approvalDetail({ command: script, params: {}, needed: [], destructive: true })).toMatch(/You are asked every time\./);
  });
});

// REAL DaVinci Resolve. Runs only with CS_LIVE_TESTS=1 and an installed Resolve. It never starts Resolve
// and never touches an existing project. What it can prove depends on the machine:
//  * Resolve not running  -> asserts the precise "Not running" status (no false success).
//  * Running, no scripting -> asserts "Scripting not available" (Free edition or preference off).
//  * Running with scripting (Studio) -> reads info, then creates and deletes a "CreateCraft Live Test" project.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@shared/integrations';
import { createIntegrationManager } from './index';

const on = process.env.CS_LIVE_TESTS === '1';

describe.skipIf(!on)('DaVinci Resolve integration (real Resolve, same framework as Blender)', { timeout: 180_000 }, () => {
  let tmp: string;
  let granted: Record<string, Permission[]> = {};
  let m: ReturnType<typeof createIntegrationManager>;
  let key = '';
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-resolve-live-'));
    m = createIntegrationManager({
      workDir: async (id) => path.join(tmp, id),
      permissions: { load: async () => granted, save: async (g) => { granted = g; } },
      approve: async () => 'always',
    });
  });
  afterAll(async () => { await m.shutdown(); await fs.rm(tmp, { recursive: true, force: true }); });

  it('detects Resolve with its installed version and the shared adapter manifest', async () => {
    const scan = await m.scan();
    const r = scan.apps.find((a) => a.adapterId === 'davinci.resolve');
    console.log('RESOLVE', JSON.stringify({ version: r?.version, status: r?.status, exe: r?.exePath, source: r?.source }));
    expect(r, 'DaVinci Resolve not found on this PC').toBeTruthy();
    key = r!.key;
    expect(r!.version).toMatch(/^\d+\.\d+/);
    expect(r!.methods[0]).toBe('scripting');
    expect(r!.commands.map((c) => c.id)).toContain('project.inspect');
  });

  it('connects, or reports exactly why it cannot', async () => {
    let status: string;
    try {
      status = (await m.connect(key)).status;
    } catch (e) {
      const info = (await m.list()).find((a) => a.key === key)!;
      console.log('RESOLVE CONNECT BLOCKED:', info.status, '-', info.statusDetail, '|', e instanceof Error ? e.message : e);
      expect(['not-running', 'api-unavailable', 'needs-repair']).toContain(info.status);
      return;
    }
    expect(status).toBe('limited'); // experimental adapter: connected, never "verified"
    const info = await m.execute(key, 'app.info');
    expect(info.ok).toBe(true);
    console.log('RESOLVE INFO', JSON.stringify(info.data));
    const list = await m.execute(key, 'project.list');
    expect(list.ok).toBe(true);
    if ((info.data as { via?: string } | undefined)?.via === 'bridge') {
      // Free edition through the in-Resolve bridge: read-only checks plus a scratch TIMELINE is NOT created here (that would change the
      // person's open project); creating projects is Studio-only. Inspect and export are safe: they never modify the project.
      const ins = await m.execute(key, 'project.inspect');
      expect(ins.ok).toBe(true);
      console.log('RESOLVE BRIDGE INSPECT', JSON.stringify(ins.data));
      if ((ins.data as { open?: boolean }).open) {
        const exp = await m.execute(key, 'timeline.export', { file_name: 'CreateCraft Live Test', format: 'edl' });
        console.log('RESOLVE BRIDGE EXPORT', JSON.stringify({ ok: exp.ok, error: exp.error?.message, outputs: exp.outputs.map((o) => o.bytes) }));
      }
      return;
    }
    // Scratch project round trip: only a project named "CreateCraft Live Test" is created and removed.
    const name = 'CreateCraft Live Test';
    const open = (await m.execute(key, 'project.inspect')).data as { open?: boolean };
    const made = await m.execute(key, 'project.create_scratch', { name: 'Live Test', allow_switch: open.open === true });
    expect(made.error).toBeUndefined();
    const del = await m.execute(key, 'project.delete_scratch', { name });
    expect(del.ok).toBe(true);
    expect(((await m.execute(key, 'project.list')).data as { projects: string[] }).projects).not.toContain(name);
  });
});

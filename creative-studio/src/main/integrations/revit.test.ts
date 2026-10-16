// The Autodesk Revit 2027 package: manifest, install plan, install/uninstall into a throw-away AppData, and consistency
// between the manifest and the C# add-in source. Nothing here starts Revit (see revit.live.test.ts for that).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packAdapter } from '../../../scripts/pack-adapter.mjs';
import { parsePackage, readPackageSource } from './packageFormat';
import { PluginInstaller } from './install/pluginInstaller';
import { profileById } from './install/hostProfiles';

const ROOT = path.resolve(__dirname, '../../..');
let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-revit-')); });
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

async function load() {
  const file = path.join(tmp, 'revit.ccadapter');
  await fs.writeFile(file, packAdapter({ dir: path.join(ROOT, 'fixtures', 'revit-adapter') }).bytes);
  const src = await readPackageSource(file);
  const parsed = parsePackage(src.files);
  if (!parsed.manifest) throw new Error(parsed.problems.join('; '));
  return { files: src.files, manifest: parsed.manifest };
}

function rig() {
  const root = path.join(tmp, 'r-' + Math.random().toString(36).slice(2, 6));
  const installer = new PluginInstaller(path.join(root, 'integrations'), {
    env: { vars: { APPDATA: path.join(root, 'AppData'), PROGRAMDATA: path.join(root, 'ProgramData') }, simHostRoot: path.join(root, 'sim') },
    isRunning: async () => false,
    bridge: { endpointFile: path.join(root, 'bridge', 'endpoint.json'), pairingDir: path.join(root, 'bridge', 'pairing') },
  });
  return { root, installer };
}

describe('Autodesk Revit 2027 package', () => {
  it('is a valid hybrid package for the Revit profile, which is marked supported', async () => {
    const { manifest } = await load();
    expect(manifest.id).toBe('autodesk.revit');
    expect(manifest.integration?.type).toBe('hybrid');
    expect(manifest.integration?.host?.profile).toBe('autodesk.revit');
    expect(manifest.integration?.plugin?.technology).toBe('dotnet-addin');
    expect(manifest.integration?.plugin?.admin).toBe('never');
    expect(profileById('autodesk.revit')?.readiness).toBe('supported');
  });

  it('offers no way to run arbitrary code: no script permission, no free-form code parameter', async () => {
    const { manifest } = await load();
    for (const c of manifest.commands) {
      expect(c.permissions, c.id).not.toContain('execute-scripts');
      expect(c.permissions, c.id).not.toContain('write-files');
      for (const [k, v] of Object.entries(c.params)) expect(/code|script|python|expression/i.test(k) && v.type === 'string', `${c.id}.${k}`).toBe(false);
    }
    // every edit asks the user every time
    for (const c of manifest.commands.filter((x) => x.permissions.includes('modify-project'))) expect(c.destructive, c.id).toBe(true);
  });

  it('lists exactly the capabilities the C# add-in registers', async () => {
    const { manifest } = await load();
    const src = await fs.readFile(path.join(ROOT, 'addins', 'revit', 'CreateCraft.Revit', 'Commands.cs'), 'utf8');
    const csharp = [...src.matchAll(/"(revit\.[a-z_.]+)"/g)].map((m) => m[1]!).filter((v, i, a) => a.indexOf(v) === i).sort();
    const caps = manifest.integration!.communication!.capabilities.map((c) => c.id).sort();
    const cmds = manifest.commands.map((c) => c.id).sort();
    expect(caps).toEqual(csharp);
    expect(cmds).toEqual(csharp);
    // every read-only capability needs only reading; every edit capability modifying
    for (const c of manifest.integration!.communication!.capabilities) {
      expect(c.permissions).toEqual(/parameter\.set|place_test|remove_test/.test(c.id) ? ['modify-project'] : [c.id === 'revit.app_info' ? 'read-info' : 'read-project']);
    }
  });

  it('plans the per-user Addins/2027 folder (no administrator), refuses an unknown year, and keeps other add-ins untouched', async () => {
    const { manifest, files } = await load();
    const { root, installer } = rig();
    const plan = await installer.plan(manifest, files, { hostVersion: '27.3.0.28' });
    expect(plan.problems).toEqual([]);
    expect(plan.view.needsAdmin).toBe(false);
    const rel = plan.files.map((f) => path.relative(path.join(root, 'AppData'), f.abs).replace(/\\/g, '/')).sort();
    expect(rel).toEqual(['Autodesk/Revit/Addins/2027/CreateCraft.addin', 'Autodesk/Revit/Addins/2027/CreateCraft/CreateCraft.Revit.dll', 'Autodesk/Revit/Addins/2027/cc-bridge.json']);
    expect(plan.view.steps.map((s) => s.kind)).toContain('authorize-in-host');
    const unknown = await installer.plan(manifest, files, { hostVersion: null });
    expect(unknown.problems.join()).toMatch(/version is unknown/);
  });

  it('installs, verifies, repairs and uninstalls without touching a neighbouring add-in', async () => {
    const { manifest, files } = await load();
    const { root, installer } = rig();
    const dir = path.join(root, 'AppData', 'Autodesk', 'Revit', 'Addins', '2027');
    await fs.mkdir(dir, { recursive: true });
    const neighbour = path.join(dir, 'Other.addin');
    await fs.writeFile(neighbour, '<RevitAddIns/>');
    await installer.install(manifest, files, { permissions: [], installPlugin: true }, { hostVersion: '2027' });
    expect((await fs.readdir(dir)).sort()).toEqual(['CreateCraft', 'CreateCraft.addin', 'Other.addin', 'cc-bridge.json']);
    const cfg = JSON.parse(await fs.readFile(path.join(dir, 'cc-bridge.json'), 'utf8')) as { pluginId: string; secret: string };
    expect(cfg.pluginId).toBe('autodesk.revit.bridge');
    expect(cfg.secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await installer.verify(manifest.id)).state).toBe('restart-needed');
    await fs.rm(path.join(dir, 'CreateCraft', 'CreateCraft.Revit.dll'));
    expect((await installer.verify(manifest.id)).state).toBe('missing-files');
    await installer.repair(manifest, files, { permissions: [], installPlugin: true }, { hostVersion: '2027' });
    expect((await installer.verify(manifest.id)).state).toBe('restart-needed');
    await installer.uninstall(manifest.id);
    expect((await fs.readdir(dir)).sort()).toEqual(['Other.addin']);
    expect(await fs.readFile(neighbour, 'utf8')).toBe('<RevitAddIns/>');
  });
});

// project.create against the REAL Unreal 5.8 templates on this computer (files only: no editor is started). The project is made in a fresh folder
// under the OS temp directory and removed again. Skipped when Unreal is not installed at the usual place (or OMNICANDY_UNREAL_EXE).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationManager } from './index';
import { unrealFactory } from './adapters/unreal';
import { engineRootOf } from './adapters/unrealProject';

const exe = process.env.OMNICANDY_UNREAL_EXE || 'E:\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor.exe';
const haveExe = await fs.stat(exe).then(() => true, () => false);

describe.skipIf(!haveExe)('project.create with the real Unreal templates', { timeout: 300_000 }, () => {
  let tmp: string;
  beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-uproj-live-')); });
  afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('makes a Third Person project equal to what Unreal itself would copy, plus the MCP setup', async () => {
    const m = new IntegrationManager({
      workDir: async (id) => { const d = path.join(tmp, 'omni', 'work', 'external', id); await fs.mkdir(d, { recursive: true }); return d; },
      permissions: { load: async () => ({}), save: async () => undefined },
      approve: async () => 'always',
      discovery: { env: { ProgramFiles: 'C:\\x' }, exists: async (p) => p.toLowerCase() === exe.toLowerCase(), listDir: async () => [], run: async () => '' },
      userPaths: async () => [exe],
    });
    m.register(unrealFactory, { builtin: true });
    const key = (await m.scan()).apps[0]!.key;
    const loc = path.join(tmp, 'projects');
    const r = await m.execute(key, 'project.create', { name: 'OmniLiveProbe', template: 'third_person', location: loc });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.verified).toBe(true);
    const dir = path.join(loc, 'OmniLiveProbe');
    const up = JSON.parse(await fs.readFile(path.join(dir, 'OmniLiveProbe.uproject'), 'utf8')) as { EngineAssociation: string; Plugins: Array<{ Name: string; Enabled: boolean }> };
    expect(up.EngineAssociation).toMatch(/^5\.\d+$/);
    for (const n of ['ModelContextProtocol', 'AllToolsets', 'GameplayStateTree']) expect(up.Plugins.some((p) => p.Name === n && p.Enabled), n).toBe(true);
    // the same files Unreal's own project has: the template's level and the shared packs
    for (const rel of ['Content/ThirdPerson/Lvl_ThirdPerson.umap', 'Content/ThirdPerson/Blueprints/BP_ThirdPersonCharacter.uasset', 'Content/Characters', 'Content/Input', 'Content/LevelPrototyping', 'Config/DefaultEngine.ini', 'Config/DefaultInput.ini']) {
      expect(await fs.stat(path.join(dir, ...rel.split('/'))).then(() => true, () => false), rel).toBe(true);
    }
    expect(await fs.readFile(path.join(dir, 'Config/DefaultEngine.ini'), 'utf8')).toContain('GameName=OmniLiveProbe');
    expect(await fs.readFile(path.join(dir, 'Config/DefaultEditorPerProjectUserSettings.ini'), 'utf8')).toContain('bAutoStartServer=True');
    for (const rel of ['Config/TemplateDefs.ini', 'Config/config.ini', 'TP_ThirdPersonBP.uproject', 'Media']) expect(await fs.stat(path.join(dir, rel)).then(() => true, () => false), rel).toBe(false);
    // it is the engine's own bytes: the level file equals the template's
    const tpl = path.join(engineRootOf(exe), 'Templates', 'TP_ThirdPersonBP', 'Content', 'ThirdPerson', 'Lvl_ThirdPerson.umap');
    expect((await fs.readFile(path.join(dir, 'Content/ThirdPerson/Lvl_ThirdPerson.umap'))).equals(await fs.readFile(tpl))).toBe(true);
    expect(((await m.execute(key, 'project.list')).data as { projects: Array<{ name: string; exists: boolean }> }).projects).toEqual([expect.objectContaining({ name: 'OmniLiveProbe', exists: true })]);
  });
});

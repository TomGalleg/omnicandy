import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_CODE_MISSING, ClaudePartner, type ClaudePartnerDeps } from './claudePartner';

let tmp: string;
let savedPath: string | undefined;
let savedPathCaps: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-claude-'));
  savedPath = process.env.PATH; savedPathCaps = process.env.Path;
  process.env.PATH = path.join(tmp, 'empty'); delete process.env.Path; // nothing on PATH
});
afterEach(async () => {
  process.env.PATH = savedPath; if (savedPathCaps !== undefined) process.env.Path = savedPathCaps;
  await fs.rm(tmp, { recursive: true, force: true });
});

const partner = (cliPath: string) => new ClaudePartner({ cliPath, emit: () => undefined, history: { load: async () => [], save: async () => undefined } } as unknown as ClaudePartnerDeps);

describe('Claude Code install detection', () => {
  it('reports not installed, with plain guidance, when the command is nowhere', async () => {
    const p = partner(path.join(tmp, 'missing', 'claude'));
    expect(p.state().installed).toBeNull();
    expect(await p.checkAuth()).toBeNull();
    expect(p.state().installed).toBe(false);
    await expect(p.signIn()).rejects.toThrow(CLAUDE_CODE_MISSING);
    expect(CLAUDE_CODE_MISSING).toMatch(/Check again/);
  });

  it('finds the command at the official location, and notices an install made while CreateCraft is open', async () => {
    const cli = path.join(tmp, 'bin', 'claude');
    const p = partner(cli);
    expect(await p.findCli()).toBeNull();
    await fs.mkdir(path.dirname(cli), { recursive: true });
    await fs.writeFile(cli, 'x');
    expect(await p.findCli()).toBe(cli);
    expect(p.state().installed).toBe(true);
  });

  it('also finds the command on PATH when it is not at the official location', async () => {
    const dir = path.join(tmp, 'onpath');
    await fs.mkdir(dir, { recursive: true });
    const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
    await fs.writeFile(path.join(dir, name), 'x');
    process.env.PATH = dir;
    const p = partner(path.join(tmp, 'nowhere', 'claude'));
    expect((await p.findCli())?.toLowerCase()).toBe(path.join(dir, name).toLowerCase());
  });
});

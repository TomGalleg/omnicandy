// Live: unpacks the packed source, installs its dependencies (internet, a few minutes) and builds it.
// Run with: CS_LIVE_WORKSPACE=1 npx vitest run src/main/editWorkspace.live.test.ts   (after: node scripts/pack-source.mjs)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditWorkspace } from './editWorkspace';

describe.skipIf(!process.env.CS_LIVE_WORKSPACE)('editable workspace (live)', () => {
  it('sets up, becomes ready and builds', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicandy-ws-'));
    const bundle = path.resolve(__dirname, '..', '..', 'build-source');
    let quit = false;
    const w = new EditWorkspace({
      appPath: 'unused', isPackaged: true, bundleDir: bundle, workspaceDir: path.join(dir, 'OmniCandy Source'),
      fallbackCommand: { cmd: 'unused', args: [] }, emit: () => undefined, quit: () => { quit = true; },
    });
    await w.refresh();
    expect(w.state().state).toBe('needs-setup');
    expect(w.state().nodeFound).toBe(true);
    await w.setup();
    expect(w.state().state).toBe('ready');
    expect(await w.sourceRoot()).toBe(path.join(dir, 'OmniCandy Source'));
    await fs.access(path.join(dir, 'OmniCandy Source', 'node_modules', 'electron'));
    expect(quit).toBe(false);
  }, 900_000);
});

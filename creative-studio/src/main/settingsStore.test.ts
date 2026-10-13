import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE } from '@shared/theme';
import { SettingsStore } from './settingsStore';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-settings-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('SettingsStore (theme persistence)', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await new SettingsStore(dir).load()).toEqual(DEFAULT_APPEARANCE);
  });

  it('persists mode and accent across a "restart" (new store instance)', async () => {
    await new SettingsStore(dir).save({ mode: 'light', accent: '#14b8a6' });
    expect(await new SettingsStore(dir).load()).toEqual({ mode: 'light', accent: '#14b8a6' });
    await new SettingsStore(dir).save({ mode: 'system', accent: '#14b8a6' });
    expect((await new SettingsStore(dir).load()).mode).toBe('system');
  });

  it('recovers from a corrupt file and never persists invalid values', async () => {
    await fs.writeFile(path.join(dir, 'appearance.json'), '{not json');
    expect(await new SettingsStore(dir).load()).toEqual(DEFAULT_APPEARANCE);
    const saved = await new SettingsStore(dir).save({ mode: 'dark', accent: 'javascript:alert(1)', extra: 'x' });
    expect(saved).toEqual({ mode: 'dark', accent: DEFAULT_APPEARANCE.accent });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'appearance.json'), 'utf8'))).toEqual(saved);
  });
});

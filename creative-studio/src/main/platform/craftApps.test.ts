import { describe, expect, it } from 'vitest';
import { probeAllArtCraftApps } from '../artcraftProbe';
import { CraftAppUnavailableError, craftBin, craftInstallDir, craftInstallRoot } from './craftApps';

describe('Craft app locations', () => {
  it('Windows: Program Files, honouring the environment', () => {
    expect(craftInstallRoot('win32', { ProgramFiles: 'D:\\Apps' })).toBe('D:\\Apps');
    expect(craftInstallRoot('win32', {})).toBe('C:\\Program Files');
    expect(craftInstallDir('PhotoCraft', 'win32', { ProgramFiles: 'D:\\Apps' })).toBe('D:\\Apps\\PhotoCraft');
    expect(craftBin('D:\\Apps\\PhotoCraft', 'photocraft-cli', 'win32').endsWith('photocraft-cli.exe')).toBe(true);
  });
  it('Linux: no location is invented, the app is reported unavailable', () => {
    expect(craftInstallRoot('linux', { ProgramFiles: 'C:\\x' })).toBeNull();
    expect(() => craftInstallDir('PhotoCraft', 'linux')).toThrow(CraftAppUnavailableError);
    expect(() => craftInstallDir('PhotoCraft', 'linux')).toThrow(/no Linux version/);
  });
  it('probing with no install location lists all 13 as not installed and says why', async () => {
    const r = await probeAllArtCraftApps(null);
    expect(r).toHaveLength(13);
    expect(r.every((a) => !a.installed && !a.connected && /not available/.test(a.notes.join(' ')))).toBe(true);
  });
});

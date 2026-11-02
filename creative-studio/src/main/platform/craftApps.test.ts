import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeAllArtCraftApps } from '../artcraftProbe';
import { CraftAppUnavailableError, craftBin, craftInstallDir, craftInstallRoot, craftInstallRoots, craftRootFromPick, craftSearchedPlaces, discoverCraftDirs, loadCraftUserRoot, parseRegistryDirs, saveCraftUserRoot } from './craftApps';

describe('Craft app locations', () => {
  it('Windows: uses the first location that really holds the app (x86, per-user), else the standard one', () => {
    const PF = 'C:\\Program Files', X86 = 'C:\\Program Files (x86)', USR = 'C:\\Users\\a\\AppData\\Local\\Programs';
    const env = { ProgramFiles: PF, 'ProgramFiles(x86)': X86, LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    expect(craftInstallRoots('win32', env)).toEqual([PF, X86, USR]);
    expect(craftInstallDir('PhotoCraft', 'win32', env, (p) => p === X86 + '\\PhotoCraft')).toBe(X86 + '\\PhotoCraft');
    expect(craftInstallDir('PhotoCraft', 'win32', env, (p) => p === USR + '\\PhotoCraft')).toBe(USR + '\\PhotoCraft');
    expect(craftInstallDir('PhotoCraft', 'win32', env, () => false)).toBe(PF + '\\PhotoCraft');
    expect(craftInstallRoots('linux', env)).toEqual([]);
  });
  it('a chosen folder is remembered and searched first; picking one app\'s own folder uses its parent', () => {
    expect(craftRootFromPick('D:\\Apps')).toBe('D:\\Apps');
    expect(craftRootFromPick('D:\\Apps\\PhotoCraft')).toBe('D:\\Apps');
    const file = path.join(os.tmpdir(), `craft-root-${process.pid}.json`);
    saveCraftUserRoot(file, 'D:\\Apps');
    expect(craftInstallDir('PhotoCraft', 'win32', { ProgramFiles: 'C:\\Program Files' }, (p) => p === 'D:\\Apps\\PhotoCraft')).toBe('D:\\Apps\\PhotoCraft');
    saveCraftUserRoot(file, '');
    loadCraftUserRoot(file);
    expect(craftInstallRoots('win32', { ProgramFiles: 'C:\\Program Files' })).toEqual(['C:\\Program Files']);
    fs.rmSync(file, { force: true });
  });
  it('finds an app wherever Windows says it was installed, or on any drive, and survives a failing registry', async () => {
    const reg = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PhotoCraft',
      '    InstallLocation    REG_SZ    E:\\Tools\\PhotoCraft',
      '    DisplayIcon    REG_SZ    "G:\\My Apps\\WordCraft\\wordcraft.exe",0',
    ].join('\r\n');
    expect(parseRegistryDirs(reg, ['PhotoCraft', 'WordCraft', 'PdfCraft'])).toEqual(new Map([['photocraft', ['E:\\Tools\\PhotoCraft']], ['wordcraft', ['G:\\My Apps\\WordCraft']]]));
    const real = new Set(['E:\\Tools\\PhotoCraft', 'G:\\My Apps\\WordCraft', 'D:\\Program Files\\PdfCraft']);
    await discoverCraftDirs(['PhotoCraft', 'WordCraft', 'PdfCraft', 'FilmCraft'], { os: 'win32', run: async () => reg, exists: async (p) => real.has(p), drives: ['C:\\', 'D:\\'] });
    const env = { ProgramFiles: 'C:\\Program Files' };
    expect(craftInstallDir('PhotoCraft', 'win32', env, (p) => real.has(p))).toBe('E:\\Tools\\PhotoCraft');
    expect(craftInstallDir('WordCraft', 'win32', env, (p) => real.has(p))).toBe('G:\\My Apps\\WordCraft');
    expect(craftInstallDir('PdfCraft', 'win32', env, (p) => real.has(p))).toBe('D:\\Program Files\\PdfCraft');
    expect(craftInstallDir('FilmCraft', 'win32', env, (p) => real.has(p))).toBe('C:\\Program Files\\FilmCraft');
    expect(craftSearchedPlaces('PhotoCraft', 'win32', env)).toContain('E:\\Tools\\PhotoCraft');
    await discoverCraftDirs(['PhotoCraft'], { os: 'win32', run: async () => { throw new Error('reg failed'); }, exists: async () => false, drives: [] });
    expect(craftSearchedPlaces('PhotoCraft', 'win32', env)).toEqual(['C:\\Program Files\\PhotoCraft']);
  });
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

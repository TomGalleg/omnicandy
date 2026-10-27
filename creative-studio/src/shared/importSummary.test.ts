import { describe, expect, it } from 'vitest';
import { importSummary } from './importSummary';
import type { ImportResult } from './ipc';
import type { Asset } from './types';

const asset = (name: string) => ({ id: name, name } as unknown as Asset);
const r = (o: Partial<ImportResult>): ImportResult => ({ imported: [], duplicates: [], errors: [], ...o });

describe('importSummary', () => {
  it('says what was added, what was already there and what failed', () => {
    expect(importSummary(r({ imported: [asset('a.png')] }))).toEqual({ text: 'Added 1 file to your library.', error: false });
    expect(importSummary(r({ imported: [asset('a'), asset('b')], duplicates: [{ name: 'c', duplicateOf: 'x' }] })).text).toBe('Added 2 files to your library. 1 file was already in the library (not copied again).');
    expect(importSummary(r({ duplicates: [{ name: 'c', duplicateOf: 'x' }, { name: 'd', duplicateOf: 'y' }] })).text).toMatch(/2 files were already/);
  });
  it('is an error only when nothing could be added at all', () => {
    expect(importSummary(r({ errors: ['x.exe: Unsupported file type ".exe".'] })).error).toBe(true);
    expect(importSummary(r({ imported: [asset('a')], errors: ['x.exe: no'] })).error).toBe(false);
    expect(importSummary(r({ errors: ['1', '2', '3', '4', '5'] })).text).toBe('Could not add: 1; 2; 3; and 2 more.');
    expect(importSummary(r({ imported: [asset('a')], errors: ['x.exe: Unsupported file type ".exe".'] })).text).toBe('Added 1 file to your library. Could not add: x.exe: Unsupported file type ".exe".');
    expect(importSummary(r({}))).toEqual({ text: 'Nothing was added. Drop pictures, videos or sounds from your computer.', error: false });
  });
});

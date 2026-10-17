import { describe, expect, it } from 'vitest';
import { binName, exeSuffix, osFrom, supportsOs } from './platform';

describe('platform (pure)', () => {
  it('maps Node platforms to the known systems', () => {
    expect(osFrom('win32')).toBe('win32');
    expect(osFrom('darwin')).toBe('darwin');
    expect(osFrom('linux')).toBe('linux');
    expect(osFrom('freebsd')).toBe('linux');
  });
  it('adds .exe on Windows only', () => {
    expect(exeSuffix('win32')).toBe('.exe');
    expect(binName('photocraft-cli', 'win32')).toBe('photocraft-cli.exe');
    expect(binName('photocraft-cli', 'linux')).toBe('photocraft-cli');
  });
  it('treats a missing platform list as Windows only (what existing packages were tested for)', () => {
    expect(supportsOs(undefined, 'win32')).toBe(true);
    expect(supportsOs(undefined, 'linux')).toBe(false);
    expect(supportsOs([], 'linux')).toBe(false);
    expect(supportsOs(['win32', 'linux'], 'linux')).toBe(true);
  });
});

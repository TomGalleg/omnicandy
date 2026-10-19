// Operating-system facts that are pure (no Node, no Electron) so they can be unit-tested with an injected OS.
// The platform-specific behaviour itself lives in src/main/platform/.

export type OsId = 'win32' | 'linux' | 'darwin';

/** Maps Node's `process.platform` to the three systems OmniCandi knows about (anything else is treated as Linux-like). */
export const osFrom = (platform: string): OsId => (platform === 'win32' || platform === 'darwin' ? platform : 'linux');

export const currentOs = (): OsId => osFrom((globalThis as { process?: { platform?: string } }).process?.platform ?? 'win32');

export const OS_LABEL: Record<OsId, string> = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };

/** `.exe` on Windows, nothing elsewhere. */
export const exeSuffix = (os: OsId = currentOs()): string => (os === 'win32' ? '.exe' : '');

/** A program's file name on this system: `binName('photocraft-cli')` is `photocraft-cli.exe` on Windows. */
export const binName = (base: string, os: OsId = currentOs()): string => `${base}${exeSuffix(os)}`;

/** Where a command or package says it can run. Missing means Windows only: that is what every existing package was built and tested for. */
export const DEFAULT_PLATFORMS: readonly OsId[] = ['win32'];
export const supportsOs = (platforms: readonly string[] | undefined, os: OsId = currentOs()): boolean => (platforms?.length ? platforms : DEFAULT_PLATFORMS).includes(os);

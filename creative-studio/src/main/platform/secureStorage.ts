// Is there a secure place for API keys on this computer? Windows: Electron safeStorage uses DPAPI (per Windows user).
// Linux: Electron picks a backend at start-up; only the desktop keyrings protect keys (GNOME Keyring through libsecret, or KWallet).
// The `basic_text` backend stores keys with a hard-coded key, which is obfuscation, not protection, so it is rejected, and an
// unknown backend is rejected too. Nothing else in CreateCraft depends on credentials, so those features keep working.
import { currentOs, type OsId } from '@shared/platform';

/** The slice of Electron's safeStorage this module needs (an interface so tests can inject any backend). */
export interface StorageSource {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  /** Linux only. */
  getSelectedStorageBackend?(): string;
}

export interface SecureStorageStatus {
  available: boolean;
  /** Short plain-language name of what protects the keys, or why nothing does. */
  label: string;
  problem: string | null;
  /** What to do about it, with no secrets in it. */
  help: string | null;
}

const LINUX_SECURE = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const LABEL: Record<string, string> = { gnome_libsecret: 'GNOME Keyring', kwallet: 'KWallet', kwallet5: 'KWallet', kwallet6: 'KWallet' };

const LINUX_HELP = 'Install and unlock a keyring, then restart CreateCraft: on GNOME or Ubuntu install "gnome-keyring" and "libsecret-1-0" and log in to a desktop session that starts it (the "Passwords and Keys" app should show a Login keyring); on KDE use KWallet. CreateCraft will not store keys in plain text. Everything that does not need a saved key (projects, Planner, workflows, a Claude login handled by Claude itself) keeps working.';

export function secureStorageStatus(src: StorageSource, os: OsId = currentOs()): SecureStorageStatus {
  if (os !== 'linux') {
    const ok = src.isEncryptionAvailable();
    const name = os === 'win32' ? 'Windows protected storage' : 'the system keychain';
    return ok ? { available: true, label: name, problem: null, help: null } : { available: false, label: 'unavailable', problem: `${name[0]?.toUpperCase()}${name.slice(1)} is not available, so keys cannot be saved safely.`, help: null };
  }
  let backend = 'unknown';
  try { backend = src.getSelectedStorageBackend?.() ?? 'unknown'; } catch { backend = 'unknown'; }
  if (!src.isEncryptionAvailable() || backend === 'basic_text' || !LINUX_SECURE.has(backend)) {
    const why = LINUX_SECURE.has(backend) ? `CreateCraft asked for the keyring (${LABEL[backend] ?? backend}), but none is running or it is locked, so Electron cannot use it.` : backend === 'basic_text' ? 'No keyring was found, so Electron fell back to its plain "basic_text" storage, which does not protect keys.' : backend === 'unknown' ? 'CreateCraft could not tell which secure storage is in use.' : `The storage backend "${backend}" is not a supported keyring.`;
    return { available: false, label: 'unavailable', problem: `${why} API keys cannot be saved safely on this computer yet.`, help: LINUX_HELP };
  }
  return { available: true, label: LABEL[backend] ?? backend, problem: null, help: null };
}

/**
 * Linux: Chromium only looks for a keyring when it recognises the desktop (GNOME, KDE and the like through XDG_CURRENT_DESKTOP).
 * On anything else (a tiling window manager, WSL, a bare session) it silently picks `basic_text` even when a Secret Service
 * (GNOME Keyring, KeePassXC...) is running; verified on Ubuntu 24.04 under WSL2. libsecret talks to any Secret Service, so
 * for unrecognised desktops we ask for it explicitly. If there is no service the backend is then unavailable, not plain text.
 * Returns the value for Chromium's `password-store` switch, or null to leave the choice to Chromium (also when the user set one).
 */
export function passwordStoreSwitch(os: OsId, env: NodeJS.ProcessEnv, argv: readonly string[] = []): 'gnome-libsecret' | null {
  if (os !== 'linux' || env.CREATECRAFT_PASSWORD_STORE === 'chromium' || argv.some((a) => a.startsWith('--password-store'))) return null;
  const desktop = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase();
  const known = /gnome|unity|cinnamon|mate|budgie|pantheon|deepin|xfce|lxqt|kde|plasma|cosmic/.test(desktop);
  return known ? null : 'gnome-libsecret';
}

/** An Encryptor for the vault that says "unavailable" whenever the platform check does, and explains why. */
export function secureEncryptor(src: StorageSource, os: OsId = currentOs()) {
  return {
    isEncryptionAvailable: () => secureStorageStatus(src, os).available,
    unavailableReason: () => { const s = secureStorageStatus(src, os); return [s.problem, s.help].filter(Boolean).join(' '); },
    encryptString: (s: string) => src.encryptString(s),
    decryptString: (b: Buffer) => src.decryptString(b),
  };
}

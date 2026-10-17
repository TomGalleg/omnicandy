import { describe, expect, it } from 'vitest';
import { passwordStoreSwitch, secureEncryptor, secureStorageStatus, type StorageSource } from './secureStorage';

const src = (available: boolean, backend?: string): StorageSource => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
  ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
});

describe('secure credential storage', () => {
  it('Windows follows Electron (DPAPI)', () => {
    expect(secureStorageStatus(src(true), 'win32')).toMatchObject({ available: true, label: 'Windows protected storage' });
    expect(secureStorageStatus(src(false), 'win32').available).toBe(false);
  });
  it('Linux accepts GNOME Keyring and KWallet', () => {
    expect(secureStorageStatus(src(true, 'gnome_libsecret'), 'linux')).toMatchObject({ available: true, label: 'GNOME Keyring' });
    for (const b of ['kwallet', 'kwallet5', 'kwallet6']) expect(secureStorageStatus(src(true, b), 'linux')).toMatchObject({ available: true, label: 'KWallet' });
  });
  it('Linux rejects basic_text even though Electron says encryption is available', () => {
    const s = secureStorageStatus(src(true, 'basic_text'), 'linux');
    expect(s.available).toBe(false);
    expect(s.problem).toMatch(/basic_text/);
    expect(s.help).toMatch(/gnome-keyring/);
  });
  it('Linux rejects an unknown backend and a missing backend report', () => {
    expect(secureStorageStatus(src(true, 'weird'), 'linux').available).toBe(false);
    expect(secureStorageStatus(src(true), 'linux').available).toBe(false);
    const down = secureStorageStatus(src(false, 'gnome_libsecret'), 'linux');
    expect(down.available).toBe(false);
    expect(down.problem).toMatch(/none is running or it is locked/);
  });
  it('the vault encryptor says no, and explains, without ever touching a secret', () => {
    const e = secureEncryptor(src(true, 'basic_text'), 'linux');
    expect(e.isEncryptionAvailable()).toBe(false);
    expect(e.unavailableReason()).toMatch(/keyring/);
    expect(secureEncryptor(src(true, 'gnome_libsecret'), 'linux').isEncryptionAvailable()).toBe(true);
  });
  it('asks for libsecret only on Linux desktops Chromium would not recognise', () => {
    expect(passwordStoreSwitch('linux', {})).toBe('gnome-libsecret');
    expect(passwordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: 'sway' })).toBe('gnome-libsecret');
    expect(passwordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBeNull();
    expect(passwordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: 'KDE' })).toBeNull();
    expect(passwordStoreSwitch('linux', {}, ['--password-store=kwallet5'])).toBeNull();
    expect(passwordStoreSwitch('linux', { CREATECRAFT_PASSWORD_STORE: 'chromium' })).toBeNull();
    expect(passwordStoreSwitch('win32', {})).toBeNull();
  });
});

// Where the connectors that ship with CreateCraft live, and which publisher keys CreateCraft itself vouches for.
//
// Development: <repo>/resources/adapters. Installed application: <install>/resources/adapters (electron-builder
// extraResources, outside the asar archive so the files stay plain, hashable packages). Nothing here depends on the
// repository layout once the application is installed.

import fs from 'node:fs';
import path from 'node:path';

export interface BundledPaths { adaptersDir: string; publishersFile: string }

export function bundledPaths(o: { packaged: boolean; resourcesPath: string; appPath: string }): BundledPaths {
  const root = o.packaged ? o.resourcesPath : path.join(o.appPath, 'resources');
  return { adaptersDir: path.join(root, 'adapters'), publishersFile: path.join(root, 'trust', 'release-publishers.json') };
}

/**
 * Fingerprints of OFFICIAL release signing keys (public information). Empty until a real release key exists. A development
 * key is never listed here: release-check.mjs refuses to stage a build whose bundled packages are signed by an unlisted key.
 */
export function loadBundledPublishers(file: string): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { publishers?: Array<{ fingerprint?: unknown; name?: unknown }> };
    return (j.publishers ?? []).map((p) => (typeof p.fingerprint === 'string' ? p.fingerprint.toUpperCase() : '')).filter((f) => /^([0-9A-F]{4} ){7}[0-9A-F]{4}$/.test(f));
  } catch { return []; }
}

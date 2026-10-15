// REAL detection of installed ArtCraft apps: checks that the CLI exists and asks it for --version.
// It does not open documents or start control sessions, so `connected` is always false here.
// Capabilities listed are the ones verified headless in docs/integration-audit.md, not live control.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppProbeResult } from '@shared/types';

export interface ArtCraftAppDef {
  id: string;
  displayName: string;
  folder: string;
  cli: string;
  /** Headless capabilities verified in the Phase 0 audit. */
  auditedHeadless: string[];
  /** Version line ("major.minor") the integration was verified against; others get a warning note. */
  testedVersion?: string;
}

export const ARTCRAFT_APPS: ArtCraftAppDef[] = [
  { id: 'photocraft', displayName: 'PhotoCraft', folder: 'PhotoCraft', cli: 'photocraft-cli.exe', auditedHeadless: ['open', 'edit', 'save', 'export', 'layers'] },
  { id: 'vectorcraft', displayName: 'VectorCraft', folder: 'VectorCraft', cli: 'vectorcraft-cli.exe', auditedHeadless: [] },
  { id: 'lightcraft', displayName: 'LightCraft', folder: 'LightCraft', cli: 'lightcraft-cli.exe', auditedHeadless: [] },
  { id: 'effectcraft', displayName: 'EffectCraft', folder: 'EffectCraft', cli: 'effectcraft-cli.exe', auditedHeadless: [] },
  { id: 'designcraft', displayName: 'DesignCraft', folder: 'DesignCraft', cli: 'designcraft-cli.exe', auditedHeadless: [] },
  { id: 'soundcraft', displayName: 'SoundCraft', folder: 'SoundCraft', cli: 'soundcraft-cli.exe', auditedHeadless: [] },
  { id: 'filmcraft', displayName: 'FilmCraft', folder: 'FilmCraft', cli: 'filmcraft-cli.exe', auditedHeadless: [] },
  { id: 'wordcraft', displayName: 'WordCraft', folder: 'WordCraft', cli: 'wordcraft-cli.exe', auditedHeadless: ['convert', 'run', 'render', 'mcp'], testedVersion: '0.7' },
  { id: 'pdfcraft', displayName: 'PdfCraft', folder: 'PdfCraft', cli: 'pdfcraft-cli.exe', auditedHeadless: ['info', 'render', 'text', 'edit', 'run', 'mcp'], testedVersion: '0.8' },
];

function runVersion(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    // execFile with a fixed argv: no shell, no user-controlled arguments.
    execFile(exe, ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim().split(/\r?\n/)[0] ?? null);
    });
  });
}

export async function probeArtCraftApp(def: ArtCraftAppDef, programFiles: string): Promise<AppProbeResult> {
  const exe = path.join(programFiles, def.folder, def.cli);
  const installed = await fs.access(exe).then(() => true, () => false);
  if (!installed) {
    return { appId: def.id, displayName: def.displayName, installed: false, connected: false, version: null, capabilities: [], notes: ['Not installed.'] };
  }
  const version = await runVersion(exe);
  const tested = def.testedVersion;
  const found = version ? /(d+.d+).d+/.exec(version)?.[1] : undefined;
  const mismatch = tested && found && found !== tested ? [`Version ${found} is newer or older than the ${tested} this integration was tested with; some controls may differ.`] : [];
  return {
    appId: def.id,
    displayName: def.displayName,
    installed: true,
    connected: false,
    version,
    capabilities: def.auditedHeadless,
    notes: [
      ...mismatch,
      def.auditedHeadless.length
        ? 'Headless CLI verified in audit; live app control not yet wired.'
        : 'MCP handshake verified in audit; operations not yet tested.',
    ],
  };
}

export async function probeAllArtCraftApps(programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'): Promise<AppProbeResult[]> {
  return Promise.all(ARTCRAFT_APPS.map((d) => probeArtCraftApp(d, programFiles)));
}

// Per-user appearance settings persisted as JSON in the app's userData directory.
// Holds no secrets; credentials belong to the CredentialVault.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppearanceSettings } from '@shared/types';
import { DEFAULT_APPEARANCE, sanitizeAppearance } from '@shared/theme';

export class SettingsStore {
  constructor(private readonly dir: string) {}
  private get file() { return path.join(this.dir, 'appearance.json'); }

  async load(): Promise<AppearanceSettings> {
    try {
      return sanitizeAppearance(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch {
      return { ...DEFAULT_APPEARANCE };
    }
  }

  async save(raw: unknown): Promise<AppearanceSettings> {
    const s = sanitizeAppearance(raw);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
    return s;
  }
}

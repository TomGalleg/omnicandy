// AI Studio job list, saved in the project so it survives restarts. Holds prompts, settings and results only:
// never keys. A job saved as "running" comes back as failed (loadJobs), so nothing paid is ever re-sent by itself.

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadJobs, MAX_JOBS, type StudioJob } from '@shared/aiStudio';

export class StudioJobStore {
  constructor(private readonly dir: () => Promise<string>) {}

  private async file() { return path.join(await this.dir(), 'studio-jobs.json'); }

  async list(): Promise<StudioJob[]> {
    try { return loadJobs(await fs.readFile(await this.file(), 'utf8')); } catch { return []; }
  }

  async save(jobs: StudioJob[]): Promise<StudioJob[]> {
    const kept = jobs.slice(0, MAX_JOBS);
    const file = await this.file();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(kept), 'utf8');
    await fs.rename(tmp, file);
    return kept;
  }
}

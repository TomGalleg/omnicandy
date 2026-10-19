// Per-user private state of the external application layer: permission grants, locations the user added
// (Browse), locations remembered from earlier scans, and whether guided setup has been completed once.
// One small JSON file; writes are serialised so concurrent updates (a scan saving remembered paths while the
// user forgets one) never lose each other.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Permission } from '@shared/integrations';

export interface ExternalStateData {
  grants: Record<string, Permission[]>;
  /** Programs or folders the user chose by hand. */
  paths: string[];
  /** Program locations found through records that can vanish (uninstall entries, shortcuts). */
  remembered: string[];
  /** The guided setup has been finished at least once. */
  onboarded: boolean;
  /** Applications the user connected and has not disconnected: reconnected automatically when OmniCandi starts. */
  connected: string[];
}

const same = (a: string, b: string) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

/** The ways a user-chosen location can name this program: the file, its folder, or (inside `bin`) the install folder. */
export function nameSake(p: string): (x: string) => boolean {
  const dir = path.dirname(p);
  const root = path.basename(dir).toLowerCase() === 'bin' ? path.dirname(dir) : null;
  return (x) => same(x, p) || same(x, dir) || (!!root && same(x, root));
}

export class ExternalState {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<ExternalStateData> {
    try {
      const j = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<ExternalStateData>;
      return { grants: j.grants ?? {}, paths: j.paths ?? [], remembered: j.remembered ?? [], onboarded: j.onboarded === true, connected: Array.isArray(j.connected) ? j.connected.filter((k): k is string => typeof k === 'string') : [] };
    } catch { return { grants: {}, paths: [], remembered: [], onboarded: false, connected: [] }; }
  }

  /** Read-modify-write, one at a time. */
  update(fn: (s: ExternalStateData) => ExternalStateData | void): Promise<ExternalStateData> {
    const run = this.queue.then(async () => {
      const cur = await this.read();
      const next = fn(cur) ?? cur;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(next, null, 2), 'utf8');
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  addPath(p: string): Promise<ExternalStateData> {
    return this.update((s) => { if (!s.paths.some((x) => same(x, p))) s.paths = [...s.paths, p].slice(-50); });
  }

  /** Removes a location from both lists; returns whether anything was removed. */
  async removePath(p: string): Promise<boolean> {
    let removed = false;
    await this.update((s) => {
      const hit = nameSake(p);
      const paths = s.paths.filter((x) => !hit(x));
      const remembered = s.remembered.filter((x) => !hit(x));
      removed = paths.length !== s.paths.length || remembered.length !== s.remembered.length;
      s.paths = paths;
      s.remembered = remembered;
    });
    return removed;
  }

  async hasPath(p: string): Promise<boolean> {
    const s = await this.read();
    const hit = nameSake(p);
    return s.paths.some(hit) || s.remembered.some(hit);
  }

  markOnboarded(): Promise<ExternalStateData> { return this.update((s) => { s.onboarded = true; }); }
}

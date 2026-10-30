// Each project keeps its own team access settings in its own folder (team-access.json), apart from the plan. Reading is forgiving (a damaged file means
// "use the defaults", which are the safe ones); writing is atomic. Policies are read fresh for every action, so a change here applies at the next call.
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ACCESS_LEVELS, CAPABILITIES, PRESETS, defaultPolicy, type AccessLevel, type AccessPolicy, type Capability, type Preset } from '../../shared/teamAccess';
import { writeJsonAtomic } from '../projectStore';

export const POLICY_FILE = 'team-access.json';
const level = z.enum(ACCESS_LEVELS);
const caps = z.partialRecord(z.enum(CAPABILITIES), level);
const policySchema = z.object({
  version: z.literal(1), workerId: z.string().min(1).max(80), preset: z.enum(PRESETS), levels: caps.optional(), ceiling: caps.optional(),
  scope: z.union([z.object({ kind: z.literal('project') }), z.object({ kind: z.literal('task'), taskId: z.string().max(80).optional() })]),
  resources: z.array(z.string().max(300)).max(200).optional(), spendCapCents: z.number().int().min(0).max(100_000_00).optional(),
  spentCents: z.number().int().min(0), expiresAt: z.string().max(40).optional(), revoked: z.boolean().optional(),
});
const fileSchema = z.object({ version: z.literal(1), workers: z.record(z.string(), z.unknown()) });

export class PolicyStore {
  constructor(private readonly dir: string) {}
  private async all(): Promise<Record<string, unknown>> {
    try { const f = fileSchema.safeParse(JSON.parse(await fs.readFile(path.join(this.dir, POLICY_FILE), 'utf8'))); return f.success ? f.data.workers : {}; } catch { return {}; }
  }
  /** The worker's saved policy, or the safe default. The toolbox ceiling is always applied on top, so a saved file can never grant more than the job needs. */
  async get(workerId: string, ceiling?: Partial<Record<Capability, AccessLevel>>, preset?: Preset): Promise<AccessPolicy> {
    const saved = policySchema.safeParse((await this.all())[workerId]);
    const base = saved.success ? (saved.data as AccessPolicy) : { ...defaultPolicy(workerId), ...(preset ? { preset } : {}) };
    return ceiling ? { ...base, workerId, ceiling } : { ...base, workerId };
  }
  async save(p: AccessPolicy): Promise<void> {
    const parsed = policySchema.parse(p);
    const workers = await this.all();
    await writeJsonAtomic(path.join(this.dir, POLICY_FILE), { version: 1, workers: { ...workers, [parsed.workerId]: parsed } });
  }
  /** Switches a worker off (or back on). Takes effect at their very next action. */
  async setRevoked(workerId: string, revoked: boolean): Promise<AccessPolicy> {
    const p = { ...(await this.get(workerId)), revoked }; delete (p as { ceiling?: unknown }).ceiling;
    if (!revoked) delete (p as { revoked?: boolean }).revoked;
    await this.save(p); return p;
  }
  /** Adds what a finished action cost, so the spending cap is a real running total. */
  async addSpend(workerId: string, cents: number): Promise<void> {
    const p = await this.get(workerId); delete (p as { ceiling?: unknown }).ceiling;
    await this.save({ ...p, spentCents: p.spentCents + Math.max(0, Math.round(cents)) });
  }
}

// The build-and-test pipeline for ONE blueprint: scan the AI code, assemble the package from the templates, run the static and
// security stages, and (only when both pass) the simulated stage. Pure of any user-interface or AI concerns, so repair,
// updates and tests all use exactly the same checks.

import type { PipelineReport } from '@shared/builder';
import type { Blueprint } from './blueprint';
import { assembleBlueprint, packAssembled, type Assembled, type AssembleOptions } from './assemble';
import { simulate } from './simulate';
import { scanPython, securityChecks, staticChecks, type ScanOutcome } from './validate';

export interface CandidateResult {
  assembled: Assembled;
  /** The finished .ccadapter bytes, or null when the template builds source only or a stage failed. */
  bytes: Buffer | null;
  files: Map<string, Buffer> | null;
  reports: PipelineReport[];
  scan: ScanOutcome;
  /** static and security passed (warnings allowed). */
  safe: boolean;
  /** every stage that ran passed or only warned. */
  passed: boolean;
}

export async function buildCandidate(bp: Blueprint, o: AssembleOptions, opts: { simulate?: boolean; onStage?: (stage: 'static' | 'security' | 'simulated') => void } = {}): Promise<CandidateResult> {
  const scan = await scanPython(bp);
  const assembled = await assembleBlueprint(bp, { ...o, usesWork: scan.usesWork });
  opts.onStage?.('static');
  const stat = await staticChecks(bp, assembled, scan);
  opts.onStage?.('security');
  const sec = await securityChecks(bp, assembled, scan);
  const reports: PipelineReport[] = [stat, sec];
  const safe = stat.state !== 'failed' && sec.state !== 'failed';
  let packed: ReturnType<typeof packAssembled> | null = null;
  if (safe && !assembled.problems.length && assembled.files.size) packed = packAssembled(assembled);
  if (safe && packed && opts.simulate !== false) {
    opts.onStage?.('simulated');
    reports.push((await simulate(bp, assembled)).report);
  }
  return { assembled, bytes: packed?.bytes ?? null, files: packed?.files ?? null, reports, scan, safe, passed: safe && reports.every((r) => r.state !== 'failed') };
}

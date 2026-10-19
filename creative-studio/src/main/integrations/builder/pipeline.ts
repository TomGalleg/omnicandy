// The build-and-test pipeline for ONE blueprint: scan the AI code, assemble the package from the templates, run the static and
// security stages, and (only when both pass) the simulated stage. Pure of any user-interface or AI concerns, so repair,
// updates and tests all use exactly the same checks.

import type { PipelineReport } from '@shared/builder';
import type { Blueprint } from './blueprint';
import { assembleBlueprint, packAssembled, type Assembled, type AssembleOptions } from './assemble';
import { simulate } from './simulate';
import { scanPython, securityChecks, staticChecks, type ScanOutcome } from './validate';
import { buildIndex, citationNeeds, completeCitations, type CompletionResult } from './docsIndex';
import type { StoredDoc } from './docsStore';
import { resolvePythonHost } from './templates/python';

export interface CandidateResult {
  assembled: Assembled;
  /** The finished .ccadapter bytes, or null when the template builds source only or a stage failed. */
  bytes: Buffer | null;
  files: Map<string, Buffer> | null;
  reports: PipelineReport[];
  scan: ScanOutcome;
  /** The blueprint that was built (citations may have been completed from the documentation). */
  blueprint: Blueprint;
  /** Citations OmniCandi completed from collected documentation, and symbols no document contains. */
  citations: { added: CompletionResult['added']; unresolved: CompletionResult['unresolved'] };
  /** static and security passed (warnings allowed). */
  safe: boolean;
  /** every stage that ran passed or only warned. */
  passed: boolean;
}

export async function buildCandidate(bp: Blueprint, o: AssembleOptions, opts: { simulate?: boolean; docs?: StoredDoc[]; onStage?: (stage: 'static' | 'security' | 'simulated') => void } = {}): Promise<CandidateResult> {
  let scan = await scanPython(bp);
  let citations: CandidateResult['citations'] = { added: [], unresolved: [] };
  let docCtx: { index: ReturnType<typeof buildIndex>; coreModules: string[] } | undefined;
  if (opts.docs?.length && bp.decision.template === 'python-script' && scan.guard) {
    const index = buildIndex(opts.docs);
    const coreModules = resolvePythonHost(bp).host.coreModules;
    const needs: Record<string, ReturnType<typeof citationNeeds>> = {};
    for (const c of bp.commands) needs[c.id] = citationNeeds(scan.guard.findings.filter((f) => f.name.startsWith(`${c.id}#`)));
    const done = completeCitations(bp, needs, index, coreModules);
    bp = done.blueprint;
    citations = { added: done.added, unresolved: done.unresolved };
    scan = await scanPython(bp);
    docCtx = { index, coreModules };
  }
  const assembled = await assembleBlueprint(bp, { ...o, usesWork: scan.usesWork });
  opts.onStage?.('static');
  const stat = await staticChecks(bp, assembled, scan);
  opts.onStage?.('security');
  const sec = await securityChecks(bp, assembled, scan, docCtx);
  const reports: PipelineReport[] = [stat, sec];
  const safe = stat.state !== 'failed' && sec.state !== 'failed';
  let packed: ReturnType<typeof packAssembled> | null = null;
  if (safe && !assembled.problems.length && assembled.files.size) packed = packAssembled(assembled);
  if (safe && packed && opts.simulate !== false) {
    opts.onStage?.('simulated');
    reports.push((await simulate(bp, assembled)).report);
  }
  return { assembled, bytes: packed?.bytes ?? null, files: packed?.files ?? null, reports, scan, blueprint: bp, citations, safe, passed: safe && reports.every((r) => r.state !== 'failed') };
}

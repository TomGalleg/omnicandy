// The copy-and-paste side of the planner: an execution package as readable Markdown, the instructions that tell an executor how
// to report, and a tolerant reader for a pasted report (JSON or Markdown). Reading never applies anything: the user sees a
// preview, including what was uncertain, and the original response is kept.
import type { Actor, ActorKind, ExecPackage, ReportDraft } from './planner';
import { ACTOR_KINDS, reportDraftSchema } from './planner';

export function reportInstructionsFor(pkg: Pick<ExecPackage, 'id' | 'tasks'>, projectTitle: string): string {
  const example = {
    packageId: pkg.id, taskId: pkg.tasks[0]?.id ?? 'task_...', executor: { name: 'your name', kind: 'claude-code' },
    outcome: 'complete | partial | blocked | failed',
    workPerformed: 'What you actually did, in plain words.',
    outputs: [{ description: 'what it is', path: 'where it is' }],
    changedFiles: ['path/of/each/changed/file'],
    verification: (pkg.tasks[0]?.completionChecks ?? [{ id: 'chk_...', text: 'check' }]).map((c) => ({ checkId: c.id, check: c.text, result: 'pass | fail | not_run', details: 'what you ran and saw' })),
    blockers: [], limitations: [], unresolvedQuestions: [], proposedChanges: [],
  };
  return [
    `Report back for each task separately, for project "${projectTitle}".`,
    '- Say only what you did and what you actually checked. "not_run" is a fine answer; a check you did not run must not be reported as passed.',
    '- Your report is a claim of completion. The user reviews and accepts it; nothing is accepted automatically.',
    '- Do not change the plan yourself. Put suggested requirement, decision or task changes in proposedChanges.',
    '- If a connection tool is available, call submit_report. Otherwise reply with this JSON (or a Markdown report with the headings Outcome, Work performed, Outputs, Verification, Blockers, Limitations, Questions):',
    '```json', JSON.stringify(example, null, 2), '```',
  ].join('\n');
}

const bullets = (items: string[], empty = '- (none)') => (items.length ? items.map((x) => `- ${x}`).join('\n') : empty);

export function packageToMarkdown(pkg: ExecPackage, projectTitle: string): string {
  const p = pkg.plan;
  const out: string[] = [
    `# Execution package ${pkg.number}: ${projectTitle}`,
    `Package id: \`${pkg.id}\` · project id: \`${pkg.projectId}\` · plan revision: ${pkg.planRevision} · created ${pkg.createdAt}`,
    '', '## Objective', pkg.objective, '', '## Context', p.goal || '(no goal written)', p.description ? `\n${p.description}` : '',
    '', '## Accepted requirements', bullets(p.requirements.map((r) => `**${r.title}**${r.text ? `: ${r.text}` : ''}  \`${r.id}\``)),
    '', '## Accepted decisions', bullets(p.decisions.map((d) => `**${d.title}**${d.text ? `: ${d.text}` : ''}${d.reason ? ` (why: ${d.reason})` : ''}  \`${d.id}\``)),
    '', '## Scope', p.scope || '(not stated)', '', '## Constraints', bullets(p.constraints), '',
    '## Project deliverables', bullets(p.deliverables), '', '## Relevant assets',
    bullets(pkg.assets.map((a) => `${a.title} [${a.role}] ${a.path || a.url || (a.source === 'createcraft' ? '(CreateCraft asset)' : '')}${a.note ? ` - ${a.note}` : ''}`)),
    '', '## Tasks',
  ];
  for (const t of pkg.tasks) {
    out.push(`### ${t.title}  \`${t.id}\``, `Priority: ${t.priority}${t.dependsOn.length ? ` · depends on: ${t.dependsOn.join(', ')}` : ''}${t.appRef ? ` · uses ${t.appRef.kind} ${t.appRef.id}${t.appRef.note ? ` (${t.appRef.note})` : ''}` : ''}`,
      t.description || '', '', 'Expected outputs:', bullets(t.expectedOutputs), '', 'Completion checks (report each by id):',
      bullets(t.completionChecks.map((c) => `\`${c.id}\` [${c.kind}] ${c.text}`)), '');
  }
  out.push('## How to report', pkg.reportInstructions);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---- reading a pasted report -----------------------------------------------------------------------------------------
export interface ReportImportPreview {
  format: 'json' | 'markdown' | 'unreadable';
  packageId?: string;
  taskId?: string;
  executor?: Actor;
  draft?: ReportDraft;
  /** Things the reader had to guess; shown to the user before anything is applied. */
  uncertain: string[];
  /** Problems that stop the report from being applied as it is. */
  errors: string[];
}

const kindOf = (v: unknown): ActorKind => (ACTOR_KINDS as readonly string[]).includes(String(v)) ? (v as ActorKind) : 'other';

function jsonCandidate(text: string): unknown | undefined {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  const tries: string[] = [];
  for (let m = fence.exec(text); m; m = fence.exec(text)) tries.push(m[1] ?? '');
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) { try { const v = JSON.parse(t); if (v && typeof v === 'object') return v; } catch { /* try the next */ } }
  return undefined;
}

const SECTION: Array<[RegExp, string]> = [
  [/^(outcome|status|result)$/, 'outcome'], [/^(work performed|work done|summary|what (i|was|we) (did|done)|work)$/, 'work'],
  [/^(outputs?|deliverables?|results?)$/, 'outputs'], [/^(changed files|files changed|changes)$/, 'files'],
  [/^(verification|tests?|checks?|testing)$/, 'verification'], [/^blockers?$/, 'blockers'], [/^(limitations?|caveats)$/, 'limitations'],
  [/^(questions?|unresolved questions?|open questions?)$/, 'questions'], [/^(proposed (plan )?changes|suggested changes|suggestions)$/, 'proposed'],
];

function markdownSections(text: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let cur: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const h = /^\s{0,3}(?:#{1,6}\s+|\*\*)([^*#:]+?)\s*(?:\*\*)?\s*:?\s*$/.exec(raw);
    const name = h ? (h[1] ?? '').trim().toLowerCase() : null;
    const sec = name ? SECTION.find(([re]) => re.test(name))?.[1] : undefined;
    if (sec) { cur = sec; if (!map.has(cur)) map.set(cur, []); continue; }
    const inline = /^\s*(outcome|status)\s*:\s*(.+)$/i.exec(raw);
    if (inline) { map.set('outcome', [inline[2] ?? '']); continue; }
    if (cur) map.get(cur)?.push(raw);
  }
  return map;
}

const itemsOf = (lines: string[] = []) => lines.map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim()).filter(Boolean);

export function parseReportText(text: string): ReportImportPreview {
  const trimmed = text.trim();
  const uncertain: string[] = [];
  const errors: string[] = [];
  if (!trimmed) return { format: 'unreadable', uncertain, errors: ['Nothing was pasted.'] };
  const packageId = /\bpkg_[a-z0-9]+\b/i.exec(trimmed)?.[0];
  const taskId = /\btask_[a-z0-9]+\b/i.exec(trimmed)?.[0];

  const obj = jsonCandidate(trimmed) as Record<string, unknown> | undefined;
  if (obj && typeof obj === 'object' && ('workPerformed' in obj || 'outcome' in obj)) {
    const ex = obj.executor as { name?: unknown; kind?: unknown } | string | undefined;
    const executor: Actor | undefined = typeof ex === 'string' ? { kind: 'other', name: ex } : ex?.name ? { kind: kindOf(ex.kind), name: String(ex.name).slice(0, 80) } : undefined;
    const parsed = reportDraftSchema.safeParse(obj);
    if (!parsed.success) {
      for (const i of parsed.error.issues.slice(0, 8)) errors.push(`${i.path.join('.') || 'report'}: ${i.message}`);
      return { format: 'json', packageId: String(obj.packageId ?? packageId ?? '') || undefined, taskId: String(obj.taskId ?? taskId ?? '') || undefined, ...(executor ? { executor } : {}), uncertain, errors };
    }
    if (!executor) uncertain.push('The report does not say who produced it; it will be recorded as "Pasted report".');
    return { format: 'json', packageId: obj.packageId ? String(obj.packageId) : packageId, taskId: obj.taskId ? String(obj.taskId) : taskId, ...(executor ? { executor } : {}), draft: parsed.data, uncertain, errors };
  }

  const sec = markdownSections(trimmed);
  if (!sec.has('work') && !sec.has('outcome') && !sec.has('verification')) {
    return { format: 'unreadable', packageId, taskId, uncertain, errors: ['This does not look like a report. It needs at least a "Work performed" part, or paste the JSON report.'] };
  }
  const exName = /^\s*(?:executor|by|author)\s*:\s*(.+)$/im.exec(trimmed)?.[1]?.trim();
  const executor: Actor | undefined = exName ? { kind: 'other', name: exName.slice(0, 80) } : undefined;
  if (!executor) uncertain.push('No executor named; it will be recorded as "Pasted report".');

  const work = (sec.get('work') ?? []).join('\n').trim();
  if (!work) uncertain.push('No "Work performed" part found; the outcome text is used instead.');
  const outcomeRaw = (sec.get('outcome') ?? []).join(' ').toLowerCase();
  let outcome: ReportDraft['outcome'] | undefined = (/\b(complete|completed|done|success)/.exec(outcomeRaw) ? 'complete' : /\bpartial/.test(outcomeRaw) ? 'partial' : /\bblocked/.test(outcomeRaw) ? 'blocked' : /\bfail/.test(outcomeRaw) ? 'failed' : undefined);
  const blockers = itemsOf(sec.get('blockers')).filter((b) => !/^none\.?$/i.test(b));
  if (!outcome) { outcome = blockers.length ? 'blocked' : 'partial'; uncertain.push(`The outcome was not stated; read as "${outcome}". Change it if that is wrong.`); }

  const verification: ReportDraft['verification'] = itemsOf(sec.get('verification')).map((line) => {
    const checkId = /\bchk_[a-z0-9]+\b/i.exec(line)?.[0];
    const clean = line.replace(/\bchk_[a-z0-9]+\b[:\s-]*/i, '');
    let result: 'pass' | 'fail' | 'not_run' | null = null;
    if (/(✅|✔|\bpass(ed|es)?\b|\bok\b|\bsucceed)/i.test(line) && !/(\bnot\b|\bfail)/i.test(line)) result = 'pass';
    else if (/(❌|✖|\bfail(ed|s|ure)?\b)/i.test(line)) result = 'fail';
    else if (/(not run|skipped|not verified|untested|not tested|⚠)/i.test(line)) result = 'not_run';
    if (!result) { result = 'not_run'; uncertain.push(`Verification line has no clear result, recorded as "not run": "${clean.slice(0, 80)}"`); }
    return { check: clean.slice(0, 500) || line.slice(0, 500), ...(checkId ? { checkId } : {}), result, details: '' };
  });
  if (!verification.length) uncertain.push('No verification was reported. Nothing is treated as verified.');

  const outputLines = itemsOf(sec.get('outputs'));
  const files = itemsOf(sec.get('files'));
  const proposed = itemsOf(sec.get('proposed')).map((t) => ({ op: 'add_item' as const, itemType: 'idea' as const, title: t.slice(0, 200), text: '', reason: '' }));
  if (proposed.length) uncertain.push('Suggested changes were read as new ideas for you to review; edit them into requirements, decisions or tasks if they are.');
  const draft = reportDraftSchema.safeParse({
    outcome, workPerformed: work || (sec.get('outcome') ?? []).join(' ').trim() || 'Not described.',
    outputs: outputLines.map((d) => ({ description: d.slice(0, 500), path: '' })), changedFiles: files, verification, blockers,
    limitations: itemsOf(sec.get('limitations')), unresolvedQuestions: itemsOf(sec.get('questions')), proposedChanges: proposed,
  });
  if (!draft.success) return { format: 'markdown', packageId, taskId, uncertain, errors: draft.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`) };
  return { format: 'markdown', packageId, taskId, ...(executor ? { executor } : {}), draft: draft.data, uncertain, errors };
}

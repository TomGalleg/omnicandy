// What a CreateCraft project already contains, read from its own files: the manifest (files, versions, where they came from, the saved brief), the
// exports, the workflow and the saved Claude conversation. Used for two things, both local and read-only:
//   1. "Look at what's already here": a summary and a few suggestions for the plan, shown to the owner who ticks what to keep. Nothing is assumed:
//      a project with no saved brief or history simply has fewer findings, and no chunk is ever marked as done because a file exists.
//   2. A short description of the project for the planning AI (names and counts, never file locations).
// Nothing in the project is written, moved or deleted by anything in this file.

import type { ProposalChange } from '@shared/planner';
import type { Asset, AssetKind, ProjectManifest } from '@shared/types';
import type { ProjectStore } from '../projectStore';

export interface ProjectFindings {
  projectName: string;
  /** Short plain-language facts, in the order they are shown. */
  lines: string[];
  /** Suggestions for the plan. Each one needs the owner's tick; none marks anything as done. */
  changes: ProposalChange[];
  /** A few lines about the project for the planning AI (names and counts only). */
  aiContext: string[];
  stats: { files: number; originals: number; versions: number; exports: number; workflowSteps: number; chatMessages: number; lastActivity: string | null };
}

const KIND_WORD: Partial<Record<AssetKind, [string, string]>> = {
  image: ['picture', 'pictures'], vector: ['vector drawing', 'vector drawings'], video: ['video', 'videos'], audio: ['sound', 'sounds'],
  design: ['design', 'designs'], project: ['project file', 'project files'], document: ['document', 'documents'], sheet: ['spreadsheet', 'spreadsheets'],
  deck: ['presentation', 'presentations'], ui: ['UI design', 'UI designs'], cad: ['CAD drawing', 'CAD drawings'],
};
const word = (k: string, n: number) => { const w = KIND_WORD[k as AssetKind]; return w ? (n === 1 ? w[0] : w[1]) : n === 1 ? 'file' : 'files'; };
const day = (iso: string) => (iso || '').slice(0, 10);
const clip = (t: string, n: number) => t.replace(/\s+/g, ' ').trim().slice(0, n);
const MAX_REFERENCES = 12;

/** The files worth mentioning: work that has saved versions first, newest first, then the newest others. */
function notable(m: ProjectManifest): Array<{ asset: Asset; versions: number; latest: string }> {
  const children = new Map<string, Asset[]>();
  for (const a of m.assets) if (a.parentId) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a]);
  const lineage = (a: Asset): Asset[] => (children.get(a.id) ?? []).flatMap((c) => [c, ...lineage(c)]);
  const originals = m.assets.filter((a) => !a.parentId);
  const rows = originals.map((a) => { const v = lineage(a); return { asset: a, versions: v.length, latest: [a, ...v].map((x) => x.provenance.createdAt).sort().at(-1) ?? a.provenance.createdAt }; });
  return rows.sort((x, y) => Number(y.versions > 0) - Number(x.versions > 0) || y.latest.localeCompare(x.latest));
}

export async function analyzeProject(store: ProjectStore): Promise<ProjectFindings> {
  const m = await store.loadManifest();
  const [workflow, exports, history] = await Promise.all([
    store.loadWorkflow().catch(() => null), store.listExports().catch(() => []), store.readClaudeHistory().catch(() => []),
  ]);
  const originals = m.assets.filter((a) => !a.parentId);
  const versions = m.assets.length - originals.length;
  const byKind = new Map<string, number>();
  for (const a of originals) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
  const dates = [m.updatedAt, ...m.assets.map((a) => a.provenance.createdAt)].filter(Boolean).sort();
  const lastActivity = dates.at(-1) ?? null;
  const rows = notable(m);
  const approved = m.assets.filter((a) => a.approval === 'approved').length;
  const userMessages = history.filter((h) => h.role === 'user');

  const lines: string[] = [];
  if (!m.assets.length && !exports.length && !workflow?.nodes.length && !history.length && !m.brief && !m.objective) {
    lines.push('Nothing has been made in this project yet, so there is nothing to look at. You can start from an idea.');
  } else {
    lines.push(`${m.assets.length} file${m.assets.length === 1 ? '' : 's'} in the library: ${[...byKind.entries()].map(([k, n]) => `${n} ${word(k, n)}`).join(', ') || 'none'}${versions ? `, and ${versions} saved version${versions === 1 ? '' : 's'} of them` : ''}.`);
    if (approved) lines.push(`${approved} file${approved === 1 ? ' is' : 's are'} marked approved.`);
    if (exports.length) lines.push(`${exports.length} export${exports.length === 1 ? '' : 's'} in the Exports folder: ${exports.slice(0, 4).map((e) => e.name).join(', ')}${exports.length > 4 ? '…' : ''}.`);
    if (workflow?.nodes.length) lines.push(`A workflow with ${workflow.nodes.length} step${workflow.nodes.length === 1 ? '' : 's'}.`);
    if (m.brief) lines.push(`A saved brief: "${clip(m.brief, 160)}"`);
    if (m.objective) lines.push(`What Claude was working toward: "${clip(m.objective, 160)}"`);
    if (userMessages.length) lines.push(`${userMessages.length} message${userMessages.length === 1 ? '' : 's'} you sent to Claude here. The last one: "${clip(userMessages.at(-1)!.text, 140)}"`);
    if (lastActivity) lines.push(`Last change: ${day(lastActivity)}.`);
    lines.push('CreateCraft cannot tell from files alone what was meant to be finished, so none of this is marked as done.');
  }

  const changes: ProposalChange[] = [];
  const goal = clip(m.objective ?? '', 1000);
  const brief = clip(m.brief ?? '', 4000);
  if (goal) changes.push({ op: 'set_brief', patch: { goal } });
  if (brief) changes.push({ op: 'set_brief', patch: { description: brief } });
  for (const r of rows.slice(0, MAX_REFERENCES)) {
    const where = r.asset.provenance.origin === 'generated' ? 'made with AI' : r.asset.provenance.origin === 'imported' ? 'imported' : r.asset.provenance.origin;
    changes.push({
      op: 'add_item', itemType: 'reference', title: clip(r.asset.name, 200),
      text: clip(`Already in this project: ${word(r.asset.kind, 1)}, ${where}${r.versions ? `, ${r.versions} saved version${r.versions === 1 ? '' : 's'}` : ''}, last changed ${day(r.latest)}.`, 4000), reason: '',
    });
  }
  if (rows.length > MAX_REFERENCES) changes.push({ op: 'add_item', itemType: 'reference', title: `${rows.length - MAX_REFERENCES} more files in the project library`, text: 'Not listed one by one. Open Media to see them all.', reason: '' });
  changes.push({ op: 'add_item', itemType: 'question', title: 'What is still left to do on this project?', text: 'Asked because this project already had work in it when the plan was started.', reason: '' });
  if (!brief && !goal && m.assets.length) changes.push({ op: 'add_item', itemType: 'question', title: 'What is this project for?', text: 'The project has files but no saved brief.', reason: '' });

  const aiContext = [
    `CreateCraft project: "${m.name}"${m.kind ? ` (${m.kind})` : ''}.`,
    ...(m.assets.length ? [`It already contains ${m.assets.length} file(s): ${[...byKind.entries()].map(([k, n]) => `${n} ${word(k, n)}`).join(', ')}${versions ? `; ${versions} saved version(s)` : ''}.`] : ['It does not contain any files yet.']),
    ...(rows.length ? ['Work so far (names only):', ...rows.slice(0, 8).map((r) => `- ${clip(r.asset.name, 80)}${r.versions ? ` (${r.versions} version${r.versions === 1 ? '' : 's'})` : ''}`)] : []),
    ...(exports.length ? [`Exports made: ${exports.length}.`] : []),
    ...(lastActivity ? [`Last changed: ${day(lastActivity)}.`] : []),
    'The files are the real work; the plan only tracks goals, decisions and progress. Do not say anything has been done unless the user says so.',
  ];

  return { projectName: m.name, lines, changes, aiContext, stats: { files: m.assets.length, originals: originals.length, versions, exports: exports.length, workflowSteps: workflow?.nodes.length ?? 0, chatMessages: history.length, lastActivity } };
}

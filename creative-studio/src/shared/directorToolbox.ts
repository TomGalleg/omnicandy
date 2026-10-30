// What each director's job needs, and which AI runs it. A toolbox is a short declaration, not an engine: it names the tool families the director may use and
// the most access they can ever have (their ceiling). Adding a director or a tool is adding an entry here, and a tool must also be classified in
// teamToolAccess.ts before any worker can call it. Having a toolbox is not permission: the owner's access settings still decide every call.
import type { AccessLevel, Capability } from './teamAccess';
import type { DirectorKey } from './town';

export interface MadeFile { name: string; exists: boolean; bytes: number }
export interface DirectorOutcome {
  status: 'made' | 'nothing-made' | 'stopped' | 'failed';
  /** Plain words for the owner. Never says it worked unless the files were found. */
  summary: string;
  files: MadeFile[];
  /** What the AI said, for the record. Not proof. */
  said: string;
}
/** What the owner asks for: this director, this task, and the AI they have chosen (Claude is the base). */
export interface DirectorRunRequest { director: DirectorKey; taskId: string; provider: 'claude' | 'openai' | 'gemini' }

export interface Toolbox {
  /** Tool names this director is shown (the rest are never offered). */
  tools: readonly string[];
  /** The most access the job can need. Owner settings can only go lower. */
  ceiling: Partial<Record<Capability, AccessLevel>>;
  /** Plain words: what this director does with their tools. Shown to the owner and used to brief the AI. */
  does: string;
}

const LOOK = ['get_status', 'look_at_document', 'list_files', 'planner_packages', 'planner_get_package'] as const;
const REPORT = ['planner_claim', 'planner_report'] as const;

export const TOOLBOXES: Partial<Record<DirectorKey, Toolbox>> = {
  'creative-director': {
    tools: [...LOOK, 'open_file', 'apply_edit', 'undo', 'save_version', 'new_document', 'photocraft_command', 'app_commands', 'app_command', 'export_file', 'list_export_formats',
      'list_image_models', 'generate_image', ...REPORT],
    ceiling: { 'read-project': 'allow', 'edit-project': 'allow', 'native-apps': 'allow', 'generate-media': 'allow', 'propose-plan': 'allow' },
    does: 'Makes and edits pictures and artwork with PhotoCraft, VectorCraft and AI image generation, then reports what it made.',
  },
};

/** A director with no toolbox yet can look and report, nothing more. */
export const LOOK_ONLY: Toolbox = { tools: [...LOOK, ...REPORT], ceiling: { 'read-project': 'allow', 'propose-plan': 'allow' }, does: 'Looks at the project and reports.' };
export const toolboxFor = (key: DirectorKey): Toolbox => TOOLBOXES[key] ?? LOOK_ONLY;

// ---------------------------------------------------------------------------------------------------------------------------------------------
export type EngineChoice = { engine: 'claude' } | { engine: 'harness'; provider: 'openai' | 'gemini' | 'local' };
export interface EngineInput {
  /** The AI the owner chose for the project's team. Claude is the base. */
  chosen: 'claude' | 'openai' | 'gemini' | 'local';
  /** Programs that work better on the agent harness (set per program). */
  harnessPrograms?: readonly string[];
  /** The program the work is in, if known. */
  program?: string;
  /** What is actually available right now. */
  claudeReady: boolean;
  harnessProviders: readonly ('openai' | 'gemini' | 'local')[];
}

/**
 * Claude first. Another provider chosen by the owner moves the work to the agent harness with that provider. A program marked as better on the harness uses
 * the harness too (with the chosen provider, or the first one available when Claude is chosen). Never silently falls to something not chosen without saying so:
 * the second value is the plain reason, or a problem when nothing can run.
 */
export function chooseEngine(i: EngineInput): { choice: EngineChoice | null; why: string } {
  const harnessFor = (p: 'openai' | 'gemini' | 'local') => ({ engine: 'harness' as const, provider: p });
  if (i.chosen !== 'claude') {
    return i.harnessProviders.includes(i.chosen) ? { choice: harnessFor(i.chosen), why: `You chose ${i.chosen}, so the work runs there.` } : { choice: null, why: `You chose ${i.chosen}, but it is not set up yet.` };
  }
  if (i.program && i.harnessPrograms?.includes(i.program)) {
    const p = i.harnessProviders[0];
    if (p) return { choice: harnessFor(p), why: `${i.program} works better this way, so the work runs on ${p}.` };
  }
  return i.claudeReady ? { choice: { engine: 'claude' }, why: 'Claude is the base.' } : { choice: null, why: 'Claude is not signed in yet.' };
}

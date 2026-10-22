// script.run: the open-ended Blender command (rigging, geometry nodes, simulation, UVs, anything Blender's Python can do).
//
// It is deliberately NOT a free-for-all, and not trusted like the typed commands:
//   * every run is approved by the user, who sees the exact code (destructive = asked every time, never "always allow");
//   * the code runs in a background Blender on a COPY of the project, so a script that fails leaves the project untouched;
//   * only an allow-listed set of modules is importable and file / process / network access is refused (a guard against mistakes,
//     NOT a security sandbox: the approval and the backup are the real protection);
//   * before the copy replaces the project a backup is kept, and a small run marker (before / after file hashes) lets recovery
//     prove afterwards whether the run landed: the saved file is either exactly the old one (absent) or exactly the new one (applied).
// Scripted edits are not idempotent, so a script is never replayed unless the host has proven it did not land.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { normalizeJsonParam } from '@shared/jsonParam';

export const SCRIPT_MAX_CODE = 6000;
export const SCRIPT_PARAM_MAX_CHARS = 9000;
export const SCRIPT_PARAM_MAX_DEPTH = 3;

export const scriptSchema = z.object({
  purpose: z.string().min(3).max(200),
  code: z.string().min(1).max(SCRIPT_MAX_CODE),
}).strict();
export type ScriptSpec = z.infer<typeof scriptSchema>;

/** Modules a script may import. Nothing that touches files, processes or the network. */
export const SCRIPT_ALLOWED_MODULES = ['bpy', 'bmesh', 'bpy_extras', 'mathutils', 'math', 'random', 'itertools', 'collections', 'functools', 'colorsys', 'json', 're', 'typing', 'dataclasses'] as const;
/** Names a script cannot use at all (builtins that run code or open files, and the modules behind them). */
export const SCRIPT_FORBIDDEN_NAMES = ['open', 'exec', 'eval', 'compile', 'input', 'breakpoint', 'exit', 'quit', 'help', 'globals', 'locals', 'vars', 'memoryview', 'os', 'sys', 'subprocess', 'socket', 'shutil', 'pathlib', 'importlib', 'ctypes', 'builtins', 'urllib', 'http', 'requests', 'pickle', 'marshal', 'multiprocessing', 'threading', 'asyncio'] as const;
/** Blender operators/attributes that load or save other files, run other code or end the session. */
export const SCRIPT_FORBIDDEN_ATTRS = ['python_file_run', 'python_cmd', 'quit_blender', 'open_mainfile', 'save_as_mainfile', 'save_mainfile', 'revert_mainfile', 'read_factory_settings', 'read_homefile', 'recover_last_session', 'recover_auto_save', 'addon_install', 'addon_enable', 'app_template_install', 'extension_install', 'extension_repos_sync', 'system'] as const;

export const SCRIPT_RULES = {
  allowed_modules: [...SCRIPT_ALLOWED_MODULES], forbidden_names: [...SCRIPT_FORBIDDEN_NAMES], forbidden_attrs: [...SCRIPT_FORBIDDEN_ATTRS],
};

export const scriptHashOf = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex');
export const fileHashOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const IMPORT_RE = new RegExp(`(?:^|\\n)[ \\t]*(?:import|from)[ \\t]+(?!(?:${SCRIPT_ALLOWED_MODULES.join('|')})\\b)[A-Za-z_.]`);
const NAME_RE = new RegExp(`(?<![A-Za-z0-9_.])(?:open|exec|eval|compile|input|breakpoint|exit|quit|globals|locals|vars|memoryview)\\s*\\(`);
const DUNDER_RE = /__[A-Za-z0-9_]+__/;

/** Cheap pre-approval screen so the user is not asked about code that will be refused anyway. The authoritative check is an AST walk inside Blender. */
export function validateScript(value: unknown): string | undefined {
  const r = scriptSchema.safeParse(value);
  if (!r.success) { const i = r.error.issues[0]!; return `${i.path.join('.') || 'script'}: ${i.message}`; }
  const { code } = r.data;
  if (IMPORT_RE.test(code)) return `code: only these modules may be imported: ${SCRIPT_ALLOWED_MODULES.join(', ')}.`;
  if (NAME_RE.test(code)) return 'code: open, exec, eval, compile and similar builtins are not available to scripts.';
  if (DUNDER_RE.test(code)) return 'code: double-underscore names are not available to scripts.';
  for (const n of SCRIPT_FORBIDDEN_NAMES) if (new RegExp(`(?<![A-Za-z0-9_])${n}\\.[A-Za-z_]`).test(code) && !SCRIPT_ALLOWED_MODULES.includes(n as never)) return `code: "${n}" (files, processes, network) is not available to scripts.`;
  for (const a of SCRIPT_FORBIDDEN_ATTRS) if (new RegExp(`\\.${a}\\b`).test(code)) return `code: ".${a}" (opens, saves or runs other files, or ends Blender) is not available to scripts.`;
  return undefined;
}

// ---- recovery ----

export const expectedScriptSchema = z.object({
  kind: z.literal('blender.script.run'), file: z.string().min(1).max(200), script_hash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ExpectedScript = z.infer<typeof expectedScriptSchema>;

export function expectedScriptFromParams(params: Record<string, unknown>): ExpectedScript | undefined {
  if (typeof params.file_name !== 'string') return undefined;
  const j = normalizeJsonParam(params.script, 'script', { maxChars: SCRIPT_PARAM_MAX_CHARS, maxDepth: SCRIPT_PARAM_MAX_DEPTH });
  if (!j.ok || validateScript(j.value) !== undefined) return undefined;
  const r = expectedScriptSchema.safeParse({ kind: 'blender.script.run', file: params.file_name.slice(0, 200), script_hash: scriptHashOf((j.value as ScriptSpec).code) });
  return r.success ? r.data : undefined;
}

/** What the adapter wrote about the latest script run in this project's private work folder. */
export interface ScriptMarker { file: string; script_hash: string; state: 'started' | 'swapping'; before_sha256: string; after_sha256?: string; at: string }
export type ScriptState = 'applied' | 'absent' | 'ambiguous';
export interface ScriptAssessment { outcome: ScriptState; reason: string; releasesLock: boolean }

const record = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const stem = (f: string) => path.basename(f).replace(/\.blend$/i, '').toLowerCase();

/**
 * Decides from the run marker and the CURRENT hash of the saved project file what happened to a script run:
 *  applied   - the file is exactly the validated result the run was about to swap in
 *  absent    - the file is exactly what it was before the run (the swap never happened), so the script may be run again
 *  ambiguous - the marker is missing or belongs to another script, or the file is neither (someone changed it since)
 */
export function assessScriptRun(marker: unknown, currentSha: unknown, project: { file?: unknown } | undefined, exp: { file: string; script_hash: string }): ScriptAssessment {
  const mk = (outcome: ScriptState, reason: string): ScriptAssessment => ({ outcome, reason, releasesLock: outcome !== 'ambiguous' });
  if (!project || typeof project.file !== 'string' || stem(project.file) !== stem(exp.file)) return mk('ambiguous', 'the read-back is not about the project the script was run in');
  const m = record(marker);
  if (!m || m.script_hash !== exp.script_hash || typeof m.before_sha256 !== 'string' || (typeof m.file === 'string' && stem(m.file) !== stem(exp.file))) return mk('ambiguous', 'there is no run record for this script in this project');
  if (typeof currentSha !== 'string') return mk('ambiguous', 'the saved project file cannot be read');
  if (typeof m.after_sha256 === 'string' && currentSha === m.after_sha256) return mk('applied', 'the saved project is exactly the validated result of this script');
  if (currentSha === m.before_sha256) return mk('absent', 'the saved project is exactly what it was before the script ran, so the swap never happened');
  return mk('ambiguous', 'the saved project is neither the state before nor the validated result of this script (it changed since)');
}

/** Whole-document form used by the host's recovery check (a stored scene.inspect_detail read-back). */
export function assessScriptReadback(doc: unknown, exp: ExpectedScript): ScriptAssessment {
  const data = record(record(doc)?.data);
  const project = record(data?.project);
  if (!data || !project) return { outcome: 'ambiguous', reason: 'the read-back has no structured data', releasesLock: false };
  return assessScriptRun(data.script_marker, project.file_sha256, project, exp);
}

import { describe, expect, it } from 'vitest';
import { approvalDetail } from '@shared/connect';
import { classifyCommandError } from '../../agentHarness/commandPreflight';
import { expectedEditIntent } from '../../agentHarness/editIntentJournal';
import { SCRIPT_COMMAND, SCRIPT_RUN_BODY } from './blenderScript';
import { SCRIPT_MAX_CODE, assessScriptReadback, assessScriptRun, expectedScriptFromParams, scriptHashOf, validateScript } from './blenderScriptSpec';

const ok = (code: string) => expect(validateScript({ purpose: 'test script', code }), code).toBeUndefined();
const bad = (code: string, re: RegExp) => expect(validateScript({ purpose: 'test script', code }), code).toMatch(re);

describe('script.run command', () => {
  it('is asked every time, never "always allow", and is the only command with a script parameter', () => {
    expect(SCRIPT_COMMAND).toMatchObject({ id: 'script.run', destructive: true });
    expect(SCRIPT_COMMAND.params.script).toMatchObject({ type: 'json', required: true });
    expect(SCRIPT_COMMAND.permissions).toEqual(expect.arrayContaining(['execute-scripts', 'modify-project', 'write-files']));
  });
  it('is documented to the model: approval, copy, restricted imports, not idempotent', () => {
    expect(SCRIPT_COMMAND.description).toMatch(/approves EVERY run/);
    expect(SCRIPT_COMMAND.description).toMatch(/copy of the project/);
    expect(SCRIPT_COMMAND.description).toMatch(/Not idempotent/);
  });
  it('keeps the user\'s code out of the template text: it is data in the parameter file', () => {
    expect(SCRIPT_RUN_BODY).toContain("code = _p['code']");
    expect(SCRIPT_RUN_BODY).not.toMatch(/\$\{/);
  });
});

describe('the pre-approval screen (the AST walk inside Blender is authoritative)', () => {
  it('accepts normal Blender work: rigging, geometry nodes, math, allowed imports', () => {
    ok("import bpy\narm = bpy.data.armatures.new('Rig')\nobj = bpy.data.objects.new('Rig', arm)");
    ok('import bpy, bmesh, math\nfrom mathutils import Vector\nresult = {"n": len(bpy.data.objects)}');
    ok("for ob in bpy.data.objects:\n    setattr(ob, 'hide_viewport', False)\nopened = 1");
    ok("bpy.ops.object.mode_set(mode='EDIT')");
  });
  it('refuses files, processes, network, code evaluation and escape hatches before the user is asked', () => {
    bad('import os\nos.remove("x")', /only these modules/);
    bad('import subprocess', /only these modules/);
    bad('from urllib import request', /only these modules/);
    bad('data = open("C:/secret.txt").read()', /open, exec, eval/);
    bad('exec("print(1)")', /open, exec, eval/);
    bad('x = eval("1+1")', /open, exec, eval/);
    bad('x = ().__class__.__bases__', /double-underscore/);
    bad('bpy.ops.wm.save_as_mainfile(filepath="C:/x.blend")', /save_as_mainfile/);
    bad('bpy.ops.wm.quit_blender()', /quit_blender/);
    bad('bpy.ops.script.python_file_run(filepath="x.py")', /python_file_run/);
  });
  it('enforces the schema: a purpose the user can read, bounded code, no extra fields', () => {
    expect(validateScript({ purpose: 'x', code: 'pass' })).toMatch(/purpose/);
    expect(validateScript({ purpose: 'add a rig', code: '' })).toMatch(/code/);
    expect(validateScript({ purpose: 'add a rig', code: 'x'.repeat(SCRIPT_MAX_CODE + 1) })).toMatch(/code/);
    expect(validateScript({ purpose: 'add a rig', code: 'pass', extra: 1 })).toBeTruthy();
    expect(validateScript('print(1)')).toBeTruthy();
  });
});

describe('the user is shown the exact code', () => {
  it('prints the purpose and the whole code in the approval text, not a JSON blob', () => {
    const script = JSON.stringify({ purpose: 'Add a two-bone rig', code: 'import bpy\narm = bpy.data.armatures.new("Rig")\n# line 3' });
    const t = approvalDetail({ command: { description: 'Runs a script.' }, params: { file_name: 'a.blend', script }, needed: [], destructive: true });
    expect(t).toContain('Purpose: Add a two-bone rig');
    expect(t).toContain('Code that will run (read it before you allow it)');
    expect(t).toContain('import bpy\narm = bpy.data.armatures.new("Rig")\n# line 3');
    expect(t).toContain('Settings: file_name a.blend');
    expect(t).not.toContain('\\n'); // not the escaped JSON text
    expect(t).toMatch(/asked every time/);
  });
});

const HASH = scriptHashOf('print(1)');
const BEFORE = 'a'.repeat(64);
const AFTER = 'b'.repeat(64);
const marker = (over: Record<string, unknown> = {}) => ({ file: 'a.blend', script_hash: HASH, state: 'swapping', before_sha256: BEFORE, after_sha256: AFTER, at: 'now', ...over });
const proj = { file: 'a.blend' };
const exp = { file: 'a.blend', script_hash: HASH };

describe('what the file hashes prove about a script run', () => {
  it('applied: the saved project is exactly the validated result; absent: exactly what it was before', () => {
    expect(assessScriptRun(marker(), AFTER, proj, exp)).toMatchObject({ outcome: 'applied', releasesLock: true });
    expect(assessScriptRun(marker(), BEFORE, proj, exp)).toMatchObject({ outcome: 'absent', releasesLock: true });
    expect(assessScriptRun(marker({ state: 'started', after_sha256: undefined }), BEFORE, proj, exp)).toMatchObject({ outcome: 'absent' }); // died before the swap was even prepared
    expect(assessScriptRun(marker({ after_sha256: BEFORE }), BEFORE, proj, exp).outcome).toBe('applied'); // a script that changed nothing must not be replayed
  });
  it('ambiguous (lock stays): changed since, another script, no record, wrong project, unreadable file', () => {
    const amb = (m: unknown, sha: unknown, p: { file?: unknown } | undefined = proj, e = exp) => expect(assessScriptRun(m, sha, p, e)).toMatchObject({ outcome: 'ambiguous', releasesLock: false });
    amb(marker(), 'c'.repeat(64));
    amb(marker({ script_hash: 'd'.repeat(64) }), AFTER);
    amb(null, AFTER);
    amb(marker({ state: 'started', after_sha256: undefined }), 'c'.repeat(64)); // a started run whose file is neither: cannot say
    amb(marker(), AFTER, { file: 'other.blend' });
    amb(marker({ file: 'other.blend' }), AFTER);
    amb(marker(), null);
    expect(assessScriptRun(marker(), AFTER, undefined, exp)).toMatchObject({ outcome: 'ambiguous', releasesLock: false });
  });
  it('is judged from a stored scene.inspect_detail read-back by the host', () => {
    const doc = (sha: string, m: unknown) => ({ ok: true, data: { project: { file: 'a.blend', file_sha256: sha }, script_marker: m } });
    expect(assessScriptReadback(doc(AFTER, marker()), { kind: 'blender.script.run', ...exp })).toMatchObject({ outcome: 'applied' });
    expect(assessScriptReadback(doc(BEFORE, marker()), { kind: 'blender.script.run', ...exp })).toMatchObject({ outcome: 'absent' });
    expect(assessScriptReadback({ ok: true }, { kind: 'blender.script.run', ...exp })).toMatchObject({ outcome: 'ambiguous' });
  });
});

describe('journal intent and error classification for scripts', () => {
  it('records the script hash before dispatch, from the model\'s own arguments', () => {
    const params = { file_name: 'a.blend', script: { purpose: 'print one', code: 'print(1)' } };
    expect(expectedEditIntent('external_command', { app_key: 'k', command: 'script.run', params })).toEqual({ kind: 'blender.script.run', file: 'a.blend', script_hash: HASH });
    expect(expectedEditIntent('external_command', { app_key: 'k', command: 'script.run', params: { ...params, script: { purpose: 'x', code: 'import os' } } })).toBeUndefined();
    expect(expectedScriptFromParams({ script: params.script })).toBeUndefined();
  });
  it('a script that failed on its copy is a refusal, not an uncertain edit; an injected crash around the swap is', () => {
    expect(classifyCommandError('app-error Blender stopped with exit code 1: script_error: RuntimeError: boom (line 3). The project was not changed.')).toBe('validation');
    expect(classifyCommandError('verification-failed The script finished but its result is not a Blender file; the project was not changed.')).toBe('validation');
    expect(classifyCommandError('app-error injected fault after the swap')).toBe('execution');
    expect(classifyCommandError('app-error Blender stopped with exit code 1: Reload failed')).toBe('execution');
  });
});

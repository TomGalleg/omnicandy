'use strict';
// FreeCAD integration for CreateCraft (installable package). Runs in CreateCraft's restricted adapter process:
// it can read this folder and talk to CreateCraft through `ctx`, nothing else. FreeCAD itself is started by
// CreateCraft (ctx.runApp), always as FreeCADCmd.exe with a generated job script and never with a window.
// The job script (freecad_job.py) is part of this package and is hashed with it; parameters reach it as data.
// Everything is confined to the project's work folder for this integration. See docs/external-integration-sdk.md.

const fs = require('fs');
const path = require('path');

const JOB_BODY = fs.readFileSync(path.join(__dirname, 'freecad_job.py'), 'utf8');
const JOB_FILE = '_cc_job.py';
const KINDS = new Set(['app-error', 'unsupported', 'invalid-params', 'missing-app', 'verification-failed']);
const VERSION_RE = /FreeCAD\s+(\d+(?:\.\d+){1,2})/i;
const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/;
const DOC_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}\.FCStd$/;
const OBJ_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

const tail = (s) => String(s || '').trim().split(/\r?\n/).slice(-4).join(' ').slice(0, 400);

function bad(ctx, message) { return ctx.error('invalid-params', message); }
function stem(ctx, v, what) { if (!STEM_RE.test(String(v))) throw bad(ctx, `${what} must be 1 to 60 letters, digits, spaces, "-" or "_".`); return String(v); }
function docName(ctx, v, what) {
  const s = String(v || '');
  if (!DOC_RE.test(s) || s.includes('..')) throw bad(ctx, `${what} must be a plain file name ending in .FCStd (a document in this project's FreeCAD work folder).`);
  return s;
}
function optionalOutput(ctx, v) { return v === undefined || v === '' ? undefined : stem(ctx, v, 'output'); }

async function version(ctx) {
  const r = await ctx.runApp(['--version'], { timeoutMs: 60000 });
  const m = VERSION_RE.exec(`${r.out}\n${r.err}`);
  if (!m) throw ctx.error('app-error', `FreeCADCmd did not report a version (exit ${r.code}). ${tail(r.err || r.out)}`);
  return m[1];
}

exports.probe = async (ctx) => {
  const v = await version(ctx);
  return { version: v, detail: `FreeCAD ${v} (FreeCADCmd, no window).` };
};
exports.connect = async () => undefined;
exports.healthCheck = async (ctx) => {
  try { const v = await version(ctx); return { ok: true, detail: `FreeCADCmd answers (FreeCAD ${v}). Run "Check that FreeCAD can model" for a full check.` }; }
  catch (e) { return { ok: false, detail: String(e && e.message || e) }; }
};
exports.disconnect = async () => undefined;

async function runJob(ctx, command, payload, timeoutMs) {
  if (ctx.signal.aborted) throw ctx.error('app-error', 'The operation was cancelled.');
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const head = `# CreateCraft FreeCAD job (generated). Parameters are data; they are never spliced into code.\nimport base64 as _b, json as _j\nCOMMAND = ${JSON.stringify(command)}\nPARAMS = _j.loads(_b.b64decode("${b64}").decode("utf-8"))\n`;
  ctx.progress('Preparing the FreeCAD job', 0.05);
  await ctx.writeFile(JOB_FILE, head + JOB_BODY);
  ctx.progress('FreeCAD is working', 0.2);
  const r = await ctx.runApp([JOB_FILE], { timeoutMs });
  if (ctx.signal.aborted) throw ctx.error('app-error', 'The operation was cancelled.');
  ctx.progress('Checking the result', 0.9);
  const m = /CREATECRAFT_RESULT (\{.*\})/.exec(r.out);
  if (!m) throw ctx.error('app-error', `FreeCAD did not report a result (exit ${r.code}). ${tail(r.err || r.out)}`);
  let res;
  try { res = JSON.parse(m[1]); } catch { throw ctx.error('app-error', 'FreeCAD reported an unreadable result.'); }
  if (!res.ok) throw ctx.error(KINDS.has(res.kind) ? res.kind : 'app-error', String(res.error || 'FreeCAD reported an error.').slice(0, 1000));
  const outputs = Array.isArray(res.outputs) ? res.outputs.filter((o) => typeof o === 'string') : [];
  return { message: String(res.message || 'Done.'), outputs, data: res.data, evidence: Array.isArray(res.evidence) ? res.evidence : [], verified: res.verified === true };
}

exports.execute = async (command, params, ctx) => {
  switch (command) {
    case 'app.health':
      return runJob(ctx, command, {}, 120000);
    case 'doc.create': {
      const shape = String(params.shape);
      if (!['box', 'cylinder', 'plate_with_hole'].includes(shape)) throw bad(ctx, 'shape must be box, cylinder or plate_with_hole.');
      return runJob(ctx, command, {
        name: stem(ctx, params.name, 'name'), shape,
        length: params.length, width: params.width, height: params.height, radius: params.radius, hole_diameter: params.hole_diameter,
      }, 120000);
    }
    case 'doc.inspect':
      return runJob(ctx, command, { document: docName(ctx, params.document, 'document') }, 120000);
    case 'geometry.add': {
      const shape = String(params.shape);
      if (!['box', 'cylinder', 'sphere', 'cone'].includes(shape)) throw bad(ctx, 'shape must be box, cylinder, sphere or cone.');
      return runJob(ctx, command, {
        document: docName(ctx, params.document, 'document'), shape, label: stem(ctx, params.label, 'label'), output: optionalOutput(ctx, params.output),
        length: params.length, width: params.width, height: params.height, radius: params.radius, radius2: params.radius2, x: params.x, y: params.y, z: params.z,
      }, 120000);
    }
    case 'object.set_property':
      if (!OBJ_RE.test(String(params.object))) throw bad(ctx, 'object must be an object name such as Box (see "Inspect a FreeCAD document").');
      return runJob(ctx, command, {
        document: docName(ctx, params.document, 'document'), object: String(params.object), property: String(params.property),
        value: String(params.property) === 'Label' ? String(params.value) : Number(params.value), output: optionalOutput(ctx, params.output),
      }, 120000);
    case 'param.set':
      if (!OBJ_RE.test(String(params.name))) throw bad(ctx, 'name must be a parameter name such as length (see "Inspect a FreeCAD document").');
      return runJob(ctx, command, { document: docName(ctx, params.document, 'document'), name: String(params.name), value: Number(params.value), output: optionalOutput(ctx, params.output) }, 120000);
    case 'doc.save_as':
      return runJob(ctx, command, { document: docName(ctx, params.document, 'document'), output: stem(ctx, params.output, 'output') }, 120000);
    case 'export.step':
      return runJob(ctx, command, { document: docName(ctx, params.document, 'document'), object: params.object ? String(params.object) : undefined, output: optionalOutput(ctx, params.output) }, 600000);
    case 'export.stl':
      return runJob(ctx, command, { document: docName(ctx, params.document, 'document'), object: params.object ? String(params.object) : undefined, output: optionalOutput(ctx, params.output), tolerance_mm: params.tolerance_mm }, 600000);
    default:
      throw ctx.error('unsupported', `Unknown command ${command}`);
  }
};

'use strict';
// The connector half of the CreateCraft Revit integration. It runs in CreateCraft's restricted adapter process and reaches
// the add-in INSIDE Revit only through ctx.plugin, i.e. the authenticated bridge. It never touches Revit itself.
//
// Its job is orchestration and independent checking:
//  - read commands are passed straight to the add-in (which answers from inside Revit's API context);
//  - edit commands first confirm that the project open in Revit is the one the request was made for, then ask for the edit,
//    then read the result back through a SEPARATE read command before saying it worked.

exports.probe = async () => ({ version: null, detail: 'Connector for Autodesk Revit 2027; the add-in inside Revit does the work.' });
exports.connect = async () => undefined;
// Healthy by itself; CreateCraft additionally asks the add-in inside Revit for a real answer before calling it connected.
exports.healthCheck = async () => ({ ok: true, detail: 'The connector is ready.' });
exports.disconnect = async () => undefined;

const READS = new Set(['revit.app_info', 'revit.project_info', 'revit.levels.list', 'revit.views.list', 'revit.elements.count', 'revit.lighting.list', 'revit.element.get']);

async function sameProject(ctx, key) {
  const info = await ctx.plugin.call('revit.project_info', {});
  const d = info.data || {};
  if (!d.open) throw ctx.error('verification-failed', 'No project is open in Revit. Nothing was changed.');
  if (d.documentKey !== key) throw ctx.error('verification-failed', 'The project open in Revit ("' + d.title + '") is not the project this request was made for. Nothing was changed. Ask for the project information again.');
  if (!d.editable) throw ctx.error('invalid-params', (d.editBlockedReason || 'This project may not be edited.') + ' Nothing was changed.');
  return d;
}

exports.execute = async (command, params, ctx) => {
  if (READS.has(command)) {
    const r = await ctx.plugin.call(command, params);
    return { message: r.message, outputs: [], data: r.data, evidence: r.evidence || ['answered by the add-in inside Revit'], verified: true };
  }
  switch (command) {
    case 'revit.parameter.set': {
      const d = await sameProject(ctx, params.documentKey);
      const r = await ctx.plugin.call(command, params);
      const el = await ctx.plugin.call('revit.element.get', { elementId: params.elementId });
      const field = String(params.parameter).toLowerCase() === 'mark' ? 'mark' : 'comments';
      if (String((el.data || {})[field]) !== String(params.value)) throw ctx.error('verification-failed', 'Revit does not show the new ' + params.parameter + ' on element ' + params.elementId + ' when asked again.');
      return { message: r.message, outputs: [], data: { ...r.data, project: d.title }, evidence: (r.evidence || []).concat('a separate read of the element shows the new value'), verified: true };
    }
    case 'revit.element.place_test': {
      const d = await sameProject(ctx, params.documentKey);
      const r = await ctx.plugin.call(command, params);
      const id = r.data && r.data.elementId;
      const el = id ? await ctx.plugin.call('revit.element.get', { elementId: id }) : null;
      if (!el || !el.data || el.data.comments !== 'CreateCraft test placement') throw ctx.error('verification-failed', 'Revit does not list the test instance when asked again.');
      return { message: r.message, outputs: [], data: { ...r.data, project: d.title }, evidence: (r.evidence || []).concat('a separate read of element ' + id + ' found it'), verified: true };
    }
    case 'revit.element.remove_test': {
      const d = await sameProject(ctx, params.documentKey);
      const r = await ctx.plugin.call(command, params);
      let gone = false;
      try { await ctx.plugin.call('revit.element.get', { elementId: params.elementId }); } catch (e) { gone = true; }
      if (!gone) throw ctx.error('verification-failed', 'Element ' + params.elementId + ' is still in the project.');
      return { message: r.message, outputs: [], data: { ...r.data, project: d.title }, evidence: (r.evidence || []).concat('a separate read no longer finds the element'), verified: true };
    }
    default:
      throw ctx.error('unsupported', 'Unknown command ' + command);
  }
};

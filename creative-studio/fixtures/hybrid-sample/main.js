'use strict';
// The connector half of the SimCAD hybrid sample (SIMULATED application). It runs in CreateCraft's restricted adapter process
// and reaches the add-in inside SimCAD only through ctx.plugin, which goes through the authenticated bridge.

exports.probe = async () => ({ version: '1.0.0', detail: 'Self-contained; SimCAD is simulated.' });
exports.connect = async () => undefined;
// The connector is healthy by itself; CreateCraft additionally asks the add-in inside SimCAD for a real answer before
// calling the integration connected.
exports.healthCheck = async () => ({ ok: true, detail: 'The connector is ready.' });
exports.disconnect = async () => undefined;

exports.execute = async (command, params, ctx) => {
  switch (command) {
    case 'simcad.describe': {
      const r = await ctx.plugin.call('scene.describe', {});
      return { message: r.message, outputs: [], data: r.data, evidence: ['the add-in inside SimCAD listed the scene'], verified: true };
    }
    case 'simcad.add_box_verified': {
      const added = await ctx.plugin.call('scene.add_box', { name: params.name, size: params.size });
      const id = added.data && added.data.id;
      if (!id) throw ctx.error('verification-failed', 'The add-in did not return an object id.');
      // Do not trust the first answer: ask again and look for the object.
      const after = await ctx.plugin.call('scene.describe', {});
      const found = (after.data.objects || []).find((o) => o.id === id);
      if (!found || found.name !== params.name || found.size !== params.size) throw ctx.error('verification-failed', 'SimCAD does not list the box that was just added.');
      return { message: 'Added box "' + params.name + '" (id ' + id + ') and confirmed it is in the scene.', outputs: [], data: { id, count: after.data.count }, evidence: ['add_box returned id ' + id, 'describe lists ' + id + ' with the same name and size'], verified: true };
    }
    case 'simcad.slow_build': {
      const r = await ctx.plugin.call('scene.slow_build', { steps: params.steps });
      return { message: r.message, outputs: [], data: r.data, verified: true };
    }
    default:
      throw ctx.error('unsupported', 'Unknown command ' + command);
  }
};

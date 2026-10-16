'use strict';
// CreateCraft companion plugin for the SIMULATED application SimCAD. Loaded by SimCAD at start-up.
// Real plugins do the same thing in their own technology: connect to CreateCraft's bridge, register what this program and
// edition can do, and run every command inside the program's API context.

const path = require('node:path');
const { connectPlugin } = require('./ccbridge-client.js');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('cancelled'), { kind: 'cancelled' })); }, { once: true });
});

exports.activate = (host) => {
  const pro = host.edition === 'Pro';
  const handlers = {
    'scene.describe': async () => { const d = host.api.describe(); return { message: d.count + ' objects in the scene', data: d, verified: true }; },
  };
  if (pro) {
    Object.assign(handlers, {
      'scene.add_box': async (p) => {
        const id = host.api.addBox(String(p.name), Number(p.size));
        return { message: 'Added ' + p.name, data: { id }, evidence: ['SimCAD returned object id ' + id] };
      },
      'scene.reset': async () => { host.api.reset(); return { message: 'Scene cleared', verified: true }; },
      'scene.slow_build': async (p, ctx) => {
        const n = Number(p.steps);
        for (let i = 1; i <= n; i++) {
          await sleep(100, ctx.signal);
          ctx.progress('Built ' + i + ' of ' + n, i / n);
        }
        return { message: 'Built ' + n + ' steps', data: { steps: n }, verified: true };
      },
    });
  }
  // The executor is the host's API-context dispatcher: the bridge client runs every command through it.
  connectPlugin({
    configFile: path.join(__dirname, 'cc-bridge.json'),
    app: { name: host.name, version: host.version, edition: host.edition, pid: process.pid },
    pluginVersion: '1.0.0',
    capabilities: Object.keys(handlers),
    handlers,
    health: async () => ({ ok: true, detail: 'SimCAD (simulated) ' + host.version + ' ' + host.edition + ' answered from its API context with ' + host.api.describe().count + ' objects.' }),
    executor: (fn) => host.runInApiContext(() => fn()),
  });
};

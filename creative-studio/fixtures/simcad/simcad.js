'use strict';
// SimCAD: a SIMULATED desktop application used to test CreateCraft's installer and plugin bridge. It is not real software.
// It behaves like the programs the bridge is for:
//   * it loads plugins (*.plugin.js) from <root>/plugins only when it STARTS (so installing needs a restart);
//   * its API may only be used inside its "API context" (a single tick loop), like Revit's ExternalEvent or a main thread;
//   * a plugin that calls the API from anywhere else gets an error.
//
//   node simcad.js --root <folder> [--edition Pro|Lite] [--version 1.2]

const fs = require('node:fs');
const path = require('node:path');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const root = arg('root');
if (!root) { console.error('--root is required'); process.exit(2); }
const edition = arg('edition', 'Pro');
const version = arg('version', '1.2');

let inContext = false;
const queue = [];
const scene = new Map();
let nextId = 1;

const api = {
  _guard() { if (!inContext) throw new Error('SimCAD API called outside its API context'); },
  addBox(name, size) { api._guard(); const id = 'obj' + nextId++; scene.set(id, { id, name, size }); return id; },
  describe() { api._guard(); return { count: scene.size, objects: [...scene.values()] }; },
  reset() { api._guard(); scene.clear(); },
};

const host = {
  name: 'SimCAD', version, edition,
  api,
  /** Runs fn inside the API context on the next tick; resolves with its result. */
  runInApiContext(fn) {
    return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); });
  },
};

let busy = false;
const tick = setInterval(async () => {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true; inContext = true;
  try { job.resolve(await job.fn(host)); } catch (e) { job.reject(e); } finally { inContext = false; busy = false; }
}, 10);

const loaded = [];
const dir = path.join(root, 'plugins');
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
  if (!f.endsWith('.plugin.js')) continue;
  try { const p = require(path.join(dir, f)); if (typeof p.activate === 'function') { p.activate(host); loaded.push(f); } } catch (e) { console.error('plugin ' + f + ' failed: ' + e.message); }
}
console.log('SIMCAD READY pid=' + process.pid + ' plugins=' + loaded.join(','));
process.on('SIGTERM', () => { clearInterval(tick); process.exit(0); });
process.on('message', (m) => { if (m === 'exit') process.exit(0); });

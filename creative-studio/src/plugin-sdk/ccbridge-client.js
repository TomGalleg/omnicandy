'use strict';
// OmniCandi plugin bridge client (protocol 1). Zero dependencies: copy this one file into a Node-based plugin.
// Plugins written in other technologies (C# add-ins, CEP/UXP panels, Python add-ins) implement the same frames; see
// docs/universal-installer.md ("Plugin bridge protocol").
//
//   const { connectPlugin } = require('./ccbridge-client.js');
//   const bridge = connectPlugin({
//     configFile: path.join(__dirname, 'cc-bridge.json'),   // written by OmniCandi when the plugin was installed
//     app: { name: 'SimCAD', version: '1.2', edition: 'Pro', pid: process.pid },
//     pluginVersion: '1.0.0',
//     capabilities: ['scene.describe'],                       // what THIS program/edition can do right now
//     handlers: { 'scene.describe': async (params, ctx) => ({ message: '...', data: {} }) },
//     health: async () => ({ ok: true, detail: 'answered from inside the program' }),
//     executor: (fn) => host.runInApiContext(fn),             // REQUIRED: run every command in the program's API context
//   });

const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');

const PROTOCOL = { min: 1, max: 1 };

const sign = (secret, role, snonce, cnonce, pluginId, binding) =>
  nodeCrypto.createHmac('sha256', Buffer.from(secret, 'hex')).update('cc-bridge|' + role + '|' + snonce + '|' + cnonce + '|' + pluginId + '|' + binding).digest('hex');

function connectPlugin(o) {
  if (typeof o.executor !== 'function') throw new Error('executor is required: commands must run inside the host program\'s API context');
  const cfg = JSON.parse(fs.readFileSync(o.configFile, 'utf8'));
  const protocol = o.protocol || PROTOCOL;
  const listeners = { state: [] };
  let socket = null, closed = false, timer = null, backoff = 250, state = 'connecting';
  const active = new Map();

  const setState = (s, detail) => { state = s; for (const l of listeners.state) { try { l(s, detail); } catch (e) { /* listener error */ } } };
  const send = (f) => { try { if (socket && !socket.destroyed) socket.write(JSON.stringify(f) + '\n'); } catch (e) { /* closed */ } };

  function connect() {
    if (closed) return;
    let endpoint;
    try { endpoint = JSON.parse(fs.readFileSync(cfg.endpointFile, 'utf8')).pipe; } catch (e) { return retry('OmniCandi is not running'); }
    let buf = '', snonce = null, cnonce = nodeCrypto.randomBytes(16).toString('hex'), welcomed = false;
    const s = net.connect(endpoint);
    socket = s;
    s.setEncoding('utf8');
    s.on('connect', () => {});
    s.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) { try { onFrame(JSON.parse(line)); } catch (e) { s.destroy(); } }
      }
    });
    s.on('error', () => {});
    s.on('close', () => { if (socket === s) { socket = null; for (const a of active.values()) a.abort(); active.clear(); } if (welcomed) setState('disconnected', 'connection lost'); retry('closed'); });

    function onFrame(f) {
      if (f.t === 'hello') {
        snonce = f.nonce;
        const off = { min: protocol.min, max: protocol.max };
        send({
          t: 'hello', protocol: off, pluginId: cfg.pluginId, pluginVersion: o.pluginVersion || '0.0.0', nonce: cnonce,
          proof: sign(cfg.secret, 'c', snonce, cnonce, cfg.pluginId, off.min + '-' + off.max),
          app: { name: o.app.name, version: o.app.version == null ? null : String(o.app.version), edition: o.app.edition, pid: o.app.pid },
        });
      } else if (f.t === 'welcome') {
        const expect = sign(cfg.secret, 's', snonce, cnonce, cfg.pluginId, String(f.protocol));
        const a = Buffer.from(String(f.proof), 'hex'), b = Buffer.from(expect, 'hex');
        if (a.length !== b.length || !nodeCrypto.timingSafeEqual(a, b)) { s.destroy(); return setState('rejected', 'the server did not prove it knows the pairing secret'); }
        welcomed = true; backoff = 250;
        send({ t: 'register', capabilities: o.capabilities || Object.keys(o.handlers || {}) });
        setState('connected');
      } else if (f.t === 'reject') {
        setState('rejected', f.code + ': ' + f.message);
      } else if (f.t === 'ping') {
        send({ t: 'pong', n: f.n });
      } else if (f.t === 'cancel') {
        const a = active.get(f.id); if (a) a.abort();
      } else if (f.t === 'health') {
        run(f.id, async () => { const h = await (o.health ? o.health() : { ok: true }); return { ok: !!h.ok, message: String(h.detail || (h.ok ? 'ok' : 'not ok')), data: h.data, verified: !!h.ok }; });
      } else if (f.t === 'command') {
        const fn = o.handlers && o.handlers[f.name];
        if (typeof fn !== 'function') return send({ t: 'result', id: f.id, ok: false, error: { kind: 'unsupported', message: 'No handler for ' + f.name } });
        run(f.id, () => fn(f.params, ctxFor(f.id)));
      }
    }
  }

  function ctxFor(id) {
    const ac = active.get(id);
    return { signal: ac.signal, progress: (stage, fraction) => send({ t: 'progress', id, stage: String(stage).slice(0, 200), fraction: typeof fraction === 'number' ? Math.max(0, Math.min(1, fraction)) : undefined }) };
  }

  function run(id, fn) {
    const ac = new AbortController();
    active.set(id, ac);
    // Everything the program's API is touched with happens inside the executor: its supported context, not this socket's thread.
    Promise.resolve().then(() => o.executor(fn)).then(
      (r) => {
        r = r || {};
        send({ t: 'result', id, ok: r.ok !== false, message: r.message, data: r.data, evidence: r.evidence, verified: r.verified, error: r.ok === false ? { kind: 'app-error', message: r.message || 'failed' } : undefined });
      },
      (e) => {
        const kind = ac.signal.aborted ? 'cancelled' : (e && e.kind) || 'app-error';
        send({ t: 'result', id, ok: false, error: { kind, message: String((e && e.message) || e).slice(0, 900) } });
      },
    ).then(() => active.delete(id));
  }

  function retry(why) {
    if (closed || timer) return;
    if (state !== 'rejected') setState('connecting', why);
    timer = setTimeout(() => { timer = null; connect(); }, backoff);
    backoff = Math.min(backoff * 2, 5000);
  }

  connect();
  return {
    get state() { return state; },
    onState(l) { listeners.state.push(l); },
    close() { closed = true; if (timer) clearTimeout(timer); for (const a of active.values()) a.abort(); try { if (socket) socket.destroy(); } catch (e) { /* closed */ } setState('closed'); },
  };
}

module.exports = { connectPlugin, PROTOCOL };

// Phase 0 probe: headless CLI + MCP handshake for ArtCraft apps. Writes only under outDir.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });
const PF = 'C:\\Program Files';
const apps = {
  photocraft: ['mcp', '--automation-read-root', outDir, '--automation-write-root', outDir],
  vectorcraft: ['mcp', '--headless', '--automation-read-root', outDir, '--automation-write-root', outDir],
  lightcraft: ['mcp', '--compact'],
  effectcraft: ['mcp', '--automation-read-root', outDir, '--automation-write-root', outDir],
  designcraft: ['mcp', '--sample'],
  soundcraft: ['mcp', '--demo'],
  filmcraft: ['mcp'],
};
const exe = (a) => path.join(PF, a, `${a}-cli.exe`);
const results = {};

function run(a, args) {
  const r = spawnSync(exe(a), args, { encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: (r.stdout || '').slice(0, 1500), stderr: (r.stderr || '').slice(0, 800) };
}

// PhotoCraft end-to-end headless: new -> fill -> save PNG, convert to .pcraft, info
const png = path.join(outDir, 'smoke.png');
const pcraft = path.join(outDir, 'smoke.pcraft');
results.photocraft_run = run('photocraft', ['run', '--new', JSON.stringify({ width: 256, height: 256, background: 'white' }),
  '--cmd', 'edit.fill', '--params', JSON.stringify({ contents: 'color', color: '#3366ff', opacity: 50 }), '--out', png]);
results.photocraft_png_bytes = fs.existsSync(png) ? fs.statSync(png).size : 0;
results.photocraft_convert = run('photocraft', ['convert', png, pcraft]);
results.photocraft_info = run('photocraft', ['info', pcraft, '--compact']);

function mcpProbe(a, args) {
  return new Promise((resolve) => {
    const p = spawn(exe(a), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '';
    const done = (extra) => { try { p.kill(); } catch {} resolve({ ...extra, stderr: err.slice(0, 400) }); };
    const timer = setTimeout(() => done({ error: 'timeout', raw: buf.slice(0, 400) }), 45000);
    let info = null;
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          info = { serverInfo: m.result?.serverInfo, protocolVersion: m.result?.protocolVersion, error: m.error };
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        } else if (m.id === 2) {
          clearTimeout(timer);
          const tools = m.result?.tools || [];
          done({ ...info, toolCount: tools.length, sampleTools: tools.slice(0, 20).map((t) => t.name), error: m.error });
        }
      }
    });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => { clearTimeout(timer); done({ error: String(e) }); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'creative-studio-audit', version: '0.0.0' } } }) + '\n');
  });
}

results.mcp = {};
for (const [a, args] of Object.entries(apps)) {
  results.mcp[a] = await mcpProbe(a, args);
  results[`${a}_version`] = run(a, ['--version']).stdout.trim().split('\n')[0];
}
fs.writeFileSync(path.join(outDir, 'probe-results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

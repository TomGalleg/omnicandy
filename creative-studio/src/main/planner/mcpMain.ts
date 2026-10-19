// Entry point of the planner MCP server (bundled to out/planner-mcp.cjs by scripts/build-planner-mcp.mjs).
//   node planner-mcp.cjs --scopes read,execute --actor "Claude Code"            stdio (what Claude Code, Gemini CLI and Claude Desktop use)
//   node planner-mcp.cjs --http --port 8765 --token-file <file> --scopes read   local HTTP, bearer token required
// The folder is --dir, else CREATECRAFT_PLANNER_DIR, else <OmniCandi user data>/planner. Nothing is sent anywhere.
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { timingSafeEqual } from 'node:crypto';
import { ACTOR_KINDS, type Actor } from '@shared/planner';
import { defaultPlannerDir } from './dir';
import { McpSession, type RpcResponse } from './mcp';
import { PlannerService } from './service';
import { PlannerStore } from './store';

function parseArgs(argv: string[]) {
  const o: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[a.slice(2)] = true; else { o[a.slice(2)] = next; i++; }
  }
  return o;
}

const log = (m: string) => process.stderr.write(`[planner-mcp] ${m}\n`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = typeof args.dir === 'string' ? path.resolve(args.dir) : defaultPlannerDir();
  const scopes = (typeof args.scopes === 'string' ? args.scopes : 'read').split(',').map((s) => s.trim()).filter(Boolean);
  const kind = typeof args.kind === 'string' && (ACTOR_KINDS as readonly string[]).includes(args.kind) ? (args.kind as Actor['kind']) : 'other';
  const actor = typeof args.actor === 'string' ? { kind, name: args.actor.slice(0, 60) } : undefined;
  const svc = new PlannerService(new PlannerStore(dir));
  const mk = () => new McpSession(svc, scopes, actor);
  const probe = mk(); // refuses scopes a connection may not hold, before anything starts
  log(`folder ${dir}; permissions: ${probe.permissions.join(', ')}`);

  if (args.http) {
    const tokenFile = typeof args['token-file'] === 'string' ? args['token-file'] : null;
    const token = (tokenFile ? fs.readFileSync(tokenFile, 'utf8') : process.env.PLANNER_MCP_TOKEN ?? '').trim();
    if (token.length < 24) throw new Error('HTTP mode needs a bearer token of at least 24 characters (--token-file or PLANNER_MCP_TOKEN).');
    const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
    const port = typeof args.port === 'string' ? Number(args.port) : 8765;
    const want = Buffer.from(token);
    const session = mk();
    const server = createServer((req, res) => {
      const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return send(403, { error: 'Origin not allowed.' });
      const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (got.length !== want.length || !timingSafeEqual(got, want)) return send(401, { error: 'A valid bearer token is required.' });
      if (req.url?.split('?')[0] !== '/mcp') return send(404, { error: 'The MCP endpoint is /mcp.' });
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return void res.end(); }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size > 1_000_000) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        void (async () => {
          let body: unknown;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
          const batch = Array.isArray(body);
          const out: RpcResponse[] = [];
          for (const m of (batch ? body : [body]) as unknown[]) { const r = await session.handle(m as never); if (r) out.push(r); }
          if (!out.length) { res.writeHead(202); return void res.end(); }
          send(200, batch ? out : out[0]);
        })();
      });
    });
    server.listen(port, host, () => log(`listening on http://${host}:${(server.address() as { port: number }).port}/mcp (bearer token required)`));
    return;
  }

  const session = mk();
  const rl = createInterface({ input: process.stdin });
  const queue: Promise<void> = Promise.resolve();
  let chain = queue;
  rl.on('line', (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
      for (const m of Array.isArray(msg) ? msg : [msg]) {
        const r = await session.handle(m as never);
        if (r) process.stdout.write(JSON.stringify(r) + '\n');
      }
    });
  });
  rl.on('close', () => { void chain.then(() => process.exit(0)); });
}

main().catch((e) => { log(`failed to start: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });

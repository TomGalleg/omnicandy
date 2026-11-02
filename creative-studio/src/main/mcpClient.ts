// Minimal MCP client over stdio (JSON-RPC 2.0, newline-delimited), enough to drive ArtCraft CLIs.
// Spawned with a fixed argv and no shell. Tool errors become thrown Errors with the server's text.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

export class McpClient {
  private nextId = 0;
  private buf = '';
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private exited = false;
  stderr = '';

  /** Opt-in wire trace (CS_MCP_TRACE=<file>): one line per request, response, stderr chunk and exit, with a monotonic time. */
  private trace(kind: string, data: unknown) {
    const f = process.env.CS_MCP_TRACE;
    if (!f) return;
    try { appendFileSync(f, `${new Date().toISOString()} ${this.label} ${kind} ${typeof data === 'string' ? data : JSON.stringify(data)}
`); } catch { /* tracing never breaks a call */ }
  }

  private constructor(private readonly proc: ChildProcessWithoutNullStreams, private readonly label = '') {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => this.onData(d));
    proc.stderr.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-4000); this.trace('stderr', d.toString().slice(0, 500)); });
    proc.on('exit', (code) => {
      this.trace('exit', String(code));
      this.exited = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The automation connection closed.')); }
      this.pending.clear();
    });
    proc.on('error', () => { this.exited = true; });
  }

  static async start(exe: string, args: string[], clientName = 'creative-studio', env?: NodeJS.ProcessEnv): Promise<McpClient> {
    const c = new McpClient(spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) }), `${path.basename(exe)} ${args.join(' ')}`.slice(0, 120));
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '0.1.0' } });
    c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return c;
  }

  get alive(): boolean { return !this.exited; }

  private onData(d: string) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      this.trace('<-', `#${msg.id} ${line.slice(0, 200)}`);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
      else p.resolve(msg.result);
    }
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error('The automation connection is closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.trace('->', `#${id} ${method} ${JSON.stringify(params).slice(0, 200)}`);
      const timer = setTimeout(() => { this.pending.delete(id); this.trace('timeout', `#${id} ${method} after ${timeoutMs} ms`); reject(new Error(`${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Calls a tool; returns its text content parsed as JSON when possible. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const r = (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (r.isError) throw new Error(text.replace(/^app:\s*/, '') || `${name} failed.`);
    try { return JSON.parse(text); } catch { return text; }
  }

  close() {
    if (!this.exited) this.proc.kill();
  }
}

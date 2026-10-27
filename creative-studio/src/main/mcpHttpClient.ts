// Minimal MCP client over Streamable HTTP (JSON-RPC 2.0 POSTs), enough to drive a local editor's MCP server such as
// Unreal Engine 5.8's. Loopback only: the server has no authentication, so it is never reached over the network.
// A reply is either one JSON body or an SSE stream; both are handled. The session id the server returns on
// `initialize` is sent on every later call and released with a DELETE on close.

export class McpHttpError extends Error {
  constructor(readonly kind: 'unreachable' | 'http' | 'protocol' | 'tool' | 'timeout' | 'aborted', message: string) { super(message); }
}

export interface McpHttpOptions {
  clientName?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

type JsonObj = Record<string, unknown>;

/** Only 127.0.0.1, localhost and [::1] over http(s) are accepted. */
export function assertLoopbackUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new McpHttpError('protocol', `"${raw}" is not a valid URL.`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new McpHttpError('protocol', 'Only http(s) MCP endpoints are supported.');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new McpHttpError('protocol', 'The MCP endpoint must be on this computer (127.0.0.1, localhost or [::1]).');
  return u;
}

/** Picks the JSON-RPC message with the given id out of an SSE body. */
export function parseSseResponse(text: string, id: number): JsonObj | null {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try {
      const m = JSON.parse(data) as JsonObj;
      if (m.id === id) return m;
    } catch { /* a keep-alive or partial event */ }
  }
  return null;
}

export class McpHttpClient {
  private nextId = 0;
  private sessionId: string | null = null;
  private readonly doFetch: typeof fetch;
  serverInfo: { name?: string; title?: string; version?: string } = {};

  private constructor(private readonly url: URL, private readonly o: McpHttpOptions) { this.doFetch = o.fetch ?? fetch; }

  static async connect(endpoint: string, o: McpHttpOptions = {}, signal?: AbortSignal, timeoutMs = 15_000): Promise<McpHttpClient> {
    const c = new McpHttpClient(assertLoopbackUrl(endpoint), o);
    const r = (await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: o.clientName ?? 'omnicandy', version: '0.1.0' } }, timeoutMs, signal)) as { serverInfo?: McpHttpClient['serverInfo'] };
    c.serverInfo = r?.serverInfo ?? {};
    if (!c.sessionId) throw new McpHttpError('protocol', 'The MCP server did not return a session id.');
    await c.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs, signal, false);
    return c;
  }

  get connected(): boolean { return this.sessionId !== null; }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  private async post(body: JsonObj, timeoutMs: number, signal: AbortSignal | undefined, wantReply: boolean): Promise<{ text: string; type: string } | null> {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await this.doFetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ac.signal });
      } catch (e) {
        if (timedOut) throw new McpHttpError('timeout', `The MCP server did not answer ${String(body.method)} within ${Math.round(timeoutMs / 1000)} s.`);
        if (signal?.aborted) throw new McpHttpError('aborted', 'Cancelled.');
        throw new McpHttpError('unreachable', `Could not reach the MCP server at ${this.url.origin}${this.url.pathname}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid && !this.sessionId) this.sessionId = sid;
      if (!res.ok) throw new McpHttpError('http', `The MCP server answered HTTP ${res.status} to ${String(body.method)}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      if (!wantReply) { await res.arrayBuffer().catch(() => undefined); return null; }
      let text: string;
      try { text = await res.text(); } catch (e) {
        if (timedOut) throw new McpHttpError('timeout', `The MCP server did not finish ${String(body.method)} within ${Math.round(timeoutMs / 1000)} s.`);
        if (signal?.aborted) throw new McpHttpError('aborted', 'Cancelled.');
        throw new McpHttpError('unreachable', `The MCP connection broke while reading ${String(body.method)}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { text, type: res.headers.get('content-type') ?? '' };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }

  async request(method: string, params: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<unknown> {
    const id = ++this.nextId;
    const reply = await this.post({ jsonrpc: '2.0', id, method, params: params as JsonObj }, timeoutMs, signal, true);
    let msg: JsonObj | null = null;
    if (reply!.type.includes('text/event-stream')) msg = parseSseResponse(reply!.text, id);
    else { try { msg = JSON.parse(reply!.text) as JsonObj; } catch { msg = null; } }
    if (!msg) throw new McpHttpError('protocol', `The MCP server sent no readable answer to ${method}.`);
    const err = msg.error as { message?: string } | undefined;
    if (err) throw new McpHttpError('protocol', err.message ?? `${method} failed.`);
    return msg.result;
  }

  /** Calls a tool; returns its text content (parsed as JSON when it is JSON). An `isError` result throws. */
  async callTool(name: string, args: JsonObj, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const content = await this.callToolContent(name, args, timeoutMs, signal);
    const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    try { return JSON.parse(text); } catch { return text; }
  }

  /** Calls a tool; returns its raw content blocks (text, image, ...) for a tool whose answer is not plain text/JSON. */
  async callToolContent(name: string, args: JsonObj, timeoutMs?: number, signal?: AbortSignal): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
    const r = (await this.request('tools/call', { name, arguments: args }, timeoutMs, signal)) as { isError?: boolean; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
    const content = r?.content ?? [];
    if (r?.isError) throw new McpHttpError('tool', content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') || `${name} failed.`);
    return content;
  }

  async close(): Promise<void> {
    const sid = this.sessionId;
    this.sessionId = null;
    if (!sid) return;
    try { await this.doFetch(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid }, signal: AbortSignal.timeout(3000) }); } catch { /* the editor may already be gone */ }
  }
}

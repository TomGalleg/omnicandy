// Client for the OmniCandy Resolve Bridge: a small script that runs INSIDE Resolve (Workspace > Scripts > Utility), so it
// works on the Free edition, where Resolve refuses outside scripting. It listens on 127.0.0.1 only and answers only
// requests that carry a secret token kept in the person's own folder (nothing else on the PC, and no web page, can use it).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const BRIDGE_URL = 'http://127.0.0.1:9876';
export const BRIDGE_START_HINT = 'In Resolve choose Workspace > Scripts > Utility > OmniCandy Resolve Bridge (once per Resolve session).';

export interface BridgeOptions {
  url?: string;
  /** File holding the shared secret; defaults to ~/OmniCandy/resolve-bridge.token. Absent file means "no bridge". */
  tokenPath?: string;
  fetch?: typeof fetch;
}

export const defaultTokenPath = (): string => path.join(os.homedir(), 'OmniCandy', 'resolve-bridge.token');

export async function readBridgeToken(o: BridgeOptions): Promise<string | null> {
  try {
    const t = (await fs.readFile(o.tokenPath ?? defaultTokenPath(), 'utf8')).trim();
    return t.length >= 32 ? t : null;
  } catch { return null; }
}

export class BridgeError extends Error {
  constructor(readonly kind: 'unreachable' | 'refused' | 'app', message: string) { super(message); }
}

/** One call to the bridge. Throws BridgeError; a JSON {"error": ...} answer is an 'app' error. */
export async function bridgeCall(o: BridgeOptions, method: 'GET' | 'POST', route: string, body?: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const token = await readBridgeToken(o);
  if (!token) throw new BridgeError('unreachable', 'The OmniCandy Resolve Bridge is not set up on this PC (no token file).');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20_000);
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await (o.fetch ?? fetch)(`${o.url ?? BRIDGE_URL}${route}`, {
      method,
      headers: { 'X-OmniCandy-Token': token, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    if (res.status === 403) throw new BridgeError('refused', 'The Resolve bridge refused the request (its token does not match). Re-run the bridge script in Resolve.');
    let json: unknown;
    try { json = await res.json(); } catch { throw new BridgeError('app', `The Resolve bridge answered with something unreadable (HTTP ${res.status}).`); }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new BridgeError('app', 'The Resolve bridge answered with something unexpected.');
    const out = json as Record<string, unknown>;
    if (!res.ok || typeof out.error === 'string') throw new BridgeError('app', typeof out.error === 'string' ? out.error.split('\n').slice(-2).join(' ').slice(0, 300) : `The Resolve bridge returned HTTP ${res.status}.`);
    return out;
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    if (opts.signal?.aborted) throw e;
    throw new BridgeError('unreachable', `The Resolve bridge is not answering. ${BRIDGE_START_HINT}`);
  } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); }
}

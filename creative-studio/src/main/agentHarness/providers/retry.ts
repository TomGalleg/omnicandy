// Model providers answer 429 (too many tokens or requests per minute) and 5xx now and then; a long agent task sends large conversations,
// so a short pause usually clears it. Retry a few times with a pause (honouring Retry-After), never beyond the caller's abort.

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
export const RETRY_ATTEMPTS = 3;
export const MAX_RETRY_WAIT_MS = 20_000;

export type Sleeper = (ms: number, signal: AbortSignal) => Promise<void>;
export const abortableSleep: Sleeper = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

/** Seconds from a Retry-After header (a number of seconds only; dates are ignored), as milliseconds, capped. */
export function retryAfterMs(res: Pick<Response, 'headers'>): number | undefined {
  const raw = res.headers?.get?.('retry-after');
  const n = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n * 1000, MAX_RETRY_WAIT_MS) : undefined;
}

export async function fetchWithRetry(doFetch: () => Promise<Response>, signal: AbortSignal, sleep: Sleeper = abortableSleep, attempts = RETRY_ATTEMPTS): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch();
    if (res.ok || !RETRYABLE.has(res.status) || attempt >= attempts || signal.aborted) return res;
    await sleep(retryAfterMs(res) ?? Math.min(1500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500), MAX_RETRY_WAIT_MS), signal);
    if (signal.aborted) return res;
  }
}

/** Only a short machine code from an error body (for example insufficient_quota), never its text. */
export async function providerErrorCode(res: Pick<Response, 'json'>): Promise<string | undefined> {
  try {
    const body = await res.json() as { error?: { code?: unknown; type?: unknown } };
    const c = body?.error?.code ?? body?.error?.type;
    return typeof c === 'string' && /^[a-z0-9_]{1,40}$/.test(c) ? c : undefined;
  } catch { return undefined; }
}

/** Plain explanation appended to "Provider HTTP n"; the "Provider HTTP n" prefix itself is kept for callers that match on it. */
export function explainHttp(status: number, code?: string): string {
  if (code === 'insufficient_quota' || code === 'billing_not_active') return ' (the account is out of quota or credit: check the plan and billing with the provider)';
  if (status === 429) return ' (rate limit: too many tokens or requests per minute; wait a minute, then press Continue Task)';
  if (status >= 500) return ' (the provider had a temporary problem; try Continue Task again shortly)';
  return '';
}

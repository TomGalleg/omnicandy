// The same plan usage numbers Claude Code's /usage shows (session, weekly, usage credits), read live from Anthropic with the
// sign-in Claude Code already saved on this PC. The token is read here in main, used for one request, and never logged,
// stored or sent to the interface. If it has expired we do not refresh it (that would rewrite Claude Code's sign-in file):
// the person just uses Claude Code once and it renews itself.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlanUsage, PlanUsageBar } from '@shared/buildSession';

const URL = 'https://api.anthropic.com/api/oauth/usage';

interface Raw { utilization?: unknown; resets_at?: unknown }

function bar(raw: unknown): PlanUsageBar | null {
  const r = raw as Raw | null;
  if (!r || typeof r.utilization !== 'number') return null;
  const t = typeof r.resets_at === 'string' ? Date.parse(r.resets_at) : NaN;
  return { percent: Math.max(0, Math.min(100, r.utilization)), resetsAt: Number.isFinite(t) ? t : null };
}

/** Pure: turns Anthropic's usage response into what the panel shows. */
export function parsePlanUsage(json: unknown, plan: string | null, now = Date.now()): PlanUsage {
  const j = (json ?? {}) as Record<string, unknown>;
  const extra = j.extra_usage as { is_enabled?: unknown; monthly_limit?: unknown; used_credits?: unknown } | null | undefined;
  const credits = extra && extra.is_enabled === true && typeof extra.monthly_limit === 'number' && typeof extra.used_credits === 'number' && extra.monthly_limit > 0
    ? { usedUsd: extra.used_credits / 100, limitUsd: extra.monthly_limit / 100 }
    : null;
  return {
    plan, fetchedAt: now, error: null,
    session: bar(j.five_hour), weekly: bar(j.seven_day), weeklyOpus: bar(j.seven_day_opus), weeklySonnet: bar(j.seven_day_sonnet), credits,
  };
}

const failed = (error: string, plan: string | null = null): PlanUsage => ({ plan, fetchedAt: Date.now(), error, session: null, weekly: null, weeklyOpus: null, weeklySonnet: null, credits: null });

export async function fetchPlanUsage(o: { configDir?: string; fetchImpl?: typeof fetch } = {}): Promise<PlanUsage> {
  const dir = o.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  let oauth: { accessToken?: string; expiresAt?: number; subscriptionType?: string } | undefined;
  try { oauth = (JSON.parse(await fs.readFile(path.join(dir, '.credentials.json'), 'utf8')) as { claudeAiOauth?: typeof oauth }).claudeAiOauth; }
  catch { return failed('Plan limits need the Claude Code sign-in, and none was found on this PC.'); }
  if (!oauth?.accessToken) return failed('Plan limits need the Claude Code sign-in, and none was found on this PC.');
  const plan = oauth.subscriptionType ?? null;
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now()) return failed('The Claude Code sign-in has expired. Use Claude Code once and it renews itself.', plan);
  try {
    const res = await (o.fetchImpl ?? fetch)(URL, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return failed(`Anthropic did not return plan limits (${res.status}).`, plan);
    return parsePlanUsage(await res.json(), plan);
  } catch { return failed('Could not reach Anthropic to read plan limits.', plan); }
}

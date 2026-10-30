// The one durable record of what AI workers asked for and did: one line of JSON per action, appended, in the project's own folder. It is never rewritten.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ActivityEntry } from './guard';

export const ACTIVITY_FILE = 'team-activity.jsonl';

export function activityLogger(dir: string): (e: ActivityEntry) => Promise<void> {
  let ready: Promise<unknown> | null = null;
  return async (e) => {
    ready ??= mkdir(dir, { recursive: true });
    await ready;
    await appendFile(path.join(dir, ACTIVITY_FILE), `${JSON.stringify(e)}\n`, 'utf8');
  };
}

/** The most recent entries, newest last. A damaged line is skipped, never fatal. */
export async function readActivity(dir: string, limit = 200): Promise<ActivityEntry[]> {
  let raw = ''; try { raw = await readFile(path.join(dir, ACTIVITY_FILE), 'utf8'); } catch { return []; }
  const out: ActivityEntry[] = [];
  for (const line of raw.split('\n').slice(-limit)) { if (!line.trim()) continue; try { out.push(JSON.parse(line) as ActivityEntry); } catch { /* skip */ } }
  return out;
}

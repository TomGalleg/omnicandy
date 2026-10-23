// Helpers shared by adapters that drive a program through a child process (Blender, Resolve, FreeCAD...).
// Keeping them here means an adapter only holds what is specific to its application.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { AdapterError } from './sdk';

export interface RunResult { code: number | null; out: string; err: string }

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  /** Shown in errors ("Blender", "Python"). */
  label: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Characters of stdout kept (the tail). Default 200,000. */
  maxOut?: number;
}

/** Runs a program without a window; kills it on timeout or abort. Output is truncated to the tail. */
export function runProcess(exe: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: o.env ?? process.env, cwd: o.cwd });
    let out = '', err = '';
    const keep = o.maxOut ?? 200_000;
    p.stdout.on('data', (d: Buffer) => { out = (out + d.toString()).slice(-keep); });
    p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-20_000); });
    const kill = () => { try { p.kill(); } catch { /* gone */ } };
    const timer = setTimeout(() => { kill(); reject(new AdapterError('app-error', `${o.label} did not finish within ${Math.round(o.timeoutMs / 1000)} s.`)); }, o.timeoutMs);
    o.signal?.addEventListener('abort', kill, { once: true });
    p.on('error', (e) => { clearTimeout(timer); reject(new AdapterError('missing-app', `Could not start ${o.label}: ${e.message}`)); });
    p.on('close', (code) => { clearTimeout(timer); o.signal?.removeEventListener('abort', kill); resolve({ code, out, err }); });
  });
}

/** A file name with only letters, digits, space, dash and underscore, and the given extension. */
export function safeFileName(n: string, ext: string): string {
  const base = path.basename(String(n)).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60);
  if (!base) throw new AdapterError('invalid-params', 'The file name has no usable letters or digits.');
  return `${base}${ext}`;
}

/** Reads the `CREATECRAFT_RESULT {json}` line a script template printed, or null. */
export function parseResultLine(out: string): Record<string, unknown> | null {
  const m = /CREATECRAFT_RESULT (\{.*\})/.exec(out);
  if (!m) return null;
  try { return JSON.parse(m[1]!) as Record<string, unknown>; } catch { return null; }
}

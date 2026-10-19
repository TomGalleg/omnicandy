// Unpacking a downloaded .zip (the local video engine). Windows 10+ ships bsdtar, which reads zip. Linux's default `tar` is GNU tar
// and does not, so: `unzip` if installed (keeps file modes), else Python's zipfile, else OmniCandi's own zip reader (no external
// program needed). Only run after the download's size and SHA-256 were verified.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { currentOs, type OsId } from '@shared/platform';
import { readZip, safeEntryName } from '../integrations/zip';
import { pythonCandidates, findOnPath } from './exec';

export type RunFile = (file: string, args: string[]) => Promise<void>;

const realRun: RunFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 10 * 60_000 }, (err) => (err ? reject(err) : resolve()));
});

/** Pure-JS extraction: no external program, regular files only (symlinks and directories entries are skipped), generous size limits. */
export async function extractWithReader(archive: string, dir: string): Promise<void> {
  const entries = readZip(await fs.readFile(archive), { maxFiles: 5000, maxFileBytes: 1024 ** 3, maxTotalBytes: 3 * 1024 ** 3 });
  for (const [name, data] of entries) {
    if (name.endsWith('/')) continue;
    const dest = path.join(dir, ...safeEntryName(name).split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
  }
}

export async function extractArchive(archive: string, dir: string, o: { os?: OsId; run?: RunFile; env?: NodeJS.ProcessEnv; reader?: typeof extractWithReader; find?: typeof findOnPath } = {}): Promise<void> {
  const os = o.os ?? currentOs();
  const run = o.run ?? realRun;
  const env = o.env ?? process.env;
  const find = o.find ?? findOnPath;
  const fail = (e: unknown) => new Error(`Could not unpack the download (${e instanceof Error ? e.message : String(e)}).`);
  if (os === 'win32') {
    try { await run(path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', dir]); return; } catch (e) { throw fail(e); }
  }
  const unzip = await find('unzip', { os, env });
  if (unzip) { try { await run(unzip, ['-o', '-q', archive, '-d', dir]); return; } catch { /* fall through to the next way */ } }
  for (const [py, pre] of pythonCandidates(os, env)) {
    const found = await find(py, { os, env });
    if (!found) continue;
    try { await run(found, [...pre, '-m', 'zipfile', '-e', archive, dir]); return; } catch { /* next */ }
  }
  try { await (o.reader ?? extractWithReader)(archive, dir); } catch (e) { throw fail(e); }
}

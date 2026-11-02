import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editedCopyToStart, isOlderVersion, STARTED_OK, USE_EDITED } from './editWorkspace';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** An edited copy that was asked for, came up last time, and was made from `version`. */
function editedCopy(version: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'edited-'));
  dirs.push(d);
  fs.writeFileSync(path.join(d, USE_EDITED), 'on\n');
  fs.writeFileSync(path.join(d, STARTED_OK), 'ok');
  fs.mkdirSync(path.join(d, 'out', 'main'), { recursive: true });
  fs.writeFileSync(path.join(d, 'out', 'main', 'index.js'), '');
  const exe = path.join(d, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version }));
  return d;
}

describe('an edited copy must not hide a newer install', () => {
  it('compares versions by number, not text', () => {
    expect(isOlderVersion('0.1.5', '0.1.10')).toBe(true);
    expect(isOlderVersion('0.1.7', '0.1.7')).toBe(false);
    expect(isOlderVersion('0.2.0', '0.1.9')).toBe(false);
    expect(isOlderVersion('x', '0.1.9')).toBe(false);
  });
  it('is started when it is as new as the install, skipped when older', () => {
    const d = editedCopy('0.1.7');
    expect(editedCopyToStart(d, '0.1.7')).not.toBeNull();
    expect(editedCopyToStart(d, '0.1.8')).toBeNull();
    expect(editedCopyToStart(d)).not.toBeNull();
  });
  it('keeps the old behaviour when its version cannot be read', () => {
    const d = editedCopy('0.1.7');
    fs.rmSync(path.join(d, 'package.json'));
    expect(editedCopyToStart(d, '0.1.8')).not.toBeNull();
  });
});

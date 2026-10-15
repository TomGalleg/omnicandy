import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { semanticZipDigest } from './zipDigest';

/** Minimal zip writer (deflate) for the test. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text); const data = zlib.deflateRawSync(raw); const nm = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(8, 8); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, nm, data); central.push(c, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

describe('semanticZipDigest', () => {
  it('ignores generator stamps and key order, but not content', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zd-'));
    const f = async (n: string, files: Record<string, string>) => { const p = path.join(dir, n); await writeFile(p, zip(files)); return semanticZipDigest(p); };
    const a = await f('a', { mimetype: 'x', 'meta.json': '{"generator":"0.7.1","version":1}', 'document.json': '{"a":1,"b":[1,2]}' });
    const b = await f('b', { mimetype: 'x', 'meta.json': '{"generator":"0.8.0","version":2}', 'document.json': '{"b":[1,2],"a":1}' });
    const c = await f('c', { mimetype: 'x', 'meta.json': '{"generator":"0.8.0","version":2}', 'document.json': '{"a":2,"b":[1,2]}' });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});

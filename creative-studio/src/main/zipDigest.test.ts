import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { documentDigest, semanticZipDigest } from './zipDigest';

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

describe('semanticZipDigest for Office packages', () => {
  it('ignores the save counter and modified time in core.xml but not real property or body changes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zd-ooxml-'));
    const core = (rev: number, mod: string, title: string) => `<cp:coreProperties><dc:title>${title}</dc:title><cp:lastModifiedBy>WordCraft User</cp:lastModifiedBy><cp:revision>${rev}</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-10-15T02:44:45Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${mod}</dcterms:modified></cp:coreProperties>`;
    const f = async (n: string, files: Record<string, string>) => { const p = path.join(dir, n); await writeFile(p, zip(files)); return semanticZipDigest(p); };
    const body = '<w:document>Sunset</w:document>';
    const a = await f('a', { 'word/document.xml': body, 'docProps/core.xml': core(2, '2026-10-16T00:03:32Z', 'Report') });
    const b = await f('b', { 'word/document.xml': body, 'docProps/core.xml': core(4, '2026-10-16T00:09:59Z', 'Report') });
    const title = await f('c', { 'word/document.xml': body, 'docProps/core.xml': core(2, '2026-10-16T00:03:32Z', 'Other') });
    const text = await f('d', { 'word/document.xml': '<w:document>Evening</w:document>', 'docProps/core.xml': core(2, '2026-10-16T00:03:32Z', 'Report') });
    expect(b).toBe(a);
    expect(title).not.toBe(a);
    expect(text).not.toBe(a);
  });
});

describe('documentDigest', () => {
  it('compares zips by content and anything else by its bytes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dd-'));
    const w = async (n: string, data: Buffer | string) => { const p = path.join(dir, n); await writeFile(p, data); return documentDigest(p); };
    const z1 = await w('a.zip', zip({ 'meta.json': '{"generator":"1"}', 'document.json': '{"a":1}' }));
    const z2 = await w('b.zip', zip({ 'meta.json': '{"generator":"2"}', 'document.json': '{"a":1}' }));
    expect(z2).toBe(z1);
    const t1 = await w('a.dxf', ['0', 'SECTION', ''].join(String.fromCharCode(10)));
    expect(t1).toMatch(/^raw:/);
    expect(await w('b.dxf', ['0', 'SECTION', ''].join(String.fromCharCode(10)))).toBe(t1);
    expect(await w('c.dxf', ['0', 'ENDSEC', ''].join(String.fromCharCode(10)))).not.toBe(t1);
  });
});

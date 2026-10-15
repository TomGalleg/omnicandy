// Content digest of a zip-based document that ignores generator stamps, so a file re-saved by a newer
// app build compares equal to the same document saved by an older one. Reads the zip directly (no deps).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import zlib from 'node:zlib';

/** Entries whose bytes only record who wrote the file. */
const STAMP_ENTRIES = new Set(['mimetype', 'meta.json']);

function entries(buf: Buffer): Array<{ name: string; data: Buffer }> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad zip directory.');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported zip method ${method}.`);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Stable across repackaging and generator/version stamps; document.json is compared as canonical JSON. */
export async function semanticZipDigest(file: string): Promise<string> {
  const h = createHash('sha256');
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  for (const e of entries(await fs.readFile(file)).filter((x) => !STAMP_ENTRIES.has(x.name) && !x.name.endsWith('/')).sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(e.name).update('\0');
    if (e.name.endsWith('.json')) {
      try { h.update(JSON.stringify(canon(JSON.parse(e.data.toString('utf8'))))); continue; } catch { /* hash raw bytes */ }
    }
    h.update(e.data);
  }
  return h.digest('hex');
}

// Minimal, defensive ZIP support for adapter packages (.ccadapter). No dependency: the central directory is
// parsed with Node's zlib. The reader REJECTS anything unusual instead of trying to cope: encryption,
// zip64, symlinks, absolute or parent-relative names, drive letters, duplicate or case-colliding names,
// oversize entries and decompression bombs (declared AND actual sizes are enforced).

import zlib from 'node:zlib';

export interface ZipLimits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
export const PACKAGE_LIMITS: ZipLimits = { maxFiles: 200, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 };

export class ZipError extends Error {}

/** A package-relative name that is safe on Windows and POSIX: forward slashes, no `..`, no absolute paths. */
export function safeEntryName(raw: string): string {
  if (!raw || raw.length > 200) throw new ZipError('empty or too long file name in package');
  if (raw.includes('\0')) throw new ZipError('NUL in file name');
  if (raw.includes('\\')) throw new ZipError(`backslash in file name "${raw}"`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new ZipError(`absolute path "${raw}"`);
  for (const part of raw.split('/')) {
    if (part === '' || part === '.' || part === '..') throw new ZipError(`unsafe path segment in "${raw}"`);
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
    if (/[<>:"|?*\x00-\x1f]/.test(part)) throw new ZipError(`illegal character in "${raw}"`);
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part)) throw new ZipError(`reserved Windows name in "${raw}"`);
    if (/[. ]$/.test(part)) throw new ZipError(`name ends with a dot or space in "${raw}"`);
  }
  return raw;
}

/** Reads every file entry of a ZIP held in memory. Directory entries are skipped. */
export function readZip(buf: Buffer, limits: ZipLimits = PACKAGE_LIMITS): Map<string, Buffer> {
  // End of central directory record: search backwards (the comment may be up to 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a ZIP file');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw new ZipError('zip64 packages are not supported');
  if (cdOff + cdSize > eocd) throw new ZipError('corrupt central directory');
  if (total > limits.maxFiles * 2) throw new ZipError(`package has more than ${limits.maxFiles} files`);

  const out = new Map<string, Buffer>();
  const seen = new Set<string>();
  let declaredTotal = 0;
  let p = cdOff;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('corrupt central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttr = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith('/')) continue; // directory entry
    if (flags & 1) throw new ZipError(`encrypted entry "${rawName}"`);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new ZipError('zip64 packages are not supported');
    if (((externalAttr >>> 16) & 0xf000) === 0xa000) throw new ZipError(`symbolic link "${rawName}"`);
    const name = safeEntryName(rawName);
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw new ZipError(`duplicate or case-colliding file "${name}"`);
    seen.add(folded);
    if (seen.size > limits.maxFiles) throw new ZipError(`package has more than ${limits.maxFiles} files`);
    if (usize > limits.maxFileBytes) throw new ZipError(`"${name}" is larger than ${limits.maxFileBytes} bytes`);
    declaredTotal += usize;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipError(`package is larger than ${limits.maxTotalBytes} bytes unpacked`);

    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new ZipError(`corrupt local header for "${name}"`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw new ZipError(`"${name}" runs past the end of the file`);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(limits.maxFileBytes, usize + 1) }); } catch { throw new ZipError(`"${name}" cannot be decompressed within its declared size`); }
    } else throw new ZipError(`unsupported compression method ${method} for "${name}"`);
    if (data.length !== usize) throw new ZipError(`"${name}" size does not match its header`);
    if (crc32(data) !== crc) throw new ZipError(`"${name}" failed its checksum`);
    out.set(name, data);
  }
  return out;
}

/** Store-only ZIP writer (deterministic: fixed timestamps, sorted names). Used by the packer and tests. */
export function writeZip(files: Map<string, Buffer> | Record<string, Buffer | string>): Buffer {
  const entries = (files instanceof Map ? [...files.entries()] : Object.entries(files)).map(([n, d]) => [n, Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8')] as const);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

let table: Uint32Array | null = null;
export function crc32(b: Buffer): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[i] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

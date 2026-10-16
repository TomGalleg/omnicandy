// Packs an adapter folder into a .ccadapter file: computes the SHA-256 of every file, writes them into
// adapter.json and (optionally) signs adapter.json with an Ed25519 key.
//
//   node scripts/pack-adapter.mjs <folder> <out.ccadapter> [--key <private-key.pem>] [--generate-key <private-key.pem>]
//
// Without --key/--generate-key the package is unsigned (CreateCraft installs it only on explicit confirmation).
// The private key stays yours: it is never part of the package. The folder must contain adapter.json
// (its "files" field is filled in here) and the files listed under runtime.entry.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

let crcTable = null;
function crc32(b) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[i] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Deflated, deterministic ZIP (sorted names, fixed timestamps). */
export function zipFiles(files) {
  const entries = [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const locals = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = comp.length < data.length;
    const body = useDeflate ? comp : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, body);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function generateKeyFile(file) {
  const { privateKey } = generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
}

function walk(dir, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
    else throw new Error(`${rel} is not a regular file`);
  }
  return out;
}

/** Returns { bytes (the .ccadapter), manifest, fingerprint }. */
export function packAdapter({ dir, privateKeyPem }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'adapter.json'), 'utf8'));
  const files = new Map();
  for (const rel of walk(dir)) {
    if (rel === 'adapter.json' || rel === 'adapter.sig') continue;
    files.set(rel, fs.readFileSync(path.join(dir, ...rel.split('/'))));
  }
  manifest.files = Object.fromEntries([...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, b]) => [n, createHash('sha256').update(b).digest('hex')]));
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  files.set('adapter.json', manifestBytes);
  let fingerprint = null;
  if (privateKeyPem) {
    const key = createPrivateKey(privateKeyPem);
    const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
    files.set('adapter.sig', Buffer.from(JSON.stringify({ algorithm: 'ed25519', publicKey: der.toString('base64'), signature: sign(null, manifestBytes, key).toString('base64') }), 'utf8'));
    fingerprint = createHash('sha256').update(der).digest('hex').slice(0, 32).toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
  }
  return { bytes: zipFiles(files), manifest, fingerprint };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('pack-adapter.mjs')) {
  const [dir, out, ...rest] = process.argv.slice(2);
  if (!dir || !out) {
    console.error('usage: node scripts/pack-adapter.mjs <folder> <out.ccadapter> [--key key.pem] [--generate-key key.pem]');
    process.exit(2);
  }
  let keyFile = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--generate-key') { keyFile = rest[++i]; if (!fs.existsSync(keyFile)) generateKeyFile(keyFile); }
    else if (rest[i] === '--key') keyFile = rest[++i];
  }
  const r = packAdapter({ dir, privateKeyPem: keyFile ? fs.readFileSync(keyFile, 'utf8') : undefined });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, r.bytes);
  console.log(`${out}: ${r.manifest.id} ${r.manifest.version}, ${Object.keys(r.manifest.files).length + 1} files, ${r.bytes.length} bytes, ${r.fingerprint ? `signed (${r.fingerprint})` : 'UNSIGNED'}`);
}

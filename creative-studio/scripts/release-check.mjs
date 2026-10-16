// Release gate: refuses to let a build ship with development keys, unsigned or unlisted connectors, sample/test material,
// or anyone else's proprietary programs.
//
//   node scripts/release-check.mjs <resources folder> [--allow-dev]
//
// <resources folder> is what ends up next to the installed application (it holds adapters/ and trust/). Checks:
//   1. every bundled .ccadapter parses, every file matches its recorded SHA-256, and its Ed25519 signature is valid
//   2. its signing key fingerprint is listed in trust/release-publishers.json (official release keys only)
//      (--allow-dev downgrades this to a warning, for local test builds ONLY; the result is then NOT releasable)
//   3. no private key material (*.pem, *.key, .local), no fixtures, no sample connectors, no test application
//   4. no Autodesk or Adobe programs or libraries are bundled
//
// Exit code 0 only when the build may be released.
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FORBIDDEN_FILE = /(^|[\\/])(\.local|fixtures|simcad)([\\/]|$)|\.(pem|key|p12|pfx)$/i;
const VENDOR_BINARY = /(Revit|AcCore|acad|Photoshop|Illustrator|Premiere|AfterFX|InDesign|3dsmax|Inventor|Fusion360|Autodesk|Adobe)[^\\/]*\.(exe|dll|rvt|addin|zxp|ccx)$/i;

/** Reads a ZIP into Map<name, Buffer> (stored and deflated entries; no encryption, no ZIP64: connectors are small). */
export function readZip(buf) {
  const out = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const body = buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const fingerprintOf = (der) => createHash('sha256').update(der).digest('hex').slice(0, 32).toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');

/** Returns { id, version, fingerprint, problems[] } for one package file. */
export function inspectPackage(file) {
  const problems = [];
  let files;
  try { files = readZip(fs.readFileSync(file)); } catch (e) { return { id: null, version: null, fingerprint: null, problems: [`cannot read: ${e.message}`] }; }
  const mb = files.get('adapter.json');
  if (!mb) return { id: null, version: null, fingerprint: null, problems: ['adapter.json is missing'] };
  const m = JSON.parse(mb.toString('utf8'));
  for (const [name, hash] of Object.entries(m.files ?? {})) {
    const b = files.get(name);
    if (!b) problems.push(`listed file ${name} is missing`);
    else if (createHash('sha256').update(b).digest('hex') !== hash) problems.push(`${name} does not match its recorded SHA-256`);
  }
  for (const name of files.keys()) if (name !== 'adapter.json' && name !== 'adapter.sig' && !(name in (m.files ?? {}))) problems.push(`${name} is not listed in the manifest`);
  let fingerprint = null;
  const sb = files.get('adapter.sig');
  if (!sb) problems.push('the package is not signed');
  else {
    try {
      const j = JSON.parse(sb.toString('utf8'));
      const der = Buffer.from(j.publicKey, 'base64');
      const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
      fingerprint = fingerprintOf(der);
      if (!verify(null, mb, key, Buffer.from(j.signature, 'base64'))) problems.push('the signature does not match the manifest');
    } catch (e) { problems.push(`signature unreadable: ${e.message}`); }
  }
  if (/^sample\./.test(m.id ?? '')) problems.push('sample connectors must not ship in a release');
  if ((m.integration?.host?.simulated ?? false) === true) problems.push('a connector for a simulated test application must not ship in a release');
  return { id: m.id ?? null, version: m.version ?? null, fingerprint, problems };
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(p); out.push(...walk(p)); } else out.push(p);
  }
  return out;
}

export function releaseCheck(resourcesDir, { allowDev = false } = {}) {
  const errors = [];
  const warnings = [];
  const info = [];
  const listFile = path.join(resourcesDir, 'trust', 'release-publishers.json');
  let listed = [];
  try { listed = (JSON.parse(fs.readFileSync(listFile, 'utf8')).publishers ?? []).map((p) => String(p.fingerprint).toUpperCase()); } catch { errors.push('trust/release-publishers.json is missing or unreadable'); }
  const adaptersDir = path.join(resourcesDir, 'adapters');
  const packages = fs.existsSync(adaptersDir) ? fs.readdirSync(adaptersDir).filter((n) => /\.ccadapter$/i.test(n)) : [];
  for (const n of packages) {
    const r = inspectPackage(path.join(adaptersDir, n));
    for (const p of r.problems) errors.push(`${n}: ${p}`);
    if (r.fingerprint && !listed.includes(r.fingerprint)) {
      const msg = `${n}: signed with ${r.fingerprint}, which is not an official release key (trust/release-publishers.json)`;
      (allowDev ? warnings : errors).push(msg);
    }
    info.push(`${n}: ${r.id} ${r.version}, key ${r.fingerprint ?? 'none'}`);
  }
  for (const p of walk(resourcesDir)) {
    const rel = path.relative(resourcesDir, p);
    if (FORBIDDEN_FILE.test(rel)) errors.push(`forbidden file in the release: ${rel}`);
    if (VENDOR_BINARY.test(rel)) errors.push(`proprietary vendor file in the release: ${rel}`);
  }
  return { ok: errors.length === 0 && !(allowDev && warnings.length), errors, warnings, info, releasable: errors.length === 0 && warnings.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/release-check.mjs <resources folder> [--allow-dev]'); process.exit(2); }
  const allowDev = process.argv.includes('--allow-dev');
  const r = releaseCheck(path.resolve(dir), { allowDev });
  for (const i of r.info) console.log(`  ${i}`);
  for (const w of r.warnings) console.log(`WARN  ${w}`);
  for (const e of r.errors) console.log(`FAIL  ${e}`);
  console.log(r.releasable ? 'RELEASABLE: every bundled connector is verified and signed by an official release key.' : allowDev && r.errors.length === 0 ? 'NOT RELEASABLE: development-signed test build (--allow-dev).' : 'NOT RELEASABLE.');
  process.exit(r.errors.length === 0 && (r.releasable || allowDev) ? 0 : 1);
}

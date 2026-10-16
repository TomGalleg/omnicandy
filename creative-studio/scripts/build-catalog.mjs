// Builds the connectors that ship with CreateCraft (resources/adapters/*.ccadapter) from their source folders.
//
//   node scripts/build-catalog.mjs                          development build, signed with the LOCAL DEVELOPMENT key
//   node scripts/build-catalog.mjs --release <key.pem>      release build, signed with the official release key
//                                                           (or set CC_RELEASE_KEY to the key file)
//
// The development key lives in .local/ (never committed) and is NOT a publisher identity: scripts/release-check.mjs refuses
// to ship a build signed with it. A release key must come from the release owner's secure store (docs/release-signing.md);
// this script never creates one. The user still reviews the publisher key (shown as a fingerprint) the first time unless the
// key's fingerprint is listed in resources/trust/release-publishers.json. Nothing is installed or trusted silently.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyFile, packAdapter } from './pack-adapter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const ri = args.indexOf('--release');
const releaseKey = ri >= 0 ? args[ri + 1] : process.env.CC_RELEASE_KEY;
const release = ri >= 0 || !!process.env.CC_RELEASE_KEY;

let key;
if (release) {
  if (!releaseKey || !fs.existsSync(releaseKey)) { console.error('release build: give the release key file (--release <key.pem> or CC_RELEASE_KEY).'); process.exit(2); }
  key = path.resolve(releaseKey);
  if (key.startsWith(path.join(root, '.local'))) { console.error('release build: the key is inside .local/, which holds the development key. Use the official release key.'); process.exit(2); }
} else {
  key = path.join(root, '.local', 'createcraft-integrations.key.pem');
  if (!fs.existsSync(key)) { fs.mkdirSync(path.dirname(key), { recursive: true }); generateKeyFile(key); console.log(`generated DEVELOPMENT signing key ${key}`); }
}
const out = path.join(root, 'resources', 'adapters');
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (/\.ccadapter$/i.test(f)) fs.rmSync(path.join(out, f));
const catalog = [];
// Official connectors only. Samples (fixtures/sample-adapter, hybrid-sample, internal-sample) are never part of the catalog.
for (const dir of ['freecad-adapter']) {
  const src = path.join(root, 'fixtures', dir);
  const r = packAdapter({ dir: src, privateKeyPem: fs.readFileSync(key, 'utf8') });
  const file = path.join(out, `${r.manifest.id}-${r.manifest.version}.ccadapter`);
  fs.writeFileSync(file, r.bytes);
  catalog.push({ file: path.basename(file), id: r.manifest.id, version: r.manifest.version, fingerprint: r.fingerprint, keyKind: release ? 'release' : 'development' });
  console.log(`${path.relative(root, file)}: ${r.bytes.length} bytes, signed ${r.fingerprint} (${release ? 'release' : 'DEVELOPMENT'} key)`);
}
fs.writeFileSync(path.join(out, 'catalog.json'), `${JSON.stringify({ generatedBy: release ? 'release' : 'development', adapters: catalog }, null, 2)}\n`);
if (release) {
  const der = createPublicKey(createPrivateKey(fs.readFileSync(key, 'utf8'))).export({ type: 'spki', format: 'der' });
  console.log('Add this fingerprint to resources/trust/release-publishers.json (release owner decision):', catalog[0]?.fingerprint, `(${der.length}-byte public key)`);
}

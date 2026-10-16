// Builds the connectors that ship with CreateCraft (resources/adapters/*.ccadapter) from their source folders.
// They are signed with the CreateCraft Integrations key kept in .local/ (never committed). The user still reviews and
// trusts the publisher key (shown as a fingerprint) the first time; nothing is installed or trusted silently.
//
//   node scripts/build-catalog.mjs
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyFile, packAdapter } from './pack-adapter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const key = path.join(root, '.local', 'createcraft-integrations.key.pem');
if (!fs.existsSync(key)) { fs.mkdirSync(path.dirname(key), { recursive: true }); generateKeyFile(key); console.log(`generated signing key ${key}`); }
const out = path.join(root, 'resources', 'adapters');
fs.mkdirSync(out, { recursive: true });
for (const dir of ['freecad-adapter']) {
  const src = path.join(root, 'fixtures', dir);
  const r = packAdapter({ dir: src, privateKeyPem: fs.readFileSync(key, 'utf8') });
  const file = path.join(out, `${r.manifest.id}-${r.manifest.version}.ccadapter`);
  fs.writeFileSync(file, r.bytes);
  console.log(`${path.relative(root, file)}: ${r.bytes.length} bytes, signed ${r.fingerprint}`);
}

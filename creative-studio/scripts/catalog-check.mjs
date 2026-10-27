// Compares OmniCandy's Higgsfield model catalog with Higgsfield's public documentation and says what changed.
// It only READS public pages (no key, no paid request) and never edits anything: a new model still needs a person to read its
// page before it is wired in, because a wrong setting fails on a paid API.
//   npm run catalog:check
// Exit code 1 means something needs a look (so a scheduled run can notify).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = 'https://docs.higgsfield.ai';
const src = readFileSync(path.join(root, 'src/shared/higgsfield.ts'), 'utf8');

const text = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'OmniCandy-catalog-check' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.text();
};
// "2.5" and "2-5" are the same version; "3.0" and "3" too.
const norm = (s) => s.toLowerCase().replace(/(\d)\.0(?!\d)/g, '$1').replace(/[^a-z0-9]/g, '');

// Known and deliberately not wired (each with its reason), so a run only speaks up about what is NEW.
const KNOWN = [
  { match: /wan-2-6|wan-2-7/, why: 'Wan 2.6 and 2.7 pages not read yet' },
  { match: /higgsfield-ai\/soul/, why: 'Soul: the docs name two different endpoints' },
  { match: /hailuo-2\.3\/standard\/image-to-video/, why: 'Hailuo picture-to-video: parameters not read yet' },
];
const known = (s) => KNOWN.find((k) => k.match.test(s));

// ---- What the catalog wires: endpoint ids and their source pages
const consts = Object.fromEntries([...src.matchAll(/^const (\w+) = [`']([^`']+)[`'];/gm)].map((m) => [m[1], m[2]]));
const resolve = (s) => { let out = s; for (let i = 0; i < 4; i++) out = out.replace(/\$\{(\w+)\}/g, (_, k) => consts[k] ?? ''); return out; };
const modelsBlock = src.slice(src.indexOf('export const HF_MODELS'), src.indexOf('export const hfModel'));
const wired = [...modelsBlock.matchAll(/^\s{4}id: '([^']+)'.*?source: (`[^`]+`|[A-Z0-9_]+)/gms)].map((m) => ({
  id: m[1],
  source: resolve(m[2].startsWith('`') ? m[2].slice(1, -1) : consts[m[2]] ?? ''),
}));
const keyOf = (id) => norm(id.split('/').slice(1).join('/').replace(/\/v\d[\d.]*$/, '').replace(/\/(pro|standard)\//, '/$1'));

const problems = [];
const notes = [];

// ---- 1. Do the pages the catalog was read from still exist?
for (const w of wired) {
  if (!/^https:\/\/docs\.higgsfield\.ai\//.test(w.source)) { problems.push(`${w.id}: no docs source recorded`); continue; }
  try { await text(w.source); } catch (e) { problems.push(`${w.id}: its source page is gone (${e.message})`); }
}

// ---- 2. Model pages in the docs that the catalog does not wire
let pages = [];
for (const idx of ['/docs/api-reference/overview.md', '/docs/llms.txt']) {
  try { pages.push(...[...(await text(DOCS + idx)).matchAll(/\/docs\/models\/([^\s)"'#]+?)\.md/g)].map((m) => m[1])); } catch (e) { notes.push(`Could not read ${idx}: ${e.message}`); }
}
pages = [...new Set(pages)];
const wiredKeys = wired.map((w) => keyOf(w.id));
for (const p of pages) {
  const k = norm(p);
  if (wiredKeys.some((w) => w.startsWith(k) || k.startsWith(w))) continue;
  const kn = known(p);
  if (kn) notes.push(`known, skipped: ${p} (${kn.why})`);
  else problems.push(`New or unwired model page: ${DOCS}/docs/models/${p}.md`);
}

// ---- 3. Endpoints in the API file that the catalog does not wire, and wired ones that vanished from it
try {
  const spec = JSON.parse(await text(`${DOCS}/docs/openapi.json`));
  const paths = Object.keys(spec.paths ?? {}).filter((p) => !p.startsWith('/requests') && !p.startsWith('/files'));
  for (const p of paths) {
    const id = p.replace(/^\//, '');
    if (wired.some((w) => w.id === id || keyOf(w.id) === keyOf(id))) continue;
    const kn = known(id);
    if (kn) notes.push(`known, skipped: ${p} (${kn.why})`);
    else problems.push(`API file lists an endpoint the catalog does not have: ${p}`);
  }
  for (const w of wired.filter((x) => /openapi\.json/.test(x.source))) {
    if (!paths.includes(`/${w.id}`)) problems.push(`${w.id} was read from the API file but is no longer in it`);
  }
} catch (e) { notes.push(`Could not read the API file: ${e.message}`); }

// ---- Report
console.log(`Higgsfield catalog check: ${wired.length} models wired, ${pages.length} model pages in the docs.`);
for (const n of notes) console.log(`  note: ${n}`);
if (!problems.length) { console.log('Nothing new. The catalog matches the public documentation.'); process.exit(0); }
console.log(`\n${problems.length} thing${problems.length === 1 ? '' : 's'} to look at:`);
for (const p of problems) console.log(`  - ${p}`);
console.log('\nNothing was changed. Read each page, then update src/shared/higgsfield.ts and its tests.');
process.exit(1);

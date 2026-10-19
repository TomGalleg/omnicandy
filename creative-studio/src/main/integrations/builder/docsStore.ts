// Documentation for the AI Adapter Builder: where it comes from, how it is fetched safely, where it is kept, and how the origins
// are combined. Documentation is UNTRUSTED INPUT: it is stored and shown as plain text, handed to Claude as reference data (never as
// instructions) and never executed. Nothing here is shared or uploaded; the only network use is reading public documentation files.
//
// Priority when collecting (all origins are combined, each document remembers where it came from):
//   1. official documentation online      (curated pages on hosts OmniCandi knows are official)
//   2. official source repositories       (single files from the vendor's repository at the tag of the installed version)
//   3. documentation installed with the program (a few text files from its own folder)
//   4. documentation the user provided
//
// Stored under <root>/docs/<app>/<version>/: index.json plus one .txt per document. Entries older than STALE_DAYS are "outdated"
// and can be refreshed; nothing is re-downloaded unless asked or the entry is missing.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { slug } from './blueprint';
import type { AuthorDoc } from './author';

export type DocOrigin = 'official-online' | 'official-repo' | 'local-install' | 'user';

export const DOC_ORIGIN_LABEL: Record<DocOrigin, string> = {
  'official-online': 'Official documentation (online)', 'official-repo': 'Official source repository', 'local-install': 'Installed with the program', user: 'Provided by you',
};
export const DOC_ORIGIN_RANK: Record<DocOrigin, number> = { 'official-online': 1, 'official-repo': 2, 'local-install': 3, user: 4 };

export interface StoredDoc {
  id: string;
  origin: DocOrigin;
  /** https address for online and repository documents; user-doc://<app>/<name> for local and user documents (never fetched). */
  url: string;
  title: string;
  appSlug: string;
  /** The program version this documentation applies to (the repository tag), or null when unknown. */
  /** The Python module this document defines, when it defines one (for example "Part"). */
  module: string | null;
  appVersion: string | null;
  /** What the version label means, for display ("repository tag 1.1.4", "development branch"). */
  versionNote: string;
  fetchedAt: string;
  bytes: number;
  sha256: string;
  text: string;
}

export const STALE_DAYS = 45;
export const MAX_DOC_BYTES = 400_000;

// ---------------------------------------------------------------- curated official sources

export interface DocSource {
  url: string; title: string; origin: 'official-online' | 'official-repo'; purpose: string;
  /** The Python module this document stands for (module-level functions are written Module.name). */
  module?: string;
  /** Tried when this file does not exist at the requested version (module stubs only exist in newer releases). */
  fallback?: DocSource;
}

const FC_RAW = 'https://raw.githubusercontent.com/FreeCAD/FreeCAD';
const FC_WIKI = 'https://raw.githubusercontent.com/FreeCAD/FreeCAD-documentation/main/wiki';

/** FreeCAD's own repository: the Python API stubs (.pyi) carry the exact signatures, pinned to the tag of the installed version. */
function freecadSources(ref: string): DocSource[] {
  const f = (p: string, title: string, purpose: string): DocSource => ({ url: `${FC_RAW}/${ref}/${p}`, title, origin: 'official-repo', purpose });
  return [
    { ...f('src/App/FreeCAD.module.pyi', 'FreeCAD module: newDocument, openDocument, closeDocument...', 'creating, opening and closing documents'), module: 'FreeCAD', fallback: { ...f('src/App/ApplicationPy.cpp', 'FreeCAD module (C++ method table with signatures): newDocument, openDocument, closeDocument...', 'creating, opening and closing documents'), module: 'FreeCAD' } },
    f('src/App/Document.pyi', 'FreeCAD Document: addObject, recompute, saveAs, getObject...', 'editing and saving documents'),
    f('src/App/DocumentObject.pyi', 'FreeCAD DocumentObject: setExpression, Shape links...', 'objects and expressions'),
    { ...f('src/Mod/Part/App/Part.module.pyi', 'Part module: makeBox, makeCylinder, show...', 'creating solids'), module: 'Part', fallback: { ...f('src/Mod/Part/App/AppPartPy.cpp', 'Part module (C++ method table with signatures): makeBox, makeCylinder, show...', 'creating solids'), module: 'Part' } },
    f('src/App/ComplexGeoData.pyi', 'FreeCAD ComplexGeoData (base of shapes): BoundBox, Placement...', 'bounding boxes of shapes'),
    f('src/Mod/Part/App/TopoShape.pyi', 'Part TopoShape: cut, fuse, isValid, isNull, Volume, Solids, BoundBox...', 'solid operations and inspection'),
    f('src/Mod/Spreadsheet/App/Sheet.pyi', 'Spreadsheet Sheet: set, setAlias...', 'parametric spreadsheets'),
    f('src/Base/Vector.pyi', 'FreeCAD Vector', 'vectors'),
    f('src/Base/Placement.pyi', 'FreeCAD Placement', 'placements'),
    f('src/Base/Rotation.pyi', 'FreeCAD Rotation', 'rotations'),
    { url: `${FC_WIKI}/Topological_data_scripting.md`, title: 'FreeCAD wiki: Topological data scripting', origin: 'official-online', purpose: 'worked examples with Part shapes' },
    { url: `${FC_WIKI}/Python_scripting_tutorial.md`, title: 'FreeCAD wiki: Python scripting tutorial', origin: 'official-online', purpose: 'documents, objects, recompute, save' },
    { url: `${FC_WIKI}/FreeCAD_Scripting_Basics.md`, title: 'FreeCAD wiki: Scripting basics', origin: 'official-online', purpose: 'scripting overview' },
  ];
}

/** Curated documentation per program (data owned by OmniCandi; a row is added only after its files were checked to exist). */
export function curatedSources(appSlugName: string, version: string | null): { sources: DocSource[]; versionNote: string; appVersion: string | null } {
  if (appSlugName === 'freecad') {
    const tagged = version && /^\d+\.\d+\.\d+$/.test(version);
    return {
      sources: freecadSources(tagged ? version : 'main'), appVersion: tagged ? version : null,
      versionNote: tagged ? `repository tag ${version}` : 'development branch (the installed version could not be read, so signatures may differ)',
    };
  }
  return { sources: [], appVersion: version, versionNote: 'no curated documentation for this program' };
}

// ---------------------------------------------------------------- safe fetching

/** Hosts the collector will download from on its own (curated sources only). Anything else is read by Claude's own web tools or supplied by the user. */
export const FETCH_HOSTS = ['raw.githubusercontent.com'];

export type Fetcher = (url: string) => Promise<{ status: number; contentType: string; body: string }>;

export const realFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'OmniCandi-docs/0.1', accept: 'text/plain,text/markdown,text/html;q=0.8' } });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_DOC_BYTES) throw new Error(`The document is larger than ${MAX_DOC_BYTES} bytes.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOC_BYTES) throw new Error(`The document is larger than ${MAX_DOC_BYTES} bytes.`);
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: buf.toString('utf8') };
};

/** Plain text only: scripts and styles of HTML are dropped, control characters removed, size capped. Never executed. */
export function sanitizeDocText(raw: string, isHtml = false): string {
  let t = raw;
  if (isHtml) t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  t = t.replace(/\u0000/g, '').replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/\r\n?/g, '\n');
  return t.length > MAX_DOC_BYTES ? t.slice(0, MAX_DOC_BYTES) : t;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- the local store

export class DocsStore {
  constructor(readonly root: string) {}
  private dirOf(app: string, version: string | null): string { return path.join(this.root, 'docs', app, version ? slug(version).replace(/-/g, '.') || 'any' : 'unversioned'); }

  async list(app: string, version: string | null): Promise<StoredDoc[]> {
    try {
      const dir = this.dirOf(app, version);
      const idx = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as Array<Omit<StoredDoc, 'text'> & { file: string }>;
      const out: StoredDoc[] = [];
      for (const e of idx) {
        const text = await fs.readFile(path.join(dir, e.file), 'utf8').catch(() => null);
        if (text === null || sha(text) !== e.sha256) continue; // a damaged entry is treated as missing
        const { file: _file, ...rest } = e;
        void _file;
        out.push({ ...rest, text });
      }
      return out;
    } catch { return []; }
  }

  async saveAll(app: string, version: string | null, docs: StoredDoc[]): Promise<void> {
    const dir = this.dirOf(app, version);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const idx: Array<Omit<StoredDoc, 'text'> & { file: string }> = [];
    for (const d of docs) {
      const file = `${d.id}.txt`;
      await fs.writeFile(path.join(dir, file), d.text, 'utf8');
      const { text: _t, ...rest } = d;
      void _t;
      idx.push({ ...rest, file });
    }
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
  }

  async clear(app: string): Promise<void> { await fs.rm(path.join(this.root, 'docs', app), { recursive: true, force: true }); }
}

export const isStale = (d: Pick<StoredDoc, 'fetchedAt' | 'origin'>, now = Date.now()): boolean =>
  (d.origin === 'official-online' || d.origin === 'official-repo') && now - Date.parse(d.fetchedAt) > STALE_DAYS * 86_400_000;

// ---------------------------------------------------------------- local-install and user documentation

const LOCAL_EXT = new Set(['.md', '.txt', '.html', '.htm', '.pyi', '.rst']);
const LOCAL_DIRS = /^(doc|docs|documentation|help|reference|api|sdk|manual)$/i;

/** A few text files from documentation folders inside the program's own install folder. Shallow, capped, never executed. */
export async function collectLocalInstallDocs(installDir: string | null, appSlugName: string, appVersion: string | null): Promise<StoredDoc[]> {
  if (!installDir) return [];
  const found: string[] = [];
  const walk = async (dir: string, depth: number, inDocs: boolean): Promise<void> => {
    if (depth > 3 || found.length >= 25) return;
    for (const e of (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink() || found.length >= 25) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (inDocs || LOCAL_DIRS.test(e.name)) await walk(p, depth + 1, true); }
      else if (inDocs && LOCAL_EXT.has(path.extname(e.name).toLowerCase()) && !/^(license|thirdparty)/i.test(e.name)) found.push(p);
    }
  };
  const base = path.basename(installDir).toLowerCase() === 'bin' ? path.dirname(installDir) : installDir;
  await walk(base, 0, false);
  const out: StoredDoc[] = [];
  for (const f of found) {
    const st = await fs.stat(f).catch(() => null);
    if (!st?.isFile() || st.size > MAX_DOC_BYTES) continue;
    const text = sanitizeDocText(await fs.readFile(f, 'utf8').catch(() => ''), /\.html?$/i.test(f));
    if (text.trim().length < 200) continue;
    out.push(makeDoc({ origin: 'local-install', url: `user-doc://${appSlugName}/installed/${path.basename(f)}`, title: `${path.basename(f)} (installed with the program)`, appSlug: appSlugName, module: null, appVersion, versionNote: 'installed with this program', text }));
  }
  return out;
}

export function userDocsToStored(docs: AuthorDoc[], appSlugName: string, appVersion: string | null): StoredDoc[] {
  return docs.map((d) => makeDoc({ origin: 'user', url: `user-doc://${appSlugName}/user/${encodeURIComponent(d.name)}`, title: d.name, appSlug: appSlugName, module: null, appVersion, versionNote: 'provided by you', text: sanitizeDocText(d.text, /\.html?$/i.test(d.name)) }));
}

export function makeDoc(o: Omit<StoredDoc, 'id' | 'fetchedAt' | 'bytes' | 'sha256'> & { fetchedAt?: string }): StoredDoc {
  const h = sha(o.text);
  return { ...o, id: sha(`${o.url}\n${h}`).slice(0, 16), fetchedAt: o.fetchedAt ?? new Date().toISOString(), bytes: Buffer.byteLength(o.text), sha256: h };
}

// ---------------------------------------------------------------- collection

export interface CollectOptions {
  store: DocsStore;
  appName: string;
  appVersion: string | null;
  installDir?: string | null;
  userDocs?: AuthorDoc[];
  /** Download the curated documentation again even when a stored copy exists. */
  refresh?: boolean;
  fetcher?: Fetcher;
  now?: number;
}

export interface Collected { docs: StoredDoc[]; notes: string[]; appSlug: string; refreshed: boolean; outdated: string[] }

export async function collectDocumentation(o: CollectOptions): Promise<Collected> {
  const app = slug(o.appName);
  const notes: string[] = [];
  const fetcher = o.fetcher ?? realFetcher;
  const cur = curatedSources(app, o.appVersion);
  let stored = await o.store.list(app, cur.appVersion);
  let refreshed = false;
  const outdated = stored.filter((d) => isStale(d, o.now)).map((d) => d.title);
  if (cur.sources.length && (o.refresh || stored.length < cur.sources.length * 0.6)) {
    const fresh: StoredDoc[] = [];
    for (const first of cur.sources) {
     for (let s: DocSource | undefined = first; s; s = s.fallback) {
      try {
        const u = new URL(s.url);
        if (u.protocol !== 'https:' || !FETCH_HOSTS.includes(u.hostname)) { notes.push(`${s.title} was not downloaded: ${u.hostname} is not an allowed documentation host.`); continue; }
        const r = await fetcher(s.url);
        if (r.status !== 200) { notes.push(`${s.title}: the server answered ${r.status}${r.status === 404 ? ' (the file does not exist at this version)' : ''}.${s.fallback ? ' Trying the next official file.' : ''}`); continue; }
        if (!/^text\/|application\/(json|xml)/i.test(r.contentType) && r.contentType) { notes.push(`${s.title}: not a text document (${r.contentType}).`); continue; }
        const text = sanitizeDocText(r.body, /html/i.test(r.contentType));
        if (text.trim().length < 100) { notes.push(`${s.title}: the document was empty.`); continue; }
        fresh.push(makeDoc({ origin: s.origin, url: s.url, title: s.title, appSlug: app, module: s.module ?? null, appVersion: cur.appVersion, versionNote: cur.versionNote, text, fetchedAt: new Date(o.now ?? Date.now()).toISOString() }));
        break;
      } catch (e) { notes.push(`${s.title} could not be downloaded: ${e instanceof Error ? e.message : String(e)}`); }
     }
    }
    if (fresh.length) { await o.store.saveAll(app, cur.appVersion, fresh); stored = fresh; refreshed = true; notes.push(`Downloaded ${fresh.length} official document${fresh.length === 1 ? '' : 's'} (${cur.versionNote}).`); }
    else if (stored.length) notes.push('Could not refresh the documentation; the saved copy is used.');
  } else if (stored.length) notes.push(`Using ${stored.length} saved document${stored.length === 1 ? '' : 's'} (${cur.versionNote}).${outdated.length ? ' Some are outdated; refresh to download them again.' : ''}`);

  const local = await collectLocalInstallDocs(o.installDir ?? null, app, o.appVersion);
  if (local.length) notes.push(`Found ${local.length} documentation file${local.length === 1 ? '' : 's'} installed with the program.`);
  const user = userDocsToStored(o.userDocs ?? [], app, o.appVersion);
  const all = [...stored, ...local, ...user].sort((a, b) => DOC_ORIGIN_RANK[a.origin] - DOC_ORIGIN_RANK[b.origin]);
  return { docs: all, notes, appSlug: app, refreshed, outdated };
}

/** Documentation as the AI sees it: labelled with its origin, flagged as untrusted reference data. */
export function docsForAuthor(docs: StoredDoc[], digestOf: (d: StoredDoc) => string): AuthorDoc[] {
  return docs.map((d) => ({ name: `${d.title} [${DOC_ORIGIN_LABEL[d.origin]}; ${d.versionNote}; cite as ${d.url}]`, text: digestOf(d) }));
}

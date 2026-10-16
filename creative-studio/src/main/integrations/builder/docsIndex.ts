// Turns collected documentation into an index of the API names it really contains, so that (a) the AI is shown exact signatures,
// (b) every citation in a blueprint can be checked against real documentation, and (c) a citation that is missing for a symbol the
// documentation DOES contain can be completed automatically. A symbol that no document contains is never added: it stays uncited and
// the documented-interfaces-only rule refuses the blueprint. The documents are plain text; nothing in them is executed or followed.

import type { Blueprint, BlueprintCommand } from './blueprint';
import type { PyFinding } from './pyguard';
import { DOC_ORIGIN_LABEL, type StoredDoc } from './docsStore';
import type { ResearchData } from './blueprint';

export interface SymbolHit { name: string; owner: string | null; kind: 'function' | 'class' | 'attribute' | 'mention'; signature: string; docId: string; docUrl: string; docTitle: string; origin: StoredDoc['origin'] }

export interface DocIndex {
  /** Every definition by bare name. */
  byName: Map<string, SymbolHit[]>;
  /** The module a document stands for ("Part" for Part.module.pyi), by lower-case module name. */
  modules: Map<string, string[]>;
  docs: StoredDoc[];
}

const moduleOf = (d: Pick<StoredDoc, 'url' | 'module'>): string | null => d.module ?? /\/([A-Za-z_][A-Za-z0-9_]*)\.module\.pyi$/.exec(d.url)?.[1] ?? null;

function extract(d: StoredDoc): SymbolHit[] {
  const hits: SymbolHit[] = [];
  const mod = moduleOf(d);
  const base = { docId: d.id, docUrl: d.url, docTitle: d.title, origin: d.origin };
  let owner: string | null = null;
  let ownerIndent = -1;
  const lines = d.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = /^\s*/.exec(line)![0].length;
    if (owner && line.trim() && indent <= ownerIndent && !/^\s*(@|#|\))/.test(line)) { owner = null; ownerIndent = -1; }
    const cls = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(line);
    if (cls) { owner = cls[2]!; ownerIndent = cls[1]!.length; hits.push({ ...base, name: owner, owner: null, kind: 'class', signature: line.trim().replace(/:\s*$/, '') }); continue; }
    const fn = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (fn) {
      // join a signature that continues over several lines until its parentheses balance
      let sig = line.trim();
      const open = (t: string) => (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
      for (let k = i + 1; k < Math.min(lines.length, i + 16) && open(sig) > 0; k++) sig += ` ${lines[k]!.trim()}`;
      hits.push({ ...base, name: fn[2]!, owner: owner && fn[1]!.length > ownerIndent ? owner : null, kind: 'function', signature: sig.replace(/\s+/g, ' ').slice(0, 220) });
      continue;
    }
    const attr = /^(\s+)([A-Za-z_]\w*)\s*:\s*([^=]+?)(?:\s*=.*)?$/.exec(line);
    if (attr && owner && attr[1]!.length > ownerIndent && !/^(def|class|return|if|for|while)$/.test(attr[2]!)) hits.push({ ...base, name: attr[2]!, owner, kind: 'attribute', signature: `${attr[2]}: ${attr[3]!.trim()}`.slice(0, 160) });
  }
  // C++ method tables: the docstring of a module function starts with its signature, e.g. "makeBox(length,width,height,[pnt,dir]) -- ..."
  if (mod && /\.cpp$/i.test(d.url)) {
    for (const m of d.text.matchAll(/"([A-Za-z_]\w*)\(([^")]*)\)\s*(?:->[^\\"]*|--)/g)) hits.push({ ...base, name: m[1]!, owner: null, kind: 'function', signature: `${m[1]}(${m[2]})`.slice(0, 200) });
  }
  // prose and examples: dotted names such as Part.makeBox or doc.addObject written out in the text
  for (const m of d.text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b(?=\s*\()?/g)) {
    if (hits.length > 4000) break;
    hits.push({ ...base, name: m[2]!, owner: m[1]!, kind: 'mention', signature: m[0] });
  }
  void mod;
  return hits;
}

export function buildIndex(docs: StoredDoc[]): DocIndex {
  const byName = new Map<string, SymbolHit[]>();
  const modules = new Map<string, string[]>();
  for (const d of docs) {
    const m = moduleOf(d);
    if (m) modules.set(m.toLowerCase(), [...(modules.get(m.toLowerCase()) ?? []), d.id]);
    for (const h of extract(d)) byName.set(h.name, [...(byName.get(h.name) ?? []), h]);
  }
  return { byName, modules, docs };
}

const DEFINING: SymbolHit['kind'][] = ['function', 'class', 'attribute'];
const best = (hits: SymbolHit[]): SymbolHit => [...hits].sort((a, b) => DEFINING.indexOf(a.kind) - DEFINING.indexOf(b.kind) || a.origin.localeCompare(b.origin))[0]!;

export interface Resolution { symbol: string; hit: SymbolHit }

/**
 * Is this exact symbol present in the documentation?
 *   "Part.makeBox"      a definition named makeBox in the document that stands for module Part, or the text "Part.makeBox" itself
 *   "FreeCAD.Vector"    for the program's core modules, a class or function Vector defined anywhere in the documentation
 *   "Document.addObject" a method addObject of a class Document
 *   "cut"               a method or function of that name defined anywhere (used for methods called on objects)
 */
export function resolveSymbol(index: DocIndex, symbol: string, coreModules: string[] = []): Resolution | null {
  const parts = symbol.split('.').filter(Boolean);
  if (!parts.length) return null;
  const name = parts.at(-1)!;
  const hits = index.byName.get(name) ?? [];
  const defs = hits.filter((h) => DEFINING.includes(h.kind));
  if (parts.length === 1) return defs.length ? { symbol: owned(best(defs)), hit: best(defs) } : null;
  const head = parts[0]!;
  const modDocs = index.modules.get(head.toLowerCase());
  if (modDocs) {
    const inMod = defs.filter((h) => modDocs.includes(h.docId) && h.owner === null);
    if (inMod.length) return { symbol, hit: best(inMod) };
  }
  const literal = hits.find((h) => h.kind === 'mention' && h.owner === head);
  if (literal) return { symbol, hit: literal };
  if (parts.length === 2) {
    const method = defs.filter((h) => h.owner === head);
    if (method.length) return { symbol, hit: best(method) };
    if (coreModules.some((m) => m.toLowerCase() === head.toLowerCase())) { const anywhere = defs.filter((h) => h.owner === null); if (anywhere.length) return { symbol, hit: best(anywhere) }; }
  }
  return null;
}

const owned = (h: SymbolHit) => (h.owner ? `${h.owner}.${h.name}` : h.name);

/** A compact view for the AI: signatures only, with the address to cite. Capped so the prompt stays small. */
export function digestOf(d: StoredDoc, cap = 14_000): string {
  const hits = extract(d).filter((h) => DEFINING.includes(h.kind));
  if (hits.length >= 3) {
    const lines = [`Source: ${d.url} (${DOC_ORIGIN_LABEL[d.origin]}; ${d.versionNote})`, 'Exact definitions found in this document (cite a symbol exactly as "Owner.name" or "Module.name"):'];
    for (const h of hits) lines.push(h.kind === 'class' ? `class ${h.name}` : `  ${h.owner ? `${h.owner}.` : ''}${h.signature.replace(/^(async\s+)?def\s+/, '')}`);
    return lines.join('\n').slice(0, cap);
  }
  return `Source: ${d.url} (${DOC_ORIGIN_LABEL[d.origin]}; ${d.versionNote})\n${d.text.slice(0, cap)}`;
}

/** Adds the collected documents to the research sources (their origin is known to CreateCraft, not claimed by Claude). */
export function mergeDocSources(research: ResearchData, docs: StoredDoc[]): ResearchData {
  const have = new Set(research.sources.map((s) => s.url));
  const add = docs.filter((d) => !have.has(d.url)).map((d) => ({
    title: d.title.slice(0, 160), url: d.url.slice(0, 300),
    kind: (d.origin === 'user' || d.origin === 'local-install' ? 'user-supplied' : 'official') as 'official' | 'user-supplied',
    note: `${DOC_ORIGIN_LABEL[d.origin]}; ${d.versionNote}; fetched ${d.fetchedAt.slice(0, 10)}. Stored locally.`,
  }));
  const sources = [...research.sources, ...add].slice(0, 30);
  return { ...research, sources, sourcesConsulted: research.sourcesConsulted || add.length > 0 };
}

// ---------------------------------------------------------------- citations

export interface CitationNeeds { symbols: string[]; calls: string[] }

const segments = (sym: string) => sym.split(/[.:/ ()]+/).filter(Boolean);
const covers = (declared: string[], symbol: string) => declared.some((d) => d === symbol || d.startsWith(`${symbol}.`) || symbol.startsWith(`${d}.`));
const callCovered = (declared: string[], call: string) => declared.some((d) => segments(d).includes(call));

export function citationNeeds(findings: PyFinding[]): CitationNeeds {
  return { symbols: [...new Set(findings.flatMap((f) => f.moduleSymbols))], calls: [...new Set(findings.flatMap((f) => f.methodCalls))] };
}

export interface CompletionResult { blueprint: Blueprint; added: Array<{ command: string; symbol: string; url: string }>; unresolved: Array<{ command: string; symbol: string }> }

/**
 * Completes missing citations from the documentation, only where the documentation really contains the symbol. The citation's address
 * is the document that contains it (which must be among the research sources: see mergeDocSources). Everything else stays uncited.
 */
export function completeCitations(bp: Blueprint, needsByCommand: Record<string, CitationNeeds>, index: DocIndex, coreModules: string[]): CompletionResult {
  const next = structuredClone(bp);
  const added: CompletionResult['added'] = [];
  const unresolved: CompletionResult['unresolved'] = [];
  const known = new Set(next.research.sources.map((s) => s.url));
  for (const c of next.commands as BlueprintCommand[]) {
    const need = needsByCommand[c.id];
    if (!need) continue;
    const declared = () => c.docRefs.map((d) => d.symbol);
    const put = (symbol: string, r: Resolution) => {
      if (!known.has(r.hit.docUrl)) { unresolved.push({ command: c.id, symbol }); return; }
      c.docRefs.push({ symbol: r.symbol, url: r.hit.docUrl, note: `Found in "${r.hit.docTitle}": ${r.hit.signature}`.slice(0, 200) });
      added.push({ command: c.id, symbol: r.symbol, url: r.hit.docUrl });
    };
    for (const s of need.symbols) {
      if (covers(declared(), s)) continue;
      const r = resolveSymbol(index, s, coreModules);
      if (r) put(s, r); else unresolved.push({ command: c.id, symbol: s });
    }
    for (const m of need.calls) {
      if (callCovered(declared(), m)) continue;
      const r = resolveSymbol(index, m, coreModules);
      if (r) put(m, r); else unresolved.push({ command: c.id, symbol: `.${m}()` });
    }
  }
  return { blueprint: next, added, unresolved };
}

const SYMBOL_LIKE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Citations that look like exact symbols must exist in the collected documentation. Prose citations are not symbols and are reported, not trusted. */
export function checkCitationsInDocs(bp: Blueprint, index: DocIndex, coreModules: string[]): { missing: Array<{ command: string; symbol: string }>; prose: number } {
  const missing: Array<{ command: string; symbol: string }> = [];
  let prose = 0;
  for (const c of bp.commands) {
    for (const d of c.docRefs) {
      if (!SYMBOL_LIKE.test(d.symbol)) { prose++; continue; }
      if (!resolveSymbol(index, d.symbol, coreModules)) missing.push({ command: c.id, symbol: d.symbol });
    }
  }
  return { missing, prose };
}

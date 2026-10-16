// Reads documentation or SDK files/folders the USER chose, as plain text for the AI. Local only; what is read is limited and
// reported, and binary or unreadable files are skipped with a note instead of guessed at.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthorDoc } from './author';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.html', '.htm', '.json', '.xml', '.py', '.cs', '.js', '.ts', '.h', '.hpp', '.c', '.cpp', '.jsx', '.csv', '.yaml', '.yml', '.ini', '.cfg', '.pyi']);
const MAX_FILE = 120_000;
const MAX_TOTAL = 600_000;
const MAX_FILES = 40;

export interface ReadDocs { docs: AuthorDoc[]; notes: string[] }

function plain(name: string, text: string): string {
  if (/\.html?$/i.test(name)) {
    return text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
  }
  return text;
}

export async function readDocumentation(paths: string[]): Promise<ReadDocs> {
  const docs: AuthorDoc[] = [];
  const notes: string[] = [];
  let total = 0;
  const take = async (file: string): Promise<void> => {
    if (docs.length >= MAX_FILES || total >= MAX_TOTAL) return;
    const ext = path.extname(file).toLowerCase();
    if (ext === '.pdf' || ext === '.docx' || ext === '.chm') { notes.push(`${path.basename(file)} was skipped: CreateCraft reads text, HTML and source files, not ${ext.slice(1).toUpperCase()}. Save it as text or HTML.`); return; }
    if (!TEXT_EXT.has(ext)) return;
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) return;
      let text = plain(file, await fs.readFile(file, 'utf8'));
      if (text.includes('\0')) return;
      if (text.length > MAX_FILE) { text = text.slice(0, MAX_FILE); notes.push(`${path.basename(file)} was cut after ${MAX_FILE / 1000} thousand characters.`); }
      if (total + text.length > MAX_TOTAL) text = text.slice(0, MAX_TOTAL - total);
      total += text.length;
      docs.push({ name: path.basename(file), text });
    } catch { notes.push(`${path.basename(file)} could not be read.`); }
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    for (const e of (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1); else await take(p);
    }
  };
  for (const p of paths) {
    const st = await fs.lstat(p).catch(() => null);
    if (!st || st.isSymbolicLink()) { notes.push(`${path.basename(p)} could not be used.`); continue; }
    if (st.isDirectory()) await walk(p, 0); else await take(p);
  }
  if (docs.length >= MAX_FILES || total >= MAX_TOTAL) notes.push('Only the first part of the documentation was read (size limit).');
  return { docs, notes };
}

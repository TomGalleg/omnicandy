// Documentation LINKS the user pasted into Create Custom Integration. Each address is read once, as plain text, and handed to the AI as
// reference data (never as instructions, never executed). Only public https pages are read: no passwords in the address, no local or
// private network addresses (checked again after every redirect), a size limit and a time limit. Nothing is uploaded.

import dns from 'node:dns/promises';
import net from 'node:net';
import type { AuthorDoc } from './author';
import { MAX_DOC_BYTES, sanitizeDocText } from './docsStore';
export { parseLinks } from '@shared/builder';

export const MAX_LINKS = 10;
const MAX_TEXT = 120_000;
const MAX_REDIRECTS = 4;
const TOTAL_TEXT = 600_000;
const MAX_PAGE_BYTES = MAX_DOC_BYTES * 8;

export interface LinkResponse { status: number; contentType: string; body: string; location: string | null }
export type LinkFetcher = (url: string) => Promise<LinkResponse>;
export interface ReadLinks { docs: AuthorDoc[]; notes: string[] }

export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l); }
  return true;
}

const realResolve = async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** Throws a plain-language reason (finishing the sentence "<link> ...") when the address must not be read. */
export async function checkLink(raw: string, resolve: (host: string) => Promise<string[]> = realResolve): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('is not a web address.'); }
  if (u.protocol !== 'https:') throw new Error('does not start with https://. Only secure web addresses are read.');
  if (u.username || u.password) throw new Error('contains a user name or password. Remove it and use a public page.');
  if (u.port && u.port !== '443') throw new Error('uses an unusual port. Only normal https pages are read.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('points to this computer or a local network. Only public pages are read.');
  const addrs = net.isIP(host) ? [host] : await resolve(host).catch(() => { throw new Error('could not be found (the website name does not exist, or there is no internet).'); });
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('points to this computer or a local network. Only public pages are read.');
  return u;
}

export const realLinkFetcher: LinkFetcher = async (url) => {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'CreateCraft-docs/0.1', accept: 'text/html,text/plain,text/markdown,application/json;q=0.8' } });
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(Buffer.from(value));
    if (size > MAX_PAGE_BYTES) { void reader.cancel(); break; } // a page is read up to a few MB; its text is cut further below
  }
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.concat(chunks).toString('utf8'), location: res.headers.get('location') };
};

/** Reads each pasted link. A link that fails is reported in plain words; the others are still used. */
export async function fetchDocLinks(urls: string[], o: { fetcher?: LinkFetcher; resolve?: (host: string) => Promise<string[]> } = {}): Promise<ReadLinks> {
  const fetcher = o.fetcher ?? realLinkFetcher;
  const docs: AuthorDoc[] = [];
  const notes: string[] = [];
  let total = 0;
  for (const raw of urls.slice(0, MAX_LINKS)) {
    if (total >= TOTAL_TEXT) { notes.push('Only the first links were read (size limit).'); break; }
    try {
      let u = await checkLink(raw, o.resolve);
      let r = await fetcher(u.href);
      for (let hop = 0; r.status >= 300 && r.status < 400 && r.location && hop < MAX_REDIRECTS; hop++) {
        u = await checkLink(new URL(r.location, u).href, o.resolve);
        r = await fetcher(u.href);
      }
      if (r.status >= 300 && r.status < 400) throw new Error('redirects too many times.');
      if (r.status !== 200) throw new Error(`could not be read (the website answered ${r.status}).`);
      if (r.contentType && !/^text\/|application\/(json|xml|xhtml)/i.test(r.contentType)) throw new Error(`is not a text page (${r.contentType.split(';')[0]}). Download it and add it as a file instead.`);
      let text = sanitizeDocText(r.body, /html/i.test(r.contentType) || /^\s*<(!doctype|html)/i.test(r.body)).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
      if (text.length < 200) throw new Error('has almost no readable text (the page may need a browser to show its content). Save the page as HTML and add it as a file instead.');
      if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); notes.push(`${raw} was cut after ${MAX_TEXT / 1000} thousand characters.`); }
      if (text.length < 4000 && r.body.length > text.length * 8) notes.push(`${raw} gave only ${text.length} characters of text; it may be an overview whose details are loaded by a script. Paste links to the detailed pages as well.`);
      total += text.length;
      docs.push({ name: u.href, text });
    } catch (e) { notes.push(`${raw} ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (urls.length > MAX_LINKS) notes.push(`Only the first ${MAX_LINKS} links were used.`);
  return { docs, notes };
}

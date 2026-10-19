import { describe, expect, it } from 'vitest';
import { checkLink, fetchDocLinks, isPrivateAddress, parseLinks, type LinkFetcher, type LinkResponse } from './docLinks';

const PAGE = `<html><head><title>Remote Control</title><style>p{}</style><script>alert(1)</script></head><body><h1>Remote Control API</h1><p>${'The Remote Control plugin exposes HTTP and WebSocket endpoints for a running editor. '.repeat(6)}</p></body></html>`;
const ok = (body = PAGE, contentType = 'text/html; charset=utf-8'): LinkResponse => ({ status: 200, contentType, body, location: null });
const publicDns = async () => ['93.184.216.34'];

describe('parseLinks', () => {
  it('finds links one per line, with bullets, commas and trailing punctuation, once each', () => {
    const text = `https://a.example/x
    * https://b.example/y,
    - (https://c.example/z).
https://a.example/x`;
    expect(parseLinks(text)).toEqual(['https://a.example/x', 'https://b.example/y', 'https://c.example/z']);
  });
  it('ignores blank text', () => { expect(parseLinks('  \n ')).toEqual([]); });
});

describe('checkLink', () => {
  it('accepts a public https page', async () => { expect((await checkLink('https://dev.epicgames.com/documentation/x', publicDns)).hostname).toBe('dev.epicgames.com'); });
  it.each([
    ['not a link', /not a web address/],
    ['http://example.com/x', /https/],
    ['ftp://example.com/x', /https/],
    ['https://user:pw@example.com/x', /user name or password/],
    ['https://example.com:8443/x', /port/],
    ['https://localhost/x', /this computer/],
    ['https://printer.local/x', /this computer/],
    ['https://127.0.0.1/x', /this computer/],
    ['https://10.1.2.3/x', /this computer/],
    ['https://[::1]/x', /this computer/],
  ])('refuses %s', async (raw, why) => { await expect(checkLink(raw, publicDns)).rejects.toThrow(why); });

  it('refuses a name that resolves to a private address, and one that does not resolve', async () => {
    await expect(checkLink('https://sneaky.example/x', async () => ['192.168.1.5'])).rejects.toThrow(/this computer/);
    await expect(checkLink('https://sneaky.example/x', async () => ['93.184.216.34', '127.0.0.1'])).rejects.toThrow(/this computer/);
    await expect(checkLink('https://nope.example/x', async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow(/could not be found/);
  });
});

describe('isPrivateAddress', () => {
  it('knows the private, loopback and link-local ranges', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('fetchDocLinks', () => {
  it('reads a page as plain text without scripts or styles, named by its address', async () => {
    const seen: string[] = [];
    const fetcher: LinkFetcher = async (u) => { seen.push(u); return ok(); };
    const r = await fetchDocLinks(['https://dev.epicgames.com/documentation/en-us/unreal-engine/remote-control-for-unreal-engine'], { fetcher, resolve: publicDns });
    expect(r.notes).toEqual([]);
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0]!.name).toBe('https://dev.epicgames.com/documentation/en-us/unreal-engine/remote-control-for-unreal-engine');
    expect(r.docs[0]!.text).toContain('Remote Control plugin exposes HTTP');
    expect(r.docs[0]!.text).not.toMatch(/alert\(1\)|<h1>|p\{\}/);
    expect(seen).toHaveLength(1);
  });

  it('follows a redirect to another public page, but never to a private address', async () => {
    const fetcher: LinkFetcher = async (u) => u.endsWith('/old') ? { status: 301, contentType: '', body: '', location: '/new' } : u.endsWith('/evil') ? { status: 302, contentType: '', body: '', location: 'https://169.254.169.254/latest/meta-data' } : ok();
    const good = await fetchDocLinks(['https://docs.example/old'], { fetcher, resolve: publicDns });
    expect(good.docs.map((d) => d.name)).toEqual(['https://docs.example/new']);
    const bad = await fetchDocLinks(['https://docs.example/evil'], { fetcher, resolve: publicDns });
    expect(bad.docs).toEqual([]);
    expect(bad.notes.join(' ')).toMatch(/this computer or a local network/);
  });

  it('reports each failing link in plain words and still uses the good ones', async () => {
    const fetcher: LinkFetcher = async (u) => u.includes('missing') ? { status: 404, contentType: 'text/html', body: '', location: null }
      : u.includes('pdf') ? ok('%PDF', 'application/pdf')
        : u.includes('spa') ? ok('<html><body><div id="root"></div></body></html>')
          : u.includes('loop') ? { status: 302, contentType: '', body: '', location: '/loop' }
            : ok();
    const r = await fetchDocLinks(['http://insecure.example/x', 'https://d.example/missing', 'https://d.example/a.pdf', 'https://d.example/spa', 'https://d.example/loop', 'https://d.example/good'], { fetcher, resolve: publicDns });
    expect(r.docs.map((d) => d.name)).toEqual(['https://d.example/good']);
    const n = r.notes.join('\n');
    expect(n).toMatch(/insecure.example\/x does not start with https/);
    expect(n).toMatch(/missing could not be read \(the website answered 404\)/);
    expect(n).toMatch(/not a text page \(application\/pdf\)/);
    expect(n).toMatch(/spa has almost no readable text/);
    expect(n).toMatch(/loop redirects too many times/);
  });

  it('uses at most 10 links and says so', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://d.example/p${i}`);
    const r = await fetchDocLinks(urls, { fetcher: async () => ok(), resolve: publicDns });
    expect(r.docs).toHaveLength(10);
    expect(r.notes.join(' ')).toMatch(/first 10 links/);
  });

  it('cuts a very long page and reports it', async () => {
    const r = await fetchDocLinks(['https://d.example/long'], { fetcher: async () => ok(`<p>${'word '.repeat(60_000)}</p>`), resolve: publicDns });
    expect(r.docs[0]!.text.length).toBeLessThanOrEqual(120_000);
    expect(r.notes.join(' ')).toMatch(/was cut/);
  });
});

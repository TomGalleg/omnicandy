// OPT-IN network test (reads public documentation files; no Claude, no cost): CS_NET_TESTS=1.
// With CS_WRITE_DOC_FIXTURE=1 it also writes the snapshot that the offline tests use (fixtures/ai-generated/docs/freecad-1.1.4).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectDocumentation, DocsStore } from './docsStore';

const on = process.env.CS_NET_TESTS === '1';
const out = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'fixtures', 'ai-generated', 'docs', 'freecad-1.1.4');

describe.skipIf(!on)('collecting the real FreeCAD 1.1.4 documentation', () => {
  it('downloads the curated official files at the 1.1.4 tag and stores them', async () => {
    const store = new DocsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-')));
    const c = await collectDocumentation({ store, appName: 'FreeCAD', appVersion: '1.1.4' });
    console.log(c.notes.join('\n'), c.docs.map((d) => `${d.origin} ${d.bytes} ${d.url}`).join('\n'));
    expect(c.docs.length).toBe(13);
    expect(c.docs.every((d) => d.appVersion === '1.1.4' || d.url.includes('FreeCAD-documentation'))).toBe(true);
    // the second collection comes from the local store, without downloading
    const again = await collectDocumentation({ store, appName: 'FreeCAD', appVersion: '1.1.4', fetcher: async () => { throw new Error('must not download'); } });
    expect(again.docs.length).toBe(13);
    expect(again.refreshed).toBe(false);
    if (process.env.CS_WRITE_DOC_FIXTURE === '1') {
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      const manifest = c.docs.map((d, i) => { const file = `${String(i + 1).padStart(2, '0')}-${path.basename(d.url)}.txt`; fs.writeFileSync(path.join(out, file), d.text); const { text: _t, ...rest } = d; void _t; return { ...rest, file }; });
      fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
      fs.writeFileSync(path.join(out, 'README.md'), '# FreeCAD 1.1.4 documentation snapshot (test fixture)\n\nOfficial files fetched by OmniCandy\'s documentation collector from https://github.com/FreeCAD/FreeCAD (tag 1.1.4, LGPL-2.1-or-later) and https://github.com/FreeCAD/FreeCAD-documentation (wiki export, CC-BY 3.0 per the FreeCAD documentation project). The text is stored unchanged; `manifest.json` records each URL, fetch time and SHA-256. Used only by offline tests.\n');
    }
  }, 180_000);
});

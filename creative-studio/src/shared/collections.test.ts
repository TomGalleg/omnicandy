import { describe, expect, it } from 'vitest';
import { collectionCounts, inCollection } from './collections';
import type { Asset } from './types';

const base = { name: 'a', kind: 'image', relPath: 'x', sha256: '0'.repeat(64), bytes: 1, sourceFormat: 'png', approval: 'none' } as const;
const mk = (o: Partial<Asset>): Asset => ({ ...base, id: Math.random().toString(), provenance: { createdAt: '', origin: 'imported', source: 'Imported by user' }, ...o }) as Asset;

describe('collections', () => {
  const imported = mk({});
  const ai = mk({ provenance: { createdAt: '', origin: 'generated', source: 'AI', provider: 'openai', prompt: 'p' } });
  const edit = mk({ parentId: imported.id, rating: 5, provenance: { createdAt: '', origin: 'generated', source: 'PhotoCraft: Brightness' } });
  const wf = mk({ parentId: imported.id, provenance: { createdAt: '', origin: 'generated', source: 'LightCraft (workflow, no window): Warm' } });
  const all = [imported, ai, edit, wf];

  it('classifies assets without overlapping originals and AI generations', () => {
    expect(inCollection(imported, 'originals')).toBe(true);
    expect(inCollection(ai, 'originals')).toBe(false);
    expect(inCollection(ai, 'ai')).toBe(true);
    expect(inCollection(edit, 'versions')).toBe(true);
    expect(inCollection(edit, 'favorites')).toBe(true);
    expect(inCollection(wf, 'workflows')).toBe(true);
    expect(inCollection(edit, 'workflows')).toBe(false);
  });

  it('counts each collection', () => {
    expect(collectionCounts(all, 3)).toEqual({ all: 4, originals: 1, ai: 1, favorites: 1, versions: 2, workflows: 1, deliverables: 3 });
  });
});

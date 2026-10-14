// Virtual collections: user-facing groupings computed from the manifest. Nothing is moved or
// copied; the project folders stay as they are and an asset can sit in several collections.

import type { Asset } from './types';

export type CollectionId = 'all' | 'originals' | 'ai' | 'favorites' | 'versions' | 'workflows' | 'deliverables';

export const COLLECTIONS: Array<{ id: CollectionId; label: string; hint: string }> = [
  { id: 'all', label: 'All Assets', hint: 'Everything in the project' },
  { id: 'originals', label: 'Originals', hint: 'Files you imported, never modified' },
  { id: 'ai', label: 'AI Generations', hint: 'Images made by an AI provider' },
  { id: 'favorites', label: 'Favorites', hint: 'Rated 4 stars or more' },
  { id: 'versions', label: 'Versions', hint: 'Edited copies; each links back to its source' },
  { id: 'workflows', label: 'Workflows', hint: 'Results made by a workflow run' },
  { id: 'deliverables', label: 'Deliverables', hint: 'Exported files (Exports folder)' },
];

/** True when the AI provider produced this asset itself (not an edit of another file). */
export const isAiGeneration = (a: Asset) => a.provenance.origin === 'generated' && !a.parentId && !!a.provenance.provider;
export const isWorkflowResult = (a: Asset) => /workflow/i.test(a.provenance.source);

/** Whether an asset belongs to a collection (Deliverables are export files, not library assets). */
export function inCollection(a: Asset, id: CollectionId): boolean {
  switch (id) {
    case 'all': return true;
    case 'originals': return !a.parentId && !isAiGeneration(a);
    case 'ai': return isAiGeneration(a);
    case 'favorites': return (a.rating ?? 0) >= 4;
    case 'versions': return !!a.parentId;
    case 'workflows': return isWorkflowResult(a);
    case 'deliverables': return false;
  }
}

export function collectionCounts(assets: Asset[], exportCount: number): Record<CollectionId, number> {
  const out = {} as Record<CollectionId, number>;
  for (const c of COLLECTIONS) out[c.id] = c.id === 'deliverables' ? exportCount : assets.filter((a) => inCollection(a, c.id)).length;
  return out;
}

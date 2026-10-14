import { describe, expect, it } from 'vitest';
import { builtinTemplates, templateCatalogForClaude } from './templates';

describe('built-in templates', () => {
  const all = builtinTemplates();
  it('has the nine templates, with no file choices', () => {
    expect(all).toHaveLength(9);
    for (const t of all) {
      expect(t.graph.nodes.length).toBeGreaterThan(2);
      for (const n of t.graph.nodes.filter((x) => x.type === 'import')) expect(n.params.assetIds).toBe('[]');
    }
  });
  it('only the AI variations template bills, and every template has an approval step', () => {
    const paid = all.filter((t) => t.graph.nodes.some((n) => n.type === 'aiGenerate'));
    expect(paid.map((t) => t.id)).toEqual(['builtin-ai-image-variations']);
    expect(paid[0]!.status).toBe('paid');
    expect(all.every((t) => t.graph.nodes.some((n) => n.type === 'approval'))).toBe(true);
  });
  it('lists them for Claude', () => expect(templateCatalogForClaude()).toContain('builtin-photo-restoration'));
});

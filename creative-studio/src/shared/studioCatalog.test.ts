import { describe, expect, it } from 'vitest';
import { HF_MODELS } from './higgsfield';
import { findModels, STUDIO_MODELS, studioModel } from './providerCapabilities';
import { artSeed, CATEGORIES, categoriesOf, compareRows, describeModel, exploreModels, favKey, modelsForTask, parseFavs, priceInfo, TASKS, taskFor, toggleFav } from './studioCatalog';
import { mergeJobs, viewFromHiggsfield, type StudioJob } from './aiStudio';

const m = (p: string, id: string) => studioModel(p, id)!;

describe('categories', () => {
  it('puts every model in at least one category, and SVG apart from pictures', () => {
    for (const x of STUDIO_MODELS) expect(categoriesOf(x).length, x.id).toBeGreaterThan(0);
    expect(categoriesOf(m('recraft', 'recraftv4_1_vector'))).toContain('vector');
    expect(categoriesOf(m('recraft', 'recraftv4_1_vector'))).not.toContain('video');
    expect(categoriesOf(m('recraft', 'recraftv4_1'))).not.toContain('vector');
    expect(categoriesOf(m('higgsfield', 'bytedance/seedance-2.5/video-extend'))).toEqual(['video']);
    expect(categoriesOf(m('higgsfield', 'bytedance/seedance-2.5/video-edit'))).toEqual(['editing']);
    expect(categoriesOf(m('higgsfield', 'higgsfield/genjutsu/motion-transfer/v1.0'))).toEqual(expect.arrayContaining(['motion', 'characters']));
  });
  it('keeps empty categories (effects, audio) honest instead of inventing models', () => {
    for (const id of ['effects', 'audio']) expect(STUDIO_MODELS.filter((x) => CATEGORIES.find((c) => c.id === id)!.match(x))).toEqual([]);
  });
});

describe('plain-language text and prices', () => {
  it('describes a model from registry facts only', () => {
    expect(describeModel(m('higgsfield', 'bytedance/seedance-2.5/text-to-video'))).toBe(HF_MODELS[0]!.blurb);
    expect(describeModel(m('recraft', 'recraftv4_1_vector'))).toMatch(/editable SVG/);
  });
  it('shows verified prices only', () => {
    expect(priceInfo(m('mock', 'mock-image'))).toEqual({ known: true, text: 'Free' });
    expect(priceInfo(m('recraft', 'recraftv4_1'))).toEqual({ known: true, text: 'from $0.035 per image' });
    expect(priceInfo(m('gemini', 'gemini-nano-banana-2.1')).known).toBe(true);
    expect(priceInfo(m('higgsfield', 'bytedance/seedance-2.5/text-to-video'))).toEqual({ known: false, text: 'Price not published by Higgsfield' });
  });
  it('compares models row by row', () => {
    const rows = compareRows([m('recraft', 'recraftv4_1'), m('higgsfield', 'kling-video/v2.5-turbo/pro/text-to-video')]);
    expect(rows.every((r) => r.values.length === 2)).toBe(true);
    expect(rows.find((r) => r.label === 'Stopping a job')!.values[1]).toMatch(/queued/);
  });
});

describe('tasks', () => {
  it('offers only connected models for a task and lists the rest as planned', () => {
    const vec = modelsForTask(TASKS.find((t) => t.id === 'vector')!);
    expect(vec.wired.map((x) => x.id)).toEqual(['recraftv4_1_vector', 'recraftv4_1_pro_vector', 'recraftv3_vector']);
    const ext = modelsForTask(TASKS.find((t) => t.id === 'extend')!);
    expect(ext.wired.map((x) => x.id)).toEqual(['bytedance/seedance-2.5/video-edit', 'bytedance/seedance-2.5/video-extend']);
    expect(taskFor(m('higgsfield', 'bytedance/seedance-2.5/image-to-video')).id).toBe('animate');
  });
});

describe('explore filtering, favourites and seeds', () => {
  it('filters by category, provider, search, favourites and readiness', () => {
    const all = () => true;
    expect(exploreModels({ category: 'vector', providerId: null, search: '', favoritesOnly: false, readyOnly: false }, [], all).every((x) => x.output === 'svg' || x.operations.includes('vectorize'))).toBe(true);
    expect(exploreModels({ category: null, providerId: 'higgsfield', search: 'kling', favoritesOnly: false, readyOnly: false }, [], all).length).toBe(3);
    const fav = favKey(m('gemini', 'gemini-nano-banana-2.1'));
    expect(exploreModels({ category: null, providerId: null, search: '', favoritesOnly: true, readyOnly: false }, [fav], all).map(favKey)).toEqual([fav]);
    expect(exploreModels({ category: null, providerId: null, search: '', favoritesOnly: false, readyOnly: true }, [], () => false)).toEqual([]);
    expect(findModels({}).length).toBe(STUDIO_MODELS.length);
  });
  it('reads favourites defensively and toggles them', () => {
    expect(parseFavs('not json')).toEqual([]);
    expect(parseFavs('[1,"a"]')).toEqual(['a']);
    expect(toggleFav(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleFav(['a', 'b'], 'a')).toEqual(['b']);
  });
  it('gives the same placeholder colours every time', () => {
    expect(artSeed('x')).toEqual(artSeed('x'));
    expect(artSeed('x')).not.toEqual(artSeed('y'));
  });
});

describe('one job list for every provider', () => {
  it('shows Higgsfield and studio jobs together, newest first, with queued-only cancel', () => {
    const s: StudioJob = { id: 's1', at: '2026-10-27T10:00:00.000Z', providerId: 'recraft', modelId: 'recraftv4_1', modelLabel: 'Recraft V4.1', prompt: 'a', settings: {}, count: 1, referenceAssetIds: [], state: 'done' };
    const h = { id: 'h1', job: { modelId: 'bytedance/seedance-2.5/text-to-video', prompt: 'b', params: { duration: 5 }, inputs: {} }, state: 'queued' as const, requestId: 'r', requestedBy: 'user' as const, createdAt: '2026-10-27T11:00:00.000Z', updatedAt: '', assetIds: [], message: 'wait' };
    const v = mergeJobs([s], [h]);
    expect(v.map((x) => x.id)).toEqual(['hf-h1', 's1']);
    expect(v[0]).toMatchObject({ state: 'queued', cancellable: true, modelLabel: 'Seedance 2.5 · Text to video', settings: { duration: '5' } });
    expect(viewFromHiggsfield({ ...h, state: 'running' }).cancellable).toBe(false);
    expect(viewFromHiggsfield({ ...h, state: 'downloading' }).state).toBe('running');
  });
});

describe('hidden test models', () => {
  it('keeps the offline Mock image out of every list people see, but not out of the registry', () => {
    expect(studioModel('mock', 'mock-image')).toBeDefined();
    const none = { category: null, providerId: null, search: '', favoritesOnly: false, readyOnly: false } as const;
    expect(exploreModels(none, [], () => true).some((x) => x.providerId === 'mock')).toBe(false);
    expect(exploreModels({ ...none, search: 'mock' }, [], () => true)).toEqual([]);
    expect(modelsForTask(TASKS.find((t) => t.id === 'image')!).wired.some((x) => x.providerId === 'mock')).toBe(false);
  });
});

describe('settings summary', () => {
  it('reads the same catalogs the forms use', async () => {
    const { settingsSummary } = await import('./studioCatalog');
    expect(settingsSummary(m('higgsfield', 'bytedance/seedance-2.5/video-edit')).join('|')).toMatch(/Source video \(MP4\): 1 \(needed\)/);
    expect(settingsSummary(m('gemini', 'gemini-nano-banana-2.1')).join('|')).toMatch(/Resolution: 1K, 2K, 4K/);
    expect(settingsSummary(m('recraft', 'recraftv4_1')).join('|')).toMatch(/up to 4/);
    expect(settingsSummary(m('recraft', 'recraft-mask-tools'))).toEqual([]);
  });
});

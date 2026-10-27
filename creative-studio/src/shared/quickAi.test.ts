import { describe, expect, it } from 'vitest';
import { parseDraft } from './aiStudio';
import { studioModel } from './providerCapabilities';
import { actionState, buildDraft, buildRun, modelTakesSource, pickSource, quickChoices, quickHost, QUICK_HOSTS, type QuickAsset, type QuickContext } from './quickAi';
import { normalizeHiggsfieldJob } from './higgsfield';
import { normalizeToolJob } from './recraftTools';
import { normalizeJob } from './generation';

const img: QuickAsset = { id: 'i1', name: 'fox.png', kind: 'image', sourceFormat: 'png' };
const vid: QuickAsset = { id: 'v1', name: 'harbour.mp4', kind: 'video', sourceFormat: 'mp4' };
const ctx = (o: Partial<QuickContext> = {}): QuickContext => ({ open: null, selected: null, selectedClips: [], ...o });
const act = (host: 'photocraft' | 'filmcraft', id: string) => QUICK_HOSTS[host].actions.find((a) => a.id === id)!;
const m = (p: string, id: string) => studioModel(p, id)!;

describe('quick hosts', () => {
  it('starts with PhotoCraft and FilmCraft and says what it cannot do', () => {
    expect(Object.keys(QUICK_HOSTS)).toEqual(['photocraft', 'filmcraft']);
    expect(quickHost('blender')).toBeUndefined();
    expect(QUICK_HOSTS.photocraft.unavailable.join(' ')).toMatch(/new layer/);
  });
});

describe('what an action works on', () => {
  it('prefers the selected file, never a file of the wrong kind', () => {
    expect(pickSource(act('photocraft', 'edit'), ctx({ open: img }))).toEqual(img);
    expect(pickSource(act('photocraft', 'edit'), ctx({ open: img, selected: { ...img, id: 'i2' } }))!.id).toBe('i2');
    expect(pickSource(act('photocraft', 'edit'), ctx({ open: vid }))).toBeNull();
    expect(pickSource(act('filmcraft', 'extend'), ctx({ open: vid, selected: img }))).toEqual(vid);
    expect(pickSource(act('filmcraft', 'video'), ctx({ open: vid }))).toBeNull(); // needs none
  });
  it('explains what is missing in plain words', () => {
    expect(actionState(act('photocraft', 'edit'), ctx()).blocked).toMatch(/Open or select a picture/);
    expect(actionState(act('filmcraft', 'extend'), ctx()).blocked).toMatch(/Open a video/);
    expect(actionState(act('photocraft', 'generate'), ctx()).blocked).toBe('');
    expect(actionState(act('photocraft', 'edit'), ctx({ open: img })).blocked).toBe('');
    // No connected model upscales video yet: said honestly, not hidden.
    expect(actionState(act('filmcraft', 'enhance'), ctx({ open: vid })).blocked).toMatch(/No connected model/);
  });
  it('offers only models that can take the chosen file', () => {
    const s = actionState(act('filmcraft', 'extend'), ctx({ open: vid }));
    expect(s.models.map((x) => x.id)).toEqual(['bytedance/seedance-2.5/video-edit', 'bytedance/seedance-2.5/video-extend']);
    const anim = actionState(act('filmcraft', 'animate'), ctx({ selected: img }));
    expect(quickChoices(anim, new Set(['higgsfield'])).every((c) => c.ready)).toBe(true);
    expect(quickChoices(anim, new Set()).every((c) => !c.ready)).toBe(true);
    expect(modelTakesSource(m('higgsfield', 'bytedance/seedance-2.5/video-extend'), img)).toBe(false);
    expect(modelTakesSource(m('higgsfield', 'bytedance/seedance-2.5/video-extend'), vid)).toBe(true);
    expect(modelTakesSource(m('recraft', 'recraft-tool/vectorize'), vid)).toBe(false);
  });
});

describe('running with the same backend as AI Studio', () => {
  it('builds jobs the real validators accept, with the file in the right slot', () => {
    const hf = buildRun(m('higgsfield', 'bytedance/seedance-2.5/image-to-video'), '', img);
    expect(hf).toMatchObject({ kind: 'higgsfield', job: { inputs: { image_url: ['i1'] } } });
    if (hf.kind === 'higgsfield') expect(() => normalizeHiggsfieldJob(hf.job)).not.toThrow();
    const ext = buildRun(m('higgsfield', 'bytedance/seedance-2.5/video-extend'), 'continue the pan', vid);
    if (ext.kind === 'higgsfield') expect(() => normalizeHiggsfieldJob(ext.job)).not.toThrow();
    const tool = buildRun(m('recraft', 'recraft-tool/removeBackground'), '', img);
    expect(tool.kind).toBe('tool');
    if (tool.kind === 'tool') expect(() => normalizeToolJob(tool.job)).not.toThrow();
    const gen = buildRun(m('gemini', 'gemini-nano-banana-2.1'), 'a fox', img);
    expect(gen).toMatchObject({ kind: 'image', providerId: 'gemini', job: { referenceAssetIds: ['i1'] } });
    if (gen.kind === 'image') expect(() => normalizeJob(gen.job)).not.toThrow();
    expect(buildRun(m('recraft', 'recraftv4_1_vector'), 'a logo', null).kind).toBe('recraft');
    expect(() => buildRun(m('recraft', 'recraft-tool/vectorize'), '', null)).toThrow(/Choose a picture/);
  });
});

describe('opening the full AI Studio keeps everything', () => {
  it('hands over model, prompt, file and Higgsfield inputs through the draft', () => {
    const d = buildDraft('filmcraft', m('higgsfield', 'bytedance/seedance-2.5/image-to-video'), '  slow push in ', img);
    expect(d).toMatchObject({ providerId: 'higgsfield', modelId: 'bytedance/seedance-2.5/image-to-video', prompt: 'slow push in', referenceAssetId: 'i1', from: 'filmcraft', hfInputs: { image_url: ['i1'] } });
    expect(parseDraft(JSON.stringify(d))).toEqual(d);
    expect(parseDraft(JSON.stringify({ from: 'x'.repeat(50), hfInputs: { a: 'nope', b: ['ok', 5] } }))).toEqual({ hfInputs: { b: ['ok'] } });
  });
});

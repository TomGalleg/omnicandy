// How AI Studio PRESENTS the provider registry: categories, plain-language wording, price text, tasks and comparison rows.
// Pure (no React, no network). Nothing here decides what a model can do: that stays in providerCapabilities.ts, so a new
// model added there shows up in the right categories and tasks without any screen being redesigned.

import { estimateCost, formatUsd, modelById } from './generation';
import { hfModel } from './higgsfield';
import { RECRAFT_ASPECTS, RECRAFT_MAX_COUNT } from './recraft';
import {
  findModels, studioProvider, type OutputKind, type StudioModel, type StudioOperation, type StudioProviderId,
} from './providerCapabilities';

export type CategoryId = 'image' | 'video' | 'motion' | 'effects' | 'editing' | 'vector' | 'characters' | 'audio';

export interface Category {
  id: CategoryId;
  label: string;
  blurb: string;
  /** Shown when nothing is connected in this category yet, so the space never looks broken. */
  empty: string;
  match: (m: StudioModel) => boolean;
}

const has = (m: StudioModel, ...ops: StudioOperation[]) => ops.some((o) => m.operations.includes(o));

export const CATEGORIES: Category[] = [
  { id: 'image', label: 'Image & Art', blurb: 'Pictures from a description or a reference.', empty: 'No picture models match.', match: (m) => m.output === 'raster' && has(m, 'text-to-image', 'image-to-image') },
  { id: 'video', label: 'Video & Animation', blurb: 'Clips from text, pictures or other clips.', empty: 'No video models match.', match: (m) => m.output === 'video' && has(m, 'text-to-video', 'image-to-video', 'reference-to-video', 'video-extend') },
  { id: 'motion', label: 'Motion & Camera', blurb: 'Move characters with a reference video.', empty: 'No motion models are connected yet. Camera controls appear here once a provider documents them.', match: (m) => has(m, 'motion-transfer') },
  { id: 'effects', label: 'Effects', blurb: 'Looks and visual effects.', empty: 'No effect models are connected yet. They appear here when a provider documents them.', match: () => false },
  { id: 'editing', label: 'Editing & Enhancement', blurb: 'Change, clean up or sharpen what you already have.', empty: 'No editing models are connected yet.', match: (m) => has(m, 'edit', 'inpaint', 'outpaint', 'replace-background', 'remove-background', 'upscale', 'erase-region', 'video-edit', 'video-enhance') },
  { id: 'vector', label: 'Vector & Design', blurb: 'Real, editable SVG artwork.', empty: 'No vector models match.', match: (m) => m.output === 'svg' || has(m, 'vectorize') },
  { id: 'characters', label: 'Characters & References', blurb: 'Keep a look or character consistent with references.', empty: 'No reference models match.', match: (m) => has(m, 'reference-images', 'reference-to-video', 'motion-transfer') },
  { id: 'audio', label: 'Audio', blurb: 'Sound and music.', empty: 'No audio models are connected yet. They appear here when a provider documents them.', match: () => false },
];

export const categoriesOf = (m: StudioModel): CategoryId[] => CATEGORIES.filter((c) => c.match(m)).map((c) => c.id);

/** Brand colour and a short mark. Recognisable without shipping anyone's logo file. */
export const BRAND: Record<StudioProviderId, { hue: string; mark: string }> = {
  gemini: { hue: '#4f8bff', mark: 'G' }, openai: { hue: '#16a37f', mark: 'O' }, higgsfield: { hue: '#ff5f8a', mark: 'H' },
  recraft: { hue: '#c04fff', mark: 'R' }, local: { hue: '#d99a1f', mark: 'L' }, mock: { hue: '#7a8699', mark: 'M' },
};

export const OP_LABEL: Record<StudioOperation, string> = {
  'text-to-image': 'Text → image', 'image-to-image': 'From a picture', edit: 'Edit', inpaint: 'Inpaint', outpaint: 'Outpaint', 'replace-background': 'New background',
  'text-to-video': 'Text → video', 'image-to-video': 'Animate a picture', 'video-enhance': 'Enhance video', 'video-edit': 'Edit video', 'video-extend': 'Extend video',
  'reference-to-video': 'Reference → video', 'motion-transfer': 'Motion transfer', upscale: 'Upscale', 'remove-background': 'Cut out', vectorize: 'Vectorize', 'erase-region': 'Erase',
  styles: 'Styles', 'color-palette': 'Palette', 'reference-images': 'References',
};

export const outputLabel = (o: OutputKind) => (o === 'svg' ? 'Real SVG' : o === 'video' ? 'Video' : 'Picture');

/** What the app can say about a model, in plain words. Only uses registry facts; never invents capability. */
export function describeModel(m: StudioModel): string {
  if (m.blurb) return m.blurb;
  const out = m.output === 'svg' ? 'editable SVG artwork' : m.output === 'video' ? 'video clips' : 'pictures';
  const ops = m.operations.filter((o) => OP_LABEL[o] && o !== 'text-to-image' && o !== 'styles' && o !== 'color-palette' && o !== 'reference-images').map((o) => OP_LABEL[o].toLowerCase());
  const base = `Makes ${out}${m.operations.includes('text-to-image') ? ' from a description' : ''}${ops.length ? `; also: ${ops.join(', ')}` : ''}.`;
  return m.note ? `${m.note.replace(/[.\s]+$/, '')}. ${base}` : base;
}

export interface PriceInfo { known: boolean; text: string }

/** Price wording. Only verified prices: the app's own estimator for Gemini/OpenAI, the docs' per-image price for Recraft, none for Higgsfield. */
export function priceInfo(m: StudioModel): PriceInfo {
  const p = studioProvider(m.providerId);
  if (p && !p.billable) return { known: true, text: 'Free' };
  const legacy = modelById(m.id);
  if (legacy) {
    try { const e = estimateCost({ modelId: legacy.id, prompt: 'x', referenceAssetIds: [], settings: {}, count: 1 }); return { known: true, text: `≈ ${formatUsd(e.perImage)} per image` }; } catch { /* fall through */ }
  }
  if (m.fromUsd !== undefined) return { known: true, text: `from ${formatUsd(m.fromUsd)} per image` };
  if (m.providerId === 'higgsfield') return { known: false, text: 'Price not published by Higgsfield' };
  return { known: false, text: 'Price not available' };
}

// ---- Tasks: "what do you want to do?" first, then the models that can do it ----
export interface Task {
  id: string;
  label: string;
  hint: string;
  filter: (m: StudioModel) => boolean;
}

export const TASKS: Task[] = [
  { id: 'image', label: 'Generate image', hint: 'A picture from a description.', filter: (m) => m.output === 'raster' && has(m, 'text-to-image') },
  { id: 'vector', label: 'Create vector art', hint: 'Real SVG you can edit in VectorCraft.', filter: (m) => m.output === 'svg' && has(m, 'text-to-image') },
  { id: 'vectorize', label: 'Picture to SVG', hint: 'Turn an existing picture into editable SVG.', filter: (m) => has(m, 'vectorize') },
  { id: 'animate', label: 'Animate image', hint: 'Bring a still picture to life.', filter: (m) => has(m, 'image-to-video') },
  { id: 'video', label: 'Generate video', hint: 'A clip from text or references.', filter: (m) => m.output === 'video' && has(m, 'text-to-video', 'reference-to-video') },
  { id: 'edit', label: 'Edit image', hint: 'Change part of a picture.', filter: (m) => has(m, 'edit', 'inpaint', 'outpaint', 'replace-background') },
  { id: 'extend', label: 'Extend video', hint: 'Continue a clip, or edit it with a prompt.', filter: (m) => has(m, 'video-extend', 'video-edit') },
  { id: 'upscale', label: 'Upscale', hint: 'More pixels, more detail.', filter: (m) => has(m, 'upscale', 'video-enhance') },
  { id: 'bg', label: 'Remove background', hint: 'Cut the subject out.', filter: (m) => has(m, 'remove-background') },
  { id: 'effects', label: 'Motion & effects', hint: 'Move a character with a reference video.', filter: (m) => has(m, 'motion-transfer') },
];

export const task = (id: string) => TASKS.find((t) => t.id === id);

/** Models for a task: ready-to-wire ones first, planned ones after (shown greyed, never selectable). */
export function modelsForTask(t: Task): { wired: StudioModel[]; planned: StudioModel[] } {
  const all = findModels({}).filter(t.filter);
  return { wired: all.filter((m) => m.availability === 'wired'), planned: all.filter((m) => m.availability !== 'wired') };
}

/** The task a model is best opened under (used when a model card says "Create with this model"). */
export function taskFor(m: StudioModel): Task {
  return TASKS.find((t) => t.filter(m)) ?? TASKS[0]!;
}

// ---- Comparison rows ----
export interface CompareRow { label: string; values: string[] }

export function compareRows(models: StudioModel[]): CompareRow[] {
  const prov = (m: StudioModel) => studioProvider(m.providerId);
  return [
    { label: 'Provider', values: models.map((m) => prov(m)?.label ?? m.providerId) },
    { label: 'Makes', values: models.map((m) => outputLabel(m.output)) },
    { label: 'Can do', values: models.map((m) => m.operations.map((o) => OP_LABEL[o]).join(', ')) },
    { label: 'Price', values: models.map((m) => priceInfo(m).text) },
    { label: 'Billing', values: models.map((m) => (prov(m)?.billable ? `Your own ${prov(m)!.label} account` : 'Nothing to pay')) },
    { label: 'Stopping a job', values: models.map((m) => prov(m)?.cancel ?? '') },
    { label: 'Status', values: models.map((m) => (m.availability === 'wired' ? 'Connected' : 'Documented, not connected yet')) },
  ];
}

// ---- Favourites (a per-viewer convenience, so it lives in the browser, never in the project) ----
export const favKey = (m: Pick<StudioModel, 'providerId' | 'id'>) => `${m.providerId}/${m.id}`;

export function parseFavs(raw: string | null): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length < 200).slice(0, 200) : []; } catch { return []; }
}

export const toggleFav = (favs: string[], key: string): string[] => (favs.includes(key) ? favs.filter((k) => k !== key) : [...favs, key]);

// ---- Explore filtering ----
export interface ExploreFilter {
  category: CategoryId | null;
  providerId: StudioProviderId | null;
  search: string;
  favoritesOnly: boolean;
  readyOnly: boolean;
}

export function exploreModels(f: ExploreFilter, favs: string[], ready: (m: StudioModel) => boolean): StudioModel[] {
  const cat = f.category ? CATEGORIES.find((c) => c.id === f.category) : null;
  return findModels({ ...(f.providerId ? { providerId: f.providerId } : {}), search: f.search })
    .filter((m) => (!cat || cat.match(m)) && (!f.favoritesOnly || favs.includes(favKey(m))) && (!f.readyOnly || ready(m)));
}

/** Seeded gradient for a card with no verified preview: stable per model, no invented imagery. */
export function artSeed(id: string): { a: number; b: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return { a: Math.abs(h) % 360, b: Math.abs(h >> 9) % 360 };
}

/** The settings a model offers, in short plain lines for the detail panel. Read from the same catalogs the forms use. */
export function settingsSummary(m: StudioModel): string[] {
  const hf = m.providerId === 'higgsfield' ? hfModel(m.id) : undefined;
  if (hf) {
    const lines = hf.params.map((p) => `${p.label}: ${p.type === 'bool' ? 'on or off' : p.options ? p.options.join(', ') : p.min !== undefined && p.max !== undefined ? `${p.min} to ${p.max}` : 'free text'}`);
    const ins = hf.inputs.map((i) => `${i.label}: ${i.many ? `up to ${i.max}` : '1'}${i.required ? ' (needed)' : ''}`);
    return [...ins, ...lines];
  }
  const legacy = modelById(m.id);
  if (legacy) return [...legacy.settings.map((s) => `${s.label}: ${s.options.map((o) => o.label).join(', ')}`), `Images per request: up to ${legacy.maxCount}`, ...(legacy.capabilities.includes('image-edit') ? ['Reference pictures: up to 4'] : [])];
  if (m.providerId === 'recraft' && m.availability === 'wired') return [`Shape: ${RECRAFT_ASPECTS.join(', ')}`, `Images per request: up to ${RECRAFT_MAX_COUNT}`, 'Preferred colours: up to 10', 'Background colour'];
  return [];
}

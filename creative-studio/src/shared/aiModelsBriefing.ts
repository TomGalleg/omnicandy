// What the AI makers in OmniCandy's AI Generate area can do, in plain lines for the directors who advise on or use them. Built from the real model lists (never
// invented), with which providers have a key saved right now, so a director never recommends something that cannot run. Pure: the caller says which keys exist.
import { IMAGE_MODELS, PROVIDERS, type ProviderId } from './generation';
import type { Asset } from './types';
import { VIDEO_MODELS } from './video';

export type ProviderReady = Partial<Record<ProviderId, boolean>>;

const label = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id;
const state = (id: string, ready: ProviderReady) => (id === 'mock' ? 'free, offline test pattern only' : ready[id as ProviderId] ? 'ready (key saved)' : 'needs a key in AI Generate > Providers');

/** Lines for a director's briefing. Empty-safe: with no keys it still lists what exists and says what is missing. */
export function aiModelsLines(ready: ProviderReady, director?: string): string[] {
  const images = IMAGE_MODELS.map((m) => `- ${m.label} (${label(m.provider)}; ${state(m.provider, ready)}): ${m.note}${m.capabilities.includes('image-edit') ? ' Can also edit from reference pictures.' : ''}`);
  const videos = VIDEO_MODELS.map((m) => `- ${m.label} (${label(m.provider)}; ${state(m.provider, ready)}): ${m.note}`);
  const anyReady = IMAGE_MODELS.some((m) => m.provider !== 'mock' && ready[m.provider]) || VIDEO_MODELS.some((m) => ready[m.provider as ProviderId]);
  return [
    'AI makers available in OmniCandy (AI Generate). Only recommend ones from this list. Say plainly which are ready and which need a key from the owner; anything that is not ready cannot run yet, and paid ones always show the owner a price first.',
    'Pictures:', ...images,
    'Video:', ...videos,
    director === 'ai-director'
      ? 'Everything that uses AI goes through you. Other directors come to you when their work needs a picture or video made with AI: pick the maker that fits, say what it will cost, and keep a tight limit on spending. You cannot be skipped: your access, spending limit and on/off switch decide all AI work.'
      : 'Anything that uses AI goes through the AI Director. Ask them which maker fits and what it costs before you plan on it; they approve, limit and record all AI work.',
    'Free on this computer: local video models can be downloaded (with a licence and size question first) and run offline, depending on the computer.',
    ...(anyReady ? [] : ['No paid AI maker has a key saved yet, so only the free test picture maker can run right now.']),
  ];
}

/** True for the directors whose job touches the AI makers. */
export const wantsAiModels = (director: string | undefined): boolean => director === 'ai-director' || director === 'creative-director';

export const MAX_PICTURES = 12;
/** The AI pictures in the library, newest first: what the AI Director shows the owner so they can talk about them. */
export function aiPictures(assets: readonly Asset[]): Asset[] {
  return assets.filter((a) => a.kind === 'image' && a.provenance.origin === 'generated')
    .sort((a, b) => Date.parse(b.provenance.createdAt) - Date.parse(a.provenance.createdAt)).slice(0, MAX_PICTURES);
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}...` : t);
/**
 * What a director is told about the picture the owner is looking at: how it was made, never how it looks. The chat cannot see pixels, so the director must say so
 * rather than describe a picture they have not seen.
 */
export function pictureContext(a: Asset): string {
  const p = a.provenance;
  const made = [p.model ? `made with ${p.model}` : 'made with AI', p.provider ? `(${label(p.provider)})` : '', p.createdAt ? `on ${p.createdAt.slice(0, 10)}` : ''].filter(Boolean).join(' ');
  const settings = p.settings && Object.keys(p.settings).length ? ` Settings: ${Object.entries(p.settings).map(([k, v]) => `${k} ${v}`).join(', ')}.` : '';
  const cost = typeof p.estimatedCostUsd === 'number' ? ` About $${p.estimatedCostUsd.toFixed(2)}.` : '';
  return [
    `The owner is looking at the AI picture "${a.name}", ${made}.`,
    p.prompt ? `The prompt was: "${clip(p.prompt, 600)}".` : 'The prompt was not recorded.',
    `${settings}${cost}`.trim(),
    'You can talk about how it was made and what to change in the prompt or settings. You cannot see the picture itself in this chat, so if asked what it looks like, say so and ask the owner to describe what they see.',
  ].filter(Boolean).join(' ');
}

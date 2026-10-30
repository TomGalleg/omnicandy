// What the AI makers in OmniCandy's AI Generate area can do, in plain lines for the directors who advise on or use them. Built from the real model lists (never
// invented), with which providers have a key saved right now, so a director never recommends something that cannot run. Pure: the caller says which keys exist.
import { IMAGE_MODELS, PROVIDERS, type ProviderId } from './generation';
import { VIDEO_MODELS } from './video';

export type ProviderReady = Partial<Record<ProviderId, boolean>>;

const label = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id;
const state = (id: string, ready: ProviderReady) => (id === 'mock' ? 'free, offline test pattern only' : ready[id as ProviderId] ? 'ready (key saved)' : 'needs a key in AI Generate > Providers');

/** Lines for a director's briefing. Empty-safe: with no keys it still lists what exists and says what is missing. */
export function aiModelsLines(ready: ProviderReady): string[] {
  const images = IMAGE_MODELS.map((m) => `- ${m.label} (${label(m.provider)}; ${state(m.provider, ready)}): ${m.note}${m.capabilities.includes('image-edit') ? ' Can also edit from reference pictures.' : ''}`);
  const videos = VIDEO_MODELS.map((m) => `- ${m.label} (${label(m.provider)}; ${state(m.provider, ready)}): ${m.note}`);
  const anyReady = IMAGE_MODELS.some((m) => m.provider !== 'mock' && ready[m.provider]) || VIDEO_MODELS.some((m) => ready[m.provider as ProviderId]);
  return [
    'AI makers available in OmniCandy (AI Generate). Only recommend ones from this list. Say plainly which are ready and which need a key from the owner; anything that is not ready cannot run yet, and paid ones always show the owner a price first.',
    'Pictures:', ...images,
    'Video:', ...videos,
    'Free on this computer: local video models can be downloaded (with a licence and size question first) and run offline, depending on the computer.',
    ...(anyReady ? [] : ['No paid AI maker has a key saved yet, so only the free test picture maker can run right now.']),
  ];
}

/** True for the directors whose job touches the AI makers. */
export const wantsAiModels = (director: string | undefined): boolean => director === 'ai-director' || director === 'creative-director';

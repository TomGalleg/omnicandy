// Quick AI: the small AI panel inside a connected app (PhotoCraft, FilmCraft, …). Pure (no React, no network).
// It uses the same registry, the same generation services and the same approval card as AI Studio: this file only decides
// WHICH actions a host offers, which library file an action works on, and what "Open in AI Studio" hands over.
// A new host app is one more entry in QUICK_HOSTS; nothing else changes.

import { hfModel, type HfParamValue, type HiggsfieldJob } from './higgsfield';
import { findModels, type StudioModel } from './providerCapabilities';
import { cardState } from './aiStudio';
import { modelsForTask, priceInfo, task as taskById, type Task } from './studioCatalog';
import { recraftToolByModelId, type RecraftToolJob } from './recraftTools';
import type { ImageJob } from './generation';
import type { RecraftJob } from './recraft';

export type QuickHostId = 'photocraft' | 'filmcraft';
type SourceKind = 'image' | 'video';

export interface QuickAsset { id: string; name: string; kind: string; sourceFormat: string }

/** What the host app is showing right now, as far as OmniCandy can read it. */
export interface QuickContext {
  /** The file open in the app. */
  open: QuickAsset | null;
  /** The file selected in the library. */
  selected: QuickAsset | null;
  /** FilmCraft: clips selected on the timeline (names only; a clip does not map to a library file). */
  selectedClips: string[];
}

export interface QuickAction {
  id: string;
  label: string;
  hint: string;
  /** AI Studio task whose models are offered (see studioCatalog TASKS). */
  taskId: string;
  /** A library file the action works on; null = needs none. */
  source: SourceKind | null;
  /** Prompt shown as a starting point. */
  starter?: string;
}

export interface QuickHost { id: QuickHostId; label: string; actions: QuickAction[]; /** What cannot be done in this app, and why. */ unavailable: string[] }

export const QUICK_HOSTS: Record<QuickHostId, QuickHost> = {
  photocraft: {
    id: 'photocraft', label: 'PhotoCraft',
    actions: [
      { id: 'generate', label: 'Generate artwork', hint: 'Make a new picture from a description.', taskId: 'image', source: null },
      { id: 'edit', label: 'Edit this image', hint: 'Describe a change; your original stays as it is.', taskId: 'edit', source: 'image' },
      { id: 'variations', label: 'Variations', hint: 'New takes on the open picture.', taskId: 'image', source: 'image', starter: 'A variation of this picture' },
      { id: 'cutout', label: 'Remove background', hint: 'Cut the subject out.', taskId: 'bg', source: 'image' },
      { id: 'upscale', label: 'Upscale', hint: 'More pixels, more detail.', taskId: 'upscale', source: 'image' },
      { id: 'animate', label: 'Animate', hint: 'Turn this picture into a short video.', taskId: 'animate', source: 'image' },
    ],
    unavailable: ['Inserting a result as a new layer: PhotoCraft opens results as their own document, because OmniCandy does not allow placing files into an open document yet.', 'Reading which layers are selected: Quick AI works on the picture that is open.'],
  },
  filmcraft: {
    id: 'filmcraft', label: 'FilmCraft',
    actions: [
      { id: 'video', label: 'Generate video', hint: 'A clip from a description.', taskId: 'video', source: null },
      { id: 'animate', label: 'Animate a still', hint: 'Bring a picture from your library to life.', taskId: 'animate', source: 'image' },
      { id: 'extend', label: 'Extend this clip', hint: 'Continue the open video, or edit it with a prompt.', taskId: 'extend', source: 'video' },
      { id: 'broll', label: 'Create B-roll', hint: 'Cutaway footage to go with your edit.', taskId: 'video', source: null, starter: 'B-roll: ' },
      { id: 'enhance', label: 'Enhance or upscale', hint: 'Sharpen or upscale the open video.', taskId: 'upscale', source: 'video' },
    ],
    unavailable: [],
  },
};

export const quickHost = (appId: string): QuickHost | undefined => (appId in QUICK_HOSTS ? QUICK_HOSTS[appId as QuickHostId] : undefined);

const kindOf = (a: QuickAsset): SourceKind | null => (a.kind === 'image' || a.kind === 'vector' ? 'image' : a.kind === 'video' ? 'video' : null);

/** The library file an action works on. A selected file wins over the open one; never a file of the wrong kind. */
export function pickSource(a: QuickAction, ctx: QuickContext): QuickAsset | null {
  if (!a.source) return null;
  for (const c of [ctx.selected, ctx.open]) if (c && kindOf(c) === a.source) return c;
  return null;
}

export interface ActionState {
  action: QuickAction;
  task: Task;
  source: QuickAsset | null;
  /** Connected models that do this task. */
  models: StudioModel[];
  /** Empty when the action can run; otherwise plain words saying what is missing. */
  blocked: string;
}

export function actionState(a: QuickAction, ctx: QuickContext): ActionState {
  const t = taskById(a.taskId)!;
  const source = pickSource(a, ctx);
  const models = modelsForTask(t).wired;
  let blocked = '';
  if (a.source && !source) blocked = a.source === 'image' ? 'Open or select a picture first.' : 'Open a video first.';
  else if (!models.length || !models.some((m) => modelTakesSource(m, source))) blocked = source ? `No connected model does this with ${kindOf(source) === 'video' ? 'a video' : 'a picture'} yet.` : 'No connected model does this yet.';
  return { action: a, task: t, source, models, blocked };
}

/** Whether a model can take the chosen source (a video-to-video model needs a video, and so on). Checked against the model's documented inputs. */
export function modelTakesSource(m: StudioModel, source: QuickAsset | null): boolean {
  if (!source) return true;
  const k = kindOf(source);
  if (m.providerId === 'higgsfield') {
    const h = hfModel(m.id);
    if (!h) return false;
    // The file must fit what the endpoint NEEDS (its required inputs, or any of the "at least one of" ones), not an optional extra.
    const needed = h.inputs.filter((i) => i.required || h.anyOf?.includes(i.key));
    return (needed.length ? needed : h.inputs).some((i) => i.kind === k);
  }
  if (recraftToolByModelId(m.id)) return k === 'image';
  return k === 'image'; // Gemini / OpenAI references and Recraft are picture-only
}

/** The choices to offer for an action: ready models first, each with its price wording. */
export function quickChoices(s: ActionState, configured: ReadonlySet<string>): Array<{ model: StudioModel; ready: boolean; price: string }> {
  return s.models.filter((m) => modelTakesSource(m, s.source))
    .map((m) => ({ model: m, ready: cardState(m, configured) === 'ready', price: priceInfo(m).text }))
    .sort((a, b) => Number(b.ready) - Number(a.ready));
}

/** Whether the model wants a prompt: the documented rule for Higgsfield and the tools, always for plain generators. */
export function promptRule(m: StudioModel): 'required' | 'optional' | 'none' {
  if (m.providerId === 'higgsfield') return hfModel(m.id)?.prompt ?? 'required';
  const t = recraftToolByModelId(m.id);
  if (t) return t.needsPrompt ? 'required' : 'none';
  return 'required';
}

// ---- Running an action with the same backend as AI Studio ----
export type QuickRun =
  | { kind: 'image'; job: ImageJob; label: string; providerId: string }
  | { kind: 'recraft'; job: RecraftJob; label: string }
  | { kind: 'tool'; job: RecraftToolJob; label: string }
  | { kind: 'higgsfield'; job: HiggsfieldJob; label: string };

/** Defaults for everything the quick panel does not ask about; the model's own defaults apply and the approval card shows the price. */
export function buildRun(m: StudioModel, prompt: string, source: QuickAsset | null, imageSettings: Record<string, string> = {}): QuickRun {
  const p = prompt.trim();
  if (m.providerId === 'higgsfield') {
    const h = hfModel(m.id);
    if (!h) throw new Error(`Unknown Higgsfield model "${m.id}".`);
    const inputs: Record<string, string[]> = {};
    if (source) {
      const k = kindOf(source);
      const slot = h.inputs.find((i) => i.kind === k && i.required) ?? h.inputs.find((i) => i.kind === k);
      if (slot) inputs[slot.key] = [source.id];
    }
    return { kind: 'higgsfield', job: { modelId: h.id, prompt: p, params: {} as Record<string, HfParamValue>, inputs }, label: h.label };
  }
  const tool = recraftToolByModelId(m.id);
  if (tool) {
    if (!source) throw new Error('Choose a picture first.');
    return { kind: 'tool', job: { toolId: tool.id, assetId: source.id, prompt: p, strength: 0.5, count: 1, shapeStacking: 'hierarchical' }, label: tool.label };
  }
  if (m.providerId === 'recraft') return { kind: 'recraft', job: { modelId: m.id, prompt: p, count: 1, aspect: 'auto', colors: [], background: '' }, label: m.label };
  return { kind: 'image', job: { modelId: m.id, prompt: p, referenceAssetIds: source ? [source.id] : [], settings: imageSettings, count: 1 }, label: m.label, providerId: m.providerId };
}

// ---- Hand-over to the full AI Studio ----
export interface QuickDraft {
  providerId: string;
  modelId: string;
  prompt: string;
  /** The library file the action works on. */
  referenceAssetId?: string;
  /** Which app the draft came from (shown in AI Studio). */
  from: QuickHostId;
  /** Higgsfield media inputs by key, so the full form opens with the same files. */
  hfInputs?: Record<string, string[]>;
}

export function buildDraft(host: QuickHostId, m: StudioModel, prompt: string, source: QuickAsset | null): QuickDraft {
  const run = m.providerId === 'higgsfield' ? buildRun(m, prompt, source) : null;
  return {
    providerId: m.providerId, modelId: m.id, prompt: prompt.trim(), from: host,
    ...(source ? { referenceAssetId: source.id } : {}),
    ...(run && run.kind === 'higgsfield' && Object.keys(run.job.inputs).length ? { hfInputs: run.job.inputs } : {}),
  };
}

/** Models that could do the action, whether or not they are ready (for "why is nothing offered"). */
export const allModelsFor = (a: QuickAction): StudioModel[] => { const t = taskById(a.taskId)!; return findModels({}).filter(t.filter); };

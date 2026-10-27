// AI Studio provider capability registry. Additive: it only DESCRIBES what each provider/model can
// do so the UI can offer exactly that and nothing more. It does not change how Gemini or OpenAI
// generate (those stay in generation.ts / main/generation.ts, and their entries here are derived
// from IMAGE_MODELS so the two can never drift).
//
// Only VERIFIED capabilities are listed. `source` says where each entry was verified; an operation
// that is not listed is not offered (never assume a model supports an operation).
// Verified against official docs on 2026-10-26:
//   Recraft    https://www.recraft.ai/docs/api-reference/{endpoints,models/recraft-v4-1,models/overview}.md
//   Higgsfield https://docs.higgsfield.ai/docs/{concepts/requests,authentication,quickstart}.md and
//              https://higgsfield.ai/creator-hub/help-center/integrations/{what-is-the-higgsfield-api,how-do-i-connect-higgsfield-to-ai-agent}

import { IMAGE_MODELS } from './generation';
import { HF_MODELS } from './higgsfield';
import { RECRAFT_TOOLS, toolModelId } from './recraftTools';

export type StudioProviderId = 'gemini' | 'openai' | 'higgsfield' | 'recraft' | 'local' | 'mock';

export type StudioOperation =
  | 'text-to-image' | 'image-to-image' | 'edit' | 'inpaint' | 'outpaint' | 'replace-background'
  | 'text-to-video' | 'image-to-video' | 'video-enhance' | 'video-edit' | 'video-extend' | 'reference-to-video' | 'motion-transfer'
  | 'upscale' | 'remove-background' | 'vectorize' | 'erase-region'
  | 'styles' | 'color-palette' | 'reference-images';

/** raster = pixels (PNG/WebP/JPEG); svg = genuine editable vector; video = clip. Never interchangeable. */
export type OutputKind = 'raster' | 'svg' | 'video';

/** wired = usable in the app today; planned = verified in the docs but not connected yet. */
export type Availability = 'wired' | 'planned';

export interface StudioModel {
  providerId: StudioProviderId;
  /** The id sent to the provider. */
  id: string;
  label: string;
  output: OutputKind;
  operations: StudioOperation[];
  availability: Availability;
  /** Official page this entry was verified from, or 'in-app' for models the app already ships. */
  source: string;
  /** USD per image/clip at the cheapest documented configuration, when the docs publish one. */
  fromUsd?: number;
  note?: string;
  /** One plain sentence for the model card, when the registry source has one. */
  blurb?: string;
}

export interface StudioProvider {
  id: StudioProviderId;
  label: string;
  kind: 'cloud-api' | 'cloud-mcp' | 'local';
  billable: boolean;
  availability: Availability;
  /** api-list: models can be listed with the key; docs-only: the registry is the catalog. */
  discovery: 'api-list' | 'docs-only' | 'none-yet';
  /** Whether a running job can be cancelled, in plain words. */
  cancel: string;
  /** How the app learns the cost before a paid request. */
  costInfo: string;
  note?: string;
  /** A plain-words line for the model panels about what is and is not connected for this provider. */
  connection?: string;
}

const RECRAFT_MODEL_DOC = 'https://www.recraft.ai/docs/api-reference/models/recraft-v4-1.md';
const RECRAFT_ENDPOINTS = 'https://www.recraft.ai/docs/api-reference/endpoints.md';

export const STUDIO_PROVIDERS: StudioProvider[] = [
  { id: 'gemini', label: 'Google Gemini', kind: 'cloud-api', billable: true, availability: 'wired', discovery: 'api-list', cancel: 'Synchronous call: stops by timeout only.', costInfo: "Estimated locally from Google's published per-image prices." },
  { id: 'openai', label: 'OpenAI GPT Image', kind: 'cloud-api', billable: true, availability: 'wired', discovery: 'api-list', cancel: 'Synchronous call: stops by timeout only.', costInfo: "Estimated locally from OpenAI's token calculator." },
  {
    id: 'higgsfield', label: 'Higgsfield', kind: 'cloud-api', billable: true, availability: 'wired', discovery: 'docs-only',
    cancel: 'Only while the request is still queued (cancel_url); once in_progress it cannot be stopped.',
    costInfo: 'Charged to your Higgsfield API balance. No price list or estimate endpoint is documented, so the price is shown as unknown. Failed, moderated and cancelled-while-queued requests are not charged.',
    connection: "Connected through Higgsfield's API with your API key (billed to your Higgsfield API balance). Higgsfield's separate account connection (MCP, signed in with your Higgsfield account and using subscription credits) is not connected: it needs a remote sign-in that OmniCandy's MCP client does not support, which would be a security decision of its own.",
    note: 'Official API: "Authorization: Key <id>:<secret>" at api.higgsfield.ai, async (queued, in_progress, completed, failed, nsfw, canceled). The Higgsfield MCP (mcp.higgsfield.ai/mcp) is a different product: it signs in with the Higgsfield account and spends subscription credits, not the API balance.',
  },
  {
    id: 'recraft', label: 'Recraft', kind: 'cloud-api', billable: true, availability: 'wired', discovery: 'docs-only',
    cancel: 'Synchronous call: stops by timeout only.',
    costInfo: 'Published per-image prices; every response reports the API units it cost.',
    note: 'Direct API at external.api.recraft.ai/v1 with a Bearer token; independent of Higgsfield. Wired: the V4.1 (Flash, standard, Pro), V3 and Vector text-to-image models and the picture tools (vectorize, cut out, upscale, V3 edit and new background); masked editing is not connected yet. Result URLs expire after about 24 hours, so files must be saved at once.',
  },
  { id: 'local', label: 'Local engines', kind: 'local', billable: false, availability: 'planned', discovery: 'none-yet', cancel: 'Stoppable by the app (own process).', costInfo: 'Free.', note: 'Reserved for future local engines.' },
  { id: 'mock', label: 'Mock (offline, free)', kind: 'local', billable: false, availability: 'wired', discovery: 'none-yet', cancel: 'Instant.', costInfo: 'Free.' },
];

/** The shipped models, derived from the existing catalog so they cannot drift. */
function shippedModels(): StudioModel[] {
  return IMAGE_MODELS.map((m) => ({
    providerId: m.provider as StudioProviderId,
    id: m.id, label: m.label, output: 'raster' as const,
    // The app uses reference pictures as inputs (image-edit); it sends no masks, so no inpaint.
    operations: ['text-to-image', ...(m.capabilities.includes('image-edit') ? ['image-to-image', 'reference-images'] : [])] as StudioOperation[],
    availability: 'wired' as const, source: 'in-app', note: m.note,
  }));
}

// What the app does with these models: pictures or SVG from a prompt, with a colour palette. Styles and reference pictures are
// documented for some of them but not connected, so they are not listed here.
const recraft = (id: string, label: string, output: OutputKind, fromUsd: number, note?: string, source = RECRAFT_MODEL_DOC): StudioModel => ({
  providerId: 'recraft', id, label, output, availability: 'wired', source, fromUsd,
  operations: ['text-to-image', 'color-palette'], ...(note ? { note } : {}),
});

const RECRAFT_MODELS: StudioModel[] = [
  recraft('recraftv4_1', 'Recraft V4.1', 'raster', 0.035, 'Default model, 1K.'),
  recraft('recraftv4_1_vector', 'Recraft V4.1 Vector', 'svg', 0.08, 'Genuine editable SVG.'),
  recraft('recraftv4_1_pro', 'Recraft V4.1 Pro', 'raster', 0.21, '2K, finer detail.'),
  recraft('recraftv4_1_pro_vector', 'Recraft V4.1 Pro Vector', 'svg', 0.30, 'Genuine editable SVG.'),
  recraft('recraftv4_1_flash', 'Recraft V4.1 Flash', 'raster', 0.007, 'Fastest and cheapest, 1K. No styles.', 'https://www.recraft.ai/docs/api-reference/models/recraft-v4-1-flash.md'),
  recraft('recraftv3', 'Recraft V3', 'raster', 0.04, 'The previous generation. Prompts up to 1,000 characters.', 'https://www.recraft.ai/docs/api-reference/models/recraft-v3.md'),
  recraft('recraftv3_vector', 'Recraft V3 Vector', 'svg', 0.08, 'Genuine editable SVG from V3. Prompts up to 1,000 characters.', 'https://www.recraft.ai/docs/api-reference/models/recraft-v3.md'),
  // Picture tools, wired from ./recraftTools (each read in full from its docs page). Masked editing is not connected: the app has no mask painter.
  ...RECRAFT_TOOLS.map((t): StudioModel => ({
    providerId: 'recraft', id: toolModelId(t.id), label: t.label, output: t.output, availability: 'wired', source: t.source, fromUsd: t.usd, blurb: t.blurb,
    operations: t.operation === 'edit' ? ['edit', 'image-to-image'] : [t.operation],
  })),
  {
    providerId: 'recraft', id: 'recraft-mask-tools', label: 'Recraft masked editing', output: 'raster', availability: 'planned',
    source: RECRAFT_ENDPOINTS, fromUsd: 0.002, operations: ['inpaint', 'outpaint', 'erase-region'],
    note: 'Inpaint, outpaint, erase region and generate background need a pixel-exact black and white mask. Not connected until OmniCandy has a mask painter.',
  },
];

// Higgsfield publishes no model-list endpoint, so the catalog in ./higgsfield (docs-verified entries only) is the source.
const HIGGSFIELD_MODELS: StudioModel[] = [
  ...HF_MODELS.map((m): StudioModel => ({
    providerId: 'higgsfield', id: m.id, label: m.label, output: m.output === 'video' ? 'video' : 'raster', operations: m.operations,
    availability: 'wired', source: m.source, blurb: m.blurb, ...(m.note ? { note: m.note } : {}),
  })),
];

export const STUDIO_MODELS: StudioModel[] = [...shippedModels(), ...RECRAFT_MODELS, ...HIGGSFIELD_MODELS];

export const studioProvider = (id: string) => STUDIO_PROVIDERS.find((p) => p.id === id);
export const studioModel = (providerId: string, modelId: string) => STUDIO_MODELS.find((m) => m.providerId === providerId && m.id === modelId);

export interface ModelFilter {
  providerId?: StudioProviderId;
  operation?: StudioOperation;
  output?: OutputKind;
  /** Only models that can be used today. */
  wiredOnly?: boolean;
  /** Free-text search over label, id and provider name (the Explore box). */
  search?: string;
}

export function findModels(f: ModelFilter = {}): StudioModel[] {
  const q = f.search?.trim().toLowerCase();
  return STUDIO_MODELS.filter((m) => {
    if (f.providerId && m.providerId !== f.providerId) return false;
    if (f.operation && !m.operations.includes(f.operation)) return false;
    if (f.output && m.output !== f.output) return false;
    if (f.wiredOnly && m.availability !== 'wired') return false;
    if (q && !`${m.label} ${m.id} ${studioProvider(m.providerId)?.label ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** True only when the registry lists the operation for exactly this model. Unknown model = false. */
export const supports = (providerId: string, modelId: string, op: StudioOperation) => !!studioModel(providerId, modelId)?.operations.includes(op);

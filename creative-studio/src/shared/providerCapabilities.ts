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

export type StudioProviderId = 'gemini' | 'openai' | 'higgsfield' | 'recraft' | 'local' | 'mock';

export type StudioOperation =
  | 'text-to-image' | 'image-to-image' | 'edit' | 'inpaint' | 'outpaint' | 'replace-background'
  | 'text-to-video' | 'image-to-video' | 'video-enhance'
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
}

const RECRAFT_MODEL_DOC = 'https://www.recraft.ai/docs/api-reference/models/recraft-v4-1.md';
const RECRAFT_ENDPOINTS = 'https://www.recraft.ai/docs/api-reference/endpoints.md';

export const STUDIO_PROVIDERS: StudioProvider[] = [
  { id: 'gemini', label: 'Google Gemini', kind: 'cloud-api', billable: true, availability: 'wired', discovery: 'api-list', cancel: 'Synchronous call: stops by timeout only.', costInfo: "Estimated locally from Google's published per-image prices." },
  { id: 'openai', label: 'OpenAI GPT Image', kind: 'cloud-api', billable: true, availability: 'wired', discovery: 'api-list', cancel: 'Synchronous call: stops by timeout only.', costInfo: "Estimated locally from OpenAI's token calculator." },
  {
    id: 'higgsfield', label: 'Higgsfield', kind: 'cloud-api', billable: true, availability: 'planned', discovery: 'docs-only',
    cancel: 'Only while the request is still queued (cancel_url); once in_progress it cannot be stopped.',
    costInfo: 'Fixed published rates per model (prepaid USD balance); failed requests are not charged. No estimate endpoint is documented.',
    note: 'Official API: "Authorization: Key <id>:<secret>" at api.higgsfield.ai, async (queued, in_progress, completed, failed, nsfw, canceled). The Higgsfield MCP (mcp.higgsfield.ai/mcp) is a different product: it signs in with the Higgsfield account and spends subscription credits, not the API balance.',
  },
  {
    id: 'recraft', label: 'Recraft', kind: 'cloud-api', billable: true, availability: 'planned', discovery: 'docs-only',
    cancel: 'Synchronous call: stops by timeout only.',
    costInfo: 'Published per-image prices; every response reports the API units it cost; GET /users/me returns the balance.',
    note: 'Direct API at external.api.recraft.ai/v1 with a Bearer token; independent of Higgsfield. Result URLs expire after about 24 hours, so files must be saved at once.',
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

const recraft = (id: string, label: string, output: OutputKind, fromUsd: number, note?: string): StudioModel => ({
  providerId: 'recraft', id, label, output, availability: 'planned', source: RECRAFT_MODEL_DOC, fromUsd,
  operations: ['text-to-image', 'image-to-image', 'styles', 'reference-images', 'color-palette'], ...(note ? { note } : {}),
});

const RECRAFT_MODELS: StudioModel[] = [
  recraft('recraftv4_1', 'Recraft V4.1', 'raster', 0.035, 'Default model, 1K.'),
  recraft('recraftv4_1_vector', 'Recraft V4.1 Vector', 'svg', 0.08, 'Genuine editable SVG.'),
  recraft('recraftv4_1_pro', 'Recraft V4.1 Pro', 'raster', 0.21, '2K, finer detail.'),
  recraft('recraftv4_1_pro_vector', 'Recraft V4.1 Pro Vector', 'svg', 0.30, 'Genuine editable SVG.'),
  {
    // Flash: documented as raster only and without styles or style references.
    providerId: 'recraft', id: 'recraftv4_1_flash', label: 'Recraft V4.1 Flash', output: 'raster', availability: 'planned',
    source: 'https://www.recraft.ai/docs/api-reference/getting-started.md', fromUsd: 0.007,
    operations: ['text-to-image', 'color-palette'], note: 'Fastest and cheapest. No styles.',
  },
  {
    // Inpaint, outpaint and background replacement are only documented for V3 (overview page).
    providerId: 'recraft', id: 'recraftv3', label: 'Recraft V3', output: 'raster', availability: 'planned',
    source: 'https://www.recraft.ai/docs/api-reference/models/overview.md', fromUsd: 0.04,
    operations: ['text-to-image', 'image-to-image', 'inpaint', 'outpaint', 'replace-background', 'styles'],
  },
  {
    // Model-independent tool endpoints (no model choice); prices from the endpoints page.
    providerId: 'recraft', id: 'recraft-tools', label: 'Recraft image tools', output: 'raster', availability: 'planned',
    source: RECRAFT_ENDPOINTS, fromUsd: 0.002,
    operations: ['remove-background', 'upscale', 'erase-region'], note: 'Crisp upscale $0.004, creative upscale $0.25, remove background $0.01, erase region $0.002.',
  },
  {
    providerId: 'recraft', id: 'recraft-vectorize', label: 'Recraft Vectorize', output: 'svg', availability: 'planned',
    source: RECRAFT_ENDPOINTS, fromUsd: 0.01, operations: ['vectorize'], note: 'Turns a raster picture into a genuine SVG.',
  },
];

// Higgsfield publishes no model-list endpoint, so only models whose page was read are registered.
// More are added as their docs are checked; a model missing here is simply not offered.
const HIGGSFIELD_MODELS: StudioModel[] = [
  {
    providerId: 'higgsfield', id: 'higgsfield-ai/soul/v2/standard', label: 'Higgsfield Soul 2 Standard', output: 'raster', availability: 'planned',
    source: 'https://docs.higgsfield.ai/docs/index.md', operations: ['text-to-image'],
    note: 'Example model from the official docs. Other models need their own docs page checked first.',
  },
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

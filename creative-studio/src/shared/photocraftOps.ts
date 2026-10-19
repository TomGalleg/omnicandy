// Which PhotoCraft engine commands OmniCandy may run, and how their params are checked.
// Shared so the UI offers exactly what main will accept; main enforces it before spawning anything.
//
// Policy, three tiers:
//   free      everything that edits the open document (adjustments, filters, layers, text, selections, painting, paths,
//             channels, transforms, layer styles): Claude does what a person does in the editor.
//   approval  anything that opens, saves, places or imports files, runs actions / scripts / plugins, or pulls pixels from
//             elsewhere. Claude may ask for it, but only runs it after the user approves a dialog (shown by main).
//   never     changing the app's own preferences, and anything not recognised.
// Free commands can never carry a path on disk in their parameters (checkValue below); PhotoCraft's own automation roots
// additionally refuse any file access outside the project, whatever is approved.

const FREE_PREFIXES = [
  'image.', 'filter.', 'layer.', 'type.', 'select.', 'paint.', 'path.', 'channel.', 'shape.', 'gradient.', 'swatches.',
  'edit.', 'layerComp.', 'count.', 'history.',
] as const;

/** Reach outside the document: allowed only with the user's approval. */
const APPROVAL_PREFIXES = [
  'file.', 'actions.', 'plugin.', 'layer.smartObjects.', 'layer.videoLayers.', 'layer.new.fromFile', 'image.analysis.',
] as const;
const APPROVAL_EXACT = new Set([
  'image.adjustments.matchColor', 'image.adjustments.colorLookup', 'image.adjustments.colorLookup.list',
  'layer.layerStyle.patternOverlay', 'edit.place', 'edit.paste', 'edit.pasteInto', 'edit.pasteSpecial', 'edit.definePattern',
  'edit.defineBrush', 'edit.exportPresets', 'edit.importPresets',
]);

/** Never, even with approval. */
const NEVER_PREFIXES = ['edit.preferences.'] as const;

export type CommandTier = 'free' | 'approval' | 'never';

export function commandTier(id: string): CommandTier {
  if (!/^[A-Za-z0-9]+(\.[A-Za-z0-9]+)+$/.test(id)) return 'never';
  if (NEVER_PREFIXES.some((p) => id.startsWith(p))) return 'never';
  if (APPROVAL_EXACT.has(id) || APPROVAL_PREFIXES.some((p) => id.startsWith(p))) return 'approval';
  return FREE_PREFIXES.some((p) => id.startsWith(p)) ? 'free' : 'never';
}

/** Free text the user wants printed on the picture, so it may contain slashes ("AND/OR"). */
const TEXT_KEYS = new Set(['text']);

const PATHLIKE_KEYS = new Set(['file', 'files', 'path', 'paths', 'folder', 'directory', 'dir', 'url', 'profile', 'source', 'document', 'script']);

export interface PhotoCraftPreset {
  id: string;
  label: string;
  params: Record<string, unknown>;
}

/** Friendly presets offered in the node inspector. Any allowed command id can still be typed. */
export const PHOTOCRAFT_PRESETS: PhotoCraftPreset[] = [
  { id: 'image.adjustments.hueSaturation', label: 'Hue / Saturation', params: { hue: 30, saturation: 15, lightness: 0 } },
  { id: 'image.adjustments.brightnessContrast', label: 'Brightness / Contrast', params: { brightness: 20, contrast: 15 } },
  { id: 'image.adjustments.exposure', label: 'Exposure', params: { exposure: 0.5 } },
  { id: 'image.adjustments.vibrance', label: 'Vibrance', params: { vibrance: 40, saturation: 0 } },
  { id: 'image.adjustments.levels', label: 'Levels', params: { inBlack: 10, gamma: 1.1, inWhite: 245 } },
  { id: 'image.adjustments.photoFilter', label: 'Photo filter (warming)', params: { filter: 'warming85' } },
  { id: 'image.adjustments.blackWhite', label: 'Black & White', params: {} },
  { id: 'image.adjustments.invert', label: 'Invert', params: {} },
  { id: 'image.adjustments.posterize', label: 'Posterize', params: { levels: 6 } },
  { id: 'image.autoTone', label: 'Auto Tone', params: {} },
  { id: 'filter.blur.gaussianBlur', label: 'Gaussian blur', params: { radius: 4 } },
  { id: 'filter.sharpen.unsharpMask', label: 'Unsharp mask', params: { amount: 80, radius: 1.5, threshold: 2 } },
  { id: 'filter.noise.addNoise', label: 'Add noise', params: { amount: 8, distribution: 'gaussian', monochromatic: true } },
  { id: 'filter.stylize.oilPaint', label: 'Oil paint', params: { stylization: 4, cleanliness: 5 } },
  { id: 'filter.pixelate.mosaic', label: 'Mosaic', params: { cellSize: 16 } },
  { id: 'image.imageRotation.flipCanvasHorizontal', label: 'Flip horizontal', params: {} },
  { id: 'image.imageRotation.90cw', label: 'Rotate 90° CW', params: {} },
];

export type OpCheck = { ok: true; params: Record<string, unknown> } | { ok: false; reason: string };

/** Runs without asking (workflows, the node inspector and quick edits only ever use these). */
export function isAllowedCommand(id: string): boolean { return commandTier(id) === 'free'; }

function checkValue(v: unknown, key: string, depth: number, allowPaths: boolean): string | null {
  if (depth > 4) return 'Parameters are nested too deeply.';
  if (!allowPaths && PATHLIKE_KEYS.has(key.toLowerCase())) return `Parameter "${key}" is not allowed (could reference a file).`;
  if (typeof v === 'string') {
    if (v.length > 200) return `Parameter "${key}" is too long.`;
    if (!allowPaths && !TEXT_KEYS.has(key.toLowerCase()) && /[\\/]|^[a-z]:|\.\./i.test(v)) return `Parameter "${key}" looks like a path, which is not allowed.`;
    return null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? null : `Parameter "${key}" must be a finite number.`;
  if (typeof v === 'boolean' || v === null) return null;
  if (Array.isArray(v)) {
    if (v.length > 256) return `Parameter "${key}" has too many items.`;
    for (const item of v) { const e = checkValue(item, key, depth + 1, allowPaths); if (e) return e; }
    return null;
  }
  if (typeof v === 'object') {
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) { const e = checkValue(item, k, depth + 1, allowPaths); if (e) return e; }
    return null;
  }
  return `Parameter "${key}" has an unsupported type.`;
}

/** Validates a command id and its params (as JSON text from the graph, or an object). */
export function checkPhotoCraftOp(command: string, params: string | Record<string, unknown> | undefined, opts: { approved?: boolean } = {}): OpCheck {
  const tier = commandTier(command);
  if (tier === 'never') return { ok: false, reason: `PhotoCraft command "${command}" is not allowed.` };
  if (tier === 'approval' && !opts.approved) return { ok: false, reason: `PhotoCraft command "${command}" needs the user's approval first.` };
  let parsed: unknown = params ?? {};
  if (typeof parsed === 'string') {
    if (parsed.length > 8000) return { ok: false, reason: 'Parameters are too large.' };
    try { parsed = parsed.trim() ? JSON.parse(parsed) : {}; } catch { return { ok: false, reason: 'Parameters are not valid JSON.' }; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'Parameters must be a JSON object.' };
  return checkParamValues(parsed as Record<string, unknown>, tier === 'approval');
}

/** Checks every parameter value (no paths unless the user approved a command that takes files). */
export function checkParamValues(params: Record<string, unknown>, allowPaths: boolean): OpCheck {
  for (const [k, v] of Object.entries(params)) {
    const e = checkValue(v, k, 0, allowPaths);
    if (e) return { ok: false, reason: e };
  }
  return { ok: true, params };
}

export function presetLabel(command: string): string {
  return PHOTOCRAFT_PRESETS.find((p) => p.id === command)?.label ?? command;
}

// Which PhotoCraft engine commands CreateCraft may run, and how their params are checked.
// Shared so the UI offers exactly what main will accept; main enforces it before spawning anything.
//
// Policy: only pixel adjustments, filters, rotations and fills on the open document. Nothing from
// File/Edit menus that opens, saves, places, runs scripts or touches other documents, and no
// parameter that could name a path on disk.

export const ALLOWED_PREFIXES = [
  'image.adjustments.',
  'image.imageRotation.',
  'image.rotation.',
  'image.autoTone',
  'image.autoContrast',
  'image.autoColor',
  'filter.blur.',
  'filter.sharpen.',
  'filter.noise.',
  'filter.stylize.',
  'filter.pixelate.',
  'filter.distort.',
  'filter.other.',
  'filter.render.',
] as const;

export const ALLOWED_EXACT = new Set(['edit.fill', 'layer.flattenImage']);

/** Allowed by prefix but reach outside the document (other docs, files, LUT files). */
export const BLOCKED = new Set([
  'image.adjustments.matchColor',
  'image.adjustments.colorLookup',
  'image.adjustments.colorLookup.list',
]);

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

export function isAllowedCommand(id: string): boolean {
  if (!/^[A-Za-z0-9]+(\.[A-Za-z0-9]+)+$/.test(id) || BLOCKED.has(id)) return false;
  return ALLOWED_EXACT.has(id) || ALLOWED_PREFIXES.some((p) => id.startsWith(p));
}

function checkValue(v: unknown, key: string, depth: number): string | null {
  if (depth > 4) return 'Parameters are nested too deeply.';
  if (PATHLIKE_KEYS.has(key.toLowerCase())) return `Parameter "${key}" is not allowed (could reference a file).`;
  if (typeof v === 'string') {
    if (v.length > 200) return `Parameter "${key}" is too long.`;
    if (/[\\/]|^[a-z]:|\.\./i.test(v)) return `Parameter "${key}" looks like a path, which is not allowed.`;
    return null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? null : `Parameter "${key}" must be a finite number.`;
  if (typeof v === 'boolean' || v === null) return null;
  if (Array.isArray(v)) {
    if (v.length > 256) return `Parameter "${key}" has too many items.`;
    for (const item of v) { const e = checkValue(item, key, depth + 1); if (e) return e; }
    return null;
  }
  if (typeof v === 'object') {
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) { const e = checkValue(item, k, depth + 1); if (e) return e; }
    return null;
  }
  return `Parameter "${key}" has an unsupported type.`;
}

/** Validates a command id and its params (as JSON text from the graph, or an object). */
export function checkPhotoCraftOp(command: string, params: string | Record<string, unknown> | undefined): OpCheck {
  if (!isAllowedCommand(command)) return { ok: false, reason: `PhotoCraft command "${command}" is not on the allowed list.` };
  let parsed: unknown = params ?? {};
  if (typeof parsed === 'string') {
    if (parsed.length > 8000) return { ok: false, reason: 'Parameters are too large.' };
    try { parsed = parsed.trim() ? JSON.parse(parsed) : {}; } catch { return { ok: false, reason: 'Parameters are not valid JSON.' }; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'Parameters must be a JSON object.' };
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const e = checkValue(v, k, 0);
    if (e) return { ok: false, reason: e };
  }
  return { ok: true, params: parsed as Record<string, unknown> };
}

export function presetLabel(command: string): string {
  return PHOTOCRAFT_PRESETS.find((p) => p.id === command)?.label ?? command;
}

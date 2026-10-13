// Which ArtCraft app edits which file type, and the quick edits each one offers.
// Every operation here was verified against the installed app's CLI (see docs/integration-audit.md);
// main re-validates every request against this table before anything runs.

export type EditorAppId = 'photocraft' | 'vectorcraft' | 'soundcraft' | 'filmcraft';

export interface NumberParam { key: string; label: string; type: 'number'; min: number; max: number; step: number; default: number; unit?: string }
export interface SelectParam { key: string; label: string; type: 'select'; options: Array<{ value: string; label: string }>; default: string }
export type ParamSpec = NumberParam | SelectParam;

export interface QuickEdit {
  id: string;
  label: string;
  params: ParamSpec[];
}

export interface EditorApp {
  id: EditorAppId;
  name: string;
  /** What the app is for, shown in the Edit tab. */
  blurb: string;
  formats: string[];
  quickEdits: QuickEdit[];
  /** How "Open in app" works for this app. */
  open: 'live' | 'working-copy' | 'none';
  note?: string;
}

const deg = (d = 90): NumberParam => ({ key: 'angle', label: 'Angle', type: 'number', min: -360, max: 360, step: 1, default: d, unit: '°' });

export const EDITOR_APPS: Record<EditorAppId, EditorApp> = {
  photocraft: {
    id: 'photocraft',
    name: 'PhotoCraft',
    blurb: 'Photo and raster editing',
    formats: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'gif', 'psd', 'pcraft'],
    open: 'live',
    quickEdits: [
      { id: 'brightnessContrast', label: 'Brightness / Contrast', params: [
        { key: 'brightness', label: 'Brightness', type: 'number', min: -150, max: 150, step: 1, default: 20 },
        { key: 'contrast', label: 'Contrast', type: 'number', min: -50, max: 100, step: 1, default: 15 }] },
      { id: 'hueSaturation', label: 'Hue / Saturation', params: [
        { key: 'hue', label: 'Hue', type: 'number', min: -180, max: 180, step: 1, default: 0 },
        { key: 'saturation', label: 'Saturation', type: 'number', min: -100, max: 100, step: 1, default: 25 },
        { key: 'lightness', label: 'Lightness', type: 'number', min: -100, max: 100, step: 1, default: 0 }] },
      { id: 'exposure', label: 'Exposure', params: [{ key: 'exposure', label: 'Exposure', type: 'number', min: -5, max: 5, step: 0.1, default: 0.5, unit: 'EV' }] },
      { id: 'warm', label: 'Warm / cool filter', params: [{ key: 'filter', label: 'Filter', type: 'select', default: 'warming85', options: [
        { value: 'warming85', label: 'Warm' }, { value: 'cooling80', label: 'Cool' }, { value: 'sepia', label: 'Sepia' }] }] },
      { id: 'blackWhite', label: 'Black & white', params: [] },
      { id: 'autoTone', label: 'Auto tone', params: [] },
      { id: 'sharpen', label: 'Sharpen', params: [{ key: 'amount', label: 'Amount', type: 'number', min: 1, max: 500, step: 1, default: 80, unit: '%' }] },
      { id: 'blur', label: 'Blur', params: [{ key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 100, step: 0.1, default: 3, unit: 'px' }] },
      { id: 'rotate', label: 'Rotate', params: [{ key: 'turn', label: 'Turn', type: 'select', default: '90cw', options: [
        { value: '90cw', label: '90° clockwise' }, { value: '90ccw', label: '90° counter-clockwise' }, { value: '180', label: '180°' }] }] },
      { id: 'flip', label: 'Flip horizontal', params: [] },
    ],
  },
  vectorcraft: {
    id: 'vectorcraft',
    name: 'VectorCraft',
    blurb: 'Vector illustration (SVG, AI, PDF, EPS)',
    formats: ['svg', 'svgz', 'vectorcraft', 'ai', 'eps', 'pdf'],
    open: 'working-copy',
    quickEdits: [
      { id: 'invertColors', label: 'Invert colours', params: [] },
      { id: 'rotate', label: 'Rotate artwork', params: [deg(15)] },
      { id: 'flip', label: 'Flip', params: [{ key: 'axis', label: 'Axis', type: 'select', default: 'vertical', options: [
        { value: 'vertical', label: 'Mirror left ↔ right' }, { value: 'horizontal', label: 'Mirror top ↕ bottom' }] }] },
      { id: 'scale', label: 'Scale artwork', params: [{ key: 'percent', label: 'Scale', type: 'number', min: 10, max: 400, step: 1, default: 80, unit: '%' }] },
      { id: 'fitArtboard', label: 'Fit artboard to art', params: [] },
    ],
  },
  soundcraft: {
    id: 'soundcraft',
    name: 'SoundCraft',
    blurb: 'Audio editing and mixing',
    formats: ['wav', 'mp3', 'flac', 'ogg', 'aif', 'aiff'],
    open: 'working-copy',
    quickEdits: [
      { id: 'normalize', label: 'Normalize', params: [] },
      { id: 'gain', label: 'Change volume', params: [{ key: 'db', label: 'Gain', type: 'number', min: -40, max: 20, step: 0.5, default: -6, unit: 'dB' }] },
      { id: 'fades', label: 'Fade in / out', params: [
        { key: 'fadeIn', label: 'Fade in', type: 'number', min: 0, max: 30, step: 0.1, default: 0.5, unit: 's' },
        { key: 'fadeOut', label: 'Fade out', type: 'number', min: 0, max: 30, step: 0.1, default: 0.5, unit: 's' },
        { key: 'shape', label: 'Shape', type: 'select', default: 's-curve', options: [
          { value: 's-curve', label: 'S-curve' }, { value: 'linear', label: 'Linear' }, { value: 'equal power', label: 'Equal power' }] }] },
      { id: 'resample', label: 'Change sample rate', params: [{ key: 'rate', label: 'Rate', type: 'select', default: '48000', options: [
        { value: '44100', label: '44.1 kHz' }, { value: '48000', label: '48 kHz' }, { value: '96000', label: '96 kHz' }] }] },
    ],
  },
  filmcraft: {
    id: 'filmcraft',
    name: 'FilmCraft',
    blurb: 'Video editing',
    formats: ['mp4', 'mov', 'webm', 'mkv', 'fcproj'],
    open: 'none',
    quickEdits: [],
    note: 'FilmCraft is installed and its automation connects, but there is no video in this project to verify edits against yet, so no quick edits are offered.',
  },
};

export function editorFor(format: string): EditorApp | null {
  const f = format.toLowerCase();
  return Object.values(EDITOR_APPS).find((a) => a.formats.includes(f)) ?? null;
}

export type EditValues = Record<string, number | string>;
export type ValuesCheck = { ok: true; values: EditValues } | { ok: false; reason: string };

/** Validates user-entered values against the op's parameter specs (ranges, options). */
export function checkEditValues(op: QuickEdit, raw: Record<string, unknown>): ValuesCheck {
  const values: EditValues = {};
  for (const p of op.params) {
    const v = raw[p.key] ?? p.default;
    if (p.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || n < p.min || n > p.max) return { ok: false, reason: `${p.label} must be between ${p.min} and ${p.max}.` };
      values[p.key] = n;
    } else {
      if (typeof v !== 'string' || !p.options.some((o) => o.value === v)) return { ok: false, reason: `${p.label} has an invalid choice.` };
      values[p.key] = v;
    }
  }
  const unknown = Object.keys(raw).filter((k) => !op.params.some((p) => p.key === k));
  if (unknown.length) return { ok: false, reason: `Unknown setting: ${unknown.join(', ')}.` };
  return { ok: true, values };
}

/** PhotoCraft engine command for a quick edit (all on the shared allowlist). */
export function photocraftCommand(opId: string, v: EditValues): { command: string; params: Record<string, unknown> } {
  switch (opId) {
    case 'brightnessContrast': return { command: 'image.adjustments.brightnessContrast', params: { brightness: v.brightness, contrast: v.contrast } };
    case 'hueSaturation': return { command: 'image.adjustments.hueSaturation', params: { hue: v.hue, saturation: v.saturation, lightness: v.lightness } };
    case 'exposure': return { command: 'image.adjustments.exposure', params: { exposure: v.exposure } };
    case 'warm': return { command: 'image.adjustments.photoFilter', params: { filter: v.filter } };
    case 'blackWhite': return { command: 'image.adjustments.blackWhite', params: {} };
    case 'autoTone': return { command: 'image.autoTone', params: {} };
    case 'sharpen': return { command: 'filter.sharpen.unsharpMask', params: { amount: v.amount, radius: 1.5, threshold: 2 } };
    case 'blur': return { command: 'filter.blur.gaussianBlur', params: { radius: v.radius } };
    case 'rotate': return { command: `image.imageRotation.${v.turn}`, params: {} };
    case 'flip': return { command: 'image.imageRotation.flipCanvasHorizontal', params: {} };
    default: throw new Error(`Unknown PhotoCraft edit "${opId}".`);
  }
}

/** VectorCraft command steps (run after select.all) for a quick edit. */
export function vectorcraftSteps(opId: string, v: EditValues): Array<{ cmd: string; params?: Record<string, unknown> }> {
  switch (opId) {
    case 'invertColors': return [{ cmd: 'select.all' }, { cmd: 'paint.invert', params: { stroke: false } }, { cmd: 'paint.invert', params: { stroke: true } }];
    case 'rotate': return [{ cmd: 'select.all' }, { cmd: 'object.rotate', params: { angle: v.angle } }];
    case 'flip': return [{ cmd: 'select.all' }, { cmd: 'object.reflect', params: { axis: v.axis } }];
    case 'scale': return [{ cmd: 'select.all' }, { cmd: 'object.scale', params: { sx: v.percent, sy: v.percent } }];
    case 'fitArtboard': return [{ cmd: 'artboard.fitToArt' }];
    default: throw new Error(`Unknown VectorCraft edit "${opId}".`);
  }
}

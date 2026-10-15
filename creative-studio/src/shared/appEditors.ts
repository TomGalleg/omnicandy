// Which ArtCraft app edits which file type, and the quick edits each one offers.
// Every operation here was verified against the installed app's CLI (see docs/integration-audit.md);
// main re-validates every request against this table before anything runs.

export type EditorAppId = 'photocraft' | 'vectorcraft' | 'soundcraft' | 'filmcraft' | 'lightcraft' | 'effectcraft' | 'designcraft' | 'wordcraft' | 'pdfcraft' | 'gridcraft' | 'deckcraft' | 'figcraft';

export interface NumberParam { key: string; label: string; type: 'number'; min: number; max: number; step: number; default: number; unit?: string }
export interface SelectParam { key: string; label: string; type: 'select'; options: Array<{ value: string; label: string }>; default: string }
export interface TextParam { key: string; label: string; type: 'text'; default: string; maxLength: number }
export type ParamSpec = NumberParam | SelectParam | TextParam;

export interface QuickEdit {
  id: string;
  label: string;
  params: ParamSpec[];
  /** Group shown in the Edit tab. */
  group?: string;
  /** Makes a new file from the library version instead of editing the open document. */
  copyOnly?: boolean;
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
  /**
   * Which CreateCraft tab is the app's home. The Edit tab picks 'edit' and 'audio' apps by file
   * type (so sounds open in SoundCraft there too); Color (LightCraft), Effects (EffectCraft) and
   * Audio (SoundCraft) open files in their own tabs.
   */
  tab: 'edit' | 'color' | 'effects' | 'audio';
  note?: string;
  /** File types this app opens by default in the Edit tab, even when an earlier app lists them too. */
  defaultFor?: string[];
}

/** LightCraft built-in develop presets (ids verified with presets.list in LightCraft 0.7.1). */
const LIGHTCRAFT_LOOKS = [
  { value: 'lc.golden-hour', label: 'Golden Hour' }, { value: 'lc.warm-glow', label: 'Warm Glow' }, { value: 'lc.cool-morning', label: 'Cool Morning' },
  { value: 'lc.teal-orange', label: 'Teal & Orange' }, { value: 'lc.vivid-pop', label: 'Vivid Pop' }, { value: 'lc.soft-pastel', label: 'Soft Pastel' },
  { value: 'lc.faded-matte', label: 'Faded Matte' }, { value: 'lc.warm-film', label: 'Warm Film' }, { value: 'lc.muted-film', label: 'Muted Film' },
  { value: 'lc.cinematic', label: 'Cinematic' }, { value: 'lc.moody', label: 'Moody' }, { value: 'lc.bw-high-contrast', label: 'High Contrast B&W' },
  { value: 'lc.bw-soft', label: 'Soft B&W' }, { value: 'lc.blue-hour', label: 'Blue Hour Boost' }, { value: 'lc.crisp-landscape', label: 'Crisp Landscape' },
];

const deg = (d = 90): NumberParam => ({ key: 'angle', label: 'Angle', type: 'number', min: -360, max: 360, step: 1, default: d, unit: '°' });

export const EDITOR_APPS: Record<EditorAppId, EditorApp> = {
  photocraft: {
    id: 'photocraft',
    tab: 'edit',
    name: 'PhotoCraft',
    blurb: 'Photo and raster editing',
    formats: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'gif', 'psd', 'pcraft'],
    open: 'live',
    quickEdits: [
      { id: 'brightnessContrast', group: 'Light', label: 'Brightness / Contrast', params: [
        { key: 'brightness', label: 'Brightness', type: 'number', min: -150, max: 150, step: 1, default: 20 },
        { key: 'contrast', label: 'Contrast', type: 'number', min: -50, max: 100, step: 1, default: 15 }] },
      { id: 'hueSaturation', group: 'Colour', label: 'Hue / Saturation', params: [
        { key: 'hue', label: 'Hue', type: 'number', min: -180, max: 180, step: 1, default: 0 },
        { key: 'saturation', label: 'Saturation', type: 'number', min: -100, max: 100, step: 1, default: 25 },
        { key: 'lightness', label: 'Lightness', type: 'number', min: -100, max: 100, step: 1, default: 0 }] },
      { id: 'exposure', group: 'Light', label: 'Exposure', params: [{ key: 'exposure', label: 'Exposure', type: 'number', min: -5, max: 5, step: 0.1, default: 0.5, unit: 'EV' }] },
      { id: 'warm', group: 'Colour', label: 'Warm / cool filter', params: [{ key: 'filter', label: 'Filter', type: 'select', default: 'warming85', options: [
        { value: 'warming85', label: 'Warm' }, { value: 'cooling80', label: 'Cool' }, { value: 'sepia', label: 'Sepia' }] }] },
      { id: 'blackWhite', group: 'Colour', label: 'Black & white', params: [] },
      { id: 'autoTone', group: 'Light', label: 'Auto tone', params: [] },
      { id: 'sharpen', group: 'Detail', label: 'Sharpen', params: [{ key: 'amount', label: 'Amount', type: 'number', min: 1, max: 500, step: 1, default: 80, unit: '%' }] },
      { id: 'blur', group: 'Detail', label: 'Blur', params: [{ key: 'radius', label: 'Radius', type: 'number', min: 0.1, max: 100, step: 0.1, default: 3, unit: 'px' }] },
      { id: 'rotate', label: 'Rotate', group: 'Turn & flip', params: [{ key: 'turn', label: 'Turn', type: 'select', default: '90cw', options: [
        { value: '90cw', label: '90° clockwise' }, { value: '90ccw', label: '90° counter-clockwise' }, { value: '180', label: '180°' }] }] },
      { id: 'flip', label: 'Flip horizontal', group: 'Turn & flip', params: [] },
    ],
  },
  vectorcraft: {
    id: 'vectorcraft',
    tab: 'edit',
    name: 'VectorCraft',
    blurb: 'Vector illustration (SVG, AI, PDF, EPS)',
    formats: ['svg', 'svgz', 'vectorcraft', 'ai', 'eps', 'pdf'],
    open: 'live',
    quickEdits: [
      { id: 'invertColors', group: 'Colour', label: 'Invert colours', params: [] },
      { id: 'rotate', label: 'Rotate artwork', group: 'Arrange', params: [deg(15)] },
      { id: 'flip', label: 'Flip', group: 'Arrange', params: [{ key: 'axis', label: 'Axis', type: 'select', default: 'vertical', options: [
        { value: 'vertical', label: 'Mirror left ↔ right' }, { value: 'horizontal', label: 'Mirror top ↕ bottom' }] }] },
      { id: 'scale', group: 'Arrange', label: 'Scale artwork', params: [{ key: 'percent', label: 'Scale', type: 'number', min: 10, max: 400, step: 1, default: 80, unit: '%' }] },
      { id: 'fitArtboard', group: 'Canvas', label: 'Fit artboard to art', params: [] },
    ],
  },
  soundcraft: {
    id: 'soundcraft',
    tab: 'audio',
    name: 'SoundCraft',
    blurb: 'Audio editing and mixing',
    formats: ['wav', 'mp3', 'flac', 'ogg', 'aif', 'aiff'],
    open: 'live',
    quickEdits: [
      { id: 'normalize', group: 'Make a copy', copyOnly: true, label: 'Normalize', params: [] },
      { id: 'gain', group: 'Volume', label: 'Change volume', params: [{ key: 'db', label: 'Gain', type: 'number', min: -40, max: 20, step: 0.5, default: -6, unit: 'dB' }] },
      { id: 'fades', group: 'Fades', label: 'Fade in / out', params: [
        { key: 'fadeIn', label: 'Fade in', type: 'number', min: 0, max: 30, step: 0.1, default: 0.5, unit: 's' },
        { key: 'fadeOut', label: 'Fade out', type: 'number', min: 0, max: 30, step: 0.1, default: 0.5, unit: 's' },
        { key: 'shape', label: 'Shape', type: 'select', default: 's-curve', options: [
          { value: 's-curve', label: 'S-curve' }, { value: 'linear', label: 'Linear' }, { value: 'equal power', label: 'Equal power' }] }] },
      { id: 'resample', group: 'Make a copy', copyOnly: true, label: 'Change sample rate', params: [{ key: 'rate', label: 'Rate', type: 'select', default: '48000', options: [
        { value: '44100', label: '44.1 kHz' }, { value: '48000', label: '48 kHz' }, { value: '96000', label: '96 kHz' }] }] },
    ],
  },
  filmcraft: {
    id: 'filmcraft',
    tab: 'edit',
    name: 'FilmCraft',
    blurb: 'Video editing',
    formats: ['mp4', 'mov', 'webm', 'mkv'],
    open: 'live',
    note: 'The video opens on a FilmCraft timeline. Saving exports an H.264 MP4 as a new version.',
    quickEdits: [
      { id: 'trim', group: 'Trim', label: 'Trim start / end', params: [
        { key: 'start', label: 'Cut from start', type: 'number', min: 0, max: 600, step: 0.1, default: 0.5, unit: 's' },
        { key: 'end', label: 'Cut from end', type: 'number', min: 0, max: 600, step: 0.1, default: 0.5, unit: 's' }] },
      { id: 'speed', group: 'Timing', label: 'Speed', params: [{ key: 'percent', label: 'Speed', type: 'number', min: 25, max: 400, step: 5, default: 150, unit: '%' }] },
      { id: 'volume', group: 'Sound', label: 'Clip sound volume', params: [{ key: 'db', label: 'Gain', type: 'number', min: -40, max: 20, step: 0.5, default: -6, unit: 'dB' }] },
      { id: 'musicVolume', group: 'Sound', label: 'Music volume', params: [{ key: 'db', label: 'Gain', type: 'number', min: -40, max: 20, step: 0.5, default: -10, unit: 'dB' }] },
      { id: 'crossfades', group: 'Fades', label: 'Crossfade between clips', params: [{ key: 'seconds', label: 'Length', type: 'number', min: 0.1, max: 3, step: 0.1, default: 0.5, unit: 's' }] },
      { id: 'fades', group: 'Fades', label: 'Fade in / out (picture and sound)', params: [
        { key: 'fadeIn', label: 'Fade in', type: 'number', min: 0, max: 10, step: 0.1, default: 0.5, unit: 's' },
        { key: 'fadeOut', label: 'Fade out', type: 'number', min: 0, max: 10, step: 0.1, default: 0.5, unit: 's' }] },
      { id: 'blackWhite', group: 'Look', label: 'Black & white', params: [] },
      { id: 'saturation', group: 'Look', label: 'Colour saturation', params: [{ key: 'saturation', label: 'Saturation', type: 'number', min: 0, max: 200, step: 1, default: 140 }] },
    ],
  },
  lightcraft: {
    id: 'lightcraft',
    tab: 'color',
    name: 'LightCraft',
    blurb: 'Photo colour and light (raw-style developing)',
    formats: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'],
    open: 'live',
    note: 'The photo opens in a throwaway LightCraft session, so your LightCraft library is not touched. Saving exports a full-size copy as a new version.',
    quickEdits: [
      { id: 'auto', group: 'Light', label: 'Auto settings', params: [] },
      { id: 'light', group: 'Light', label: 'Exposure & contrast', params: [
        { key: 'exposure', label: 'Exposure', type: 'number', min: -5, max: 5, step: 0.05, default: 0.3, unit: 'EV' },
        { key: 'contrast', label: 'Contrast', type: 'number', min: -100, max: 100, step: 1, default: 10 },
        { key: 'highlights', label: 'Highlights', type: 'number', min: -100, max: 100, step: 1, default: -20 },
        { key: 'shadows', label: 'Shadows', type: 'number', min: -100, max: 100, step: 1, default: 20 }] },
      { id: 'color', group: 'Colour', label: 'Vibrance & saturation', params: [
        { key: 'vibrance', label: 'Vibrance', type: 'number', min: -100, max: 100, step: 1, default: 25 },
        { key: 'saturation', label: 'Saturation', type: 'number', min: -100, max: 100, step: 1, default: 0 }] },
      { id: 'presence', group: 'Detail', label: 'Clarity & dehaze', params: [
        { key: 'clarity', label: 'Clarity', type: 'number', min: -100, max: 100, step: 1, default: 20 },
        { key: 'dehaze', label: 'Dehaze', type: 'number', min: -100, max: 100, step: 1, default: 10 }] },
      { id: 'vignette', group: 'Effects', label: 'Vignette', params: [{ key: 'amount', label: 'Amount', type: 'number', min: -100, max: 100, step: 1, default: -30 }] },
      { id: 'blackWhite', group: 'Colour', label: 'Black & white', params: [] },
      { id: 'look', group: 'Presets', label: 'Apply a look', params: [
        { key: 'preset', label: 'Look', type: 'select', default: 'lc.golden-hour', options: LIGHTCRAFT_LOOKS },
        { key: 'amount', label: 'Strength', type: 'number', min: 0, max: 200, step: 5, default: 100, unit: '%' }] },
      { id: 'reset', group: 'Light', label: 'Reset all edits', params: [] },
    ],
  },
  effectcraft: {
    id: 'effectcraft',
    tab: 'effects',
    name: 'EffectCraft',
    blurb: 'Motion graphics and visual effects',
    formats: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'webm'],
    open: 'live',
    note: 'The file opens as a composition in EffectCraft. Saving renders it (MP4 for video, PNG for pictures) as a new version.',
    quickEdits: [
      { id: 'glow', group: 'Light', label: 'Glow', params: [
        { key: 'radius', label: 'Radius', type: 'number', min: 0, max: 200, step: 1, default: 25, unit: 'px' },
        { key: 'intensity', label: 'Intensity', type: 'number', min: 0, max: 4, step: 0.1, default: 1 }] },
      { id: 'blur', group: 'Blur', label: 'Gaussian blur', params: [{ key: 'blurriness', label: 'Blurriness', type: 'number', min: 0, max: 100, step: 0.5, default: 8 }] },
      { id: 'brushStrokes', group: 'Stylize', label: 'Brush strokes', params: [
        { key: 'brushSize', label: 'Brush size', type: 'number', min: 0, max: 5, step: 0.1, default: 2 },
        { key: 'strokeLength', label: 'Stroke length', type: 'number', min: 0, max: 40, step: 1, default: 8 }] },
      { id: 'cartoon', group: 'Stylize', label: 'Cartoon', params: [] },
      { id: 'posterize', group: 'Stylize', label: 'Posterize', params: [{ key: 'level', label: 'Levels', type: 'number', min: 2, max: 32, step: 1, default: 6 }] },
      { id: 'title', group: 'Text', label: 'Add a title', params: [
        { key: 'text', label: 'Text', type: 'text', default: 'Title', maxLength: 120 },
        { key: 'size', label: 'Size', type: 'number', min: 10, max: 300, step: 1, default: 90, unit: 'px' },
        { key: 'color', label: 'Colour', type: 'select', default: '#ffffff', options: [
          { value: '#ffffff', label: 'White' }, { value: '#000000', label: 'Black' }, { value: '#ffd23f', label: 'Yellow' }] }] },
    ],
  },
  designcraft: {
    id: 'designcraft',
    tab: 'edit',
    name: 'DesignCraft',
    blurb: 'Page layout (flyers, posters, documents)',
    formats: ['designcraft'],
    open: 'live',
    quickEdits: [
      { id: 'replaceText', group: 'Text', label: 'Replace text', params: [
        { key: 'find', label: 'Find', type: 'text', default: 'Title', maxLength: 200 },
        { key: 'replace', label: 'Replace with', type: 'text', default: 'New title', maxLength: 200 }] },
      { id: 'addText', group: 'Text', label: 'Add a line of text', params: [
        { key: 'text', label: 'Text', type: 'text', default: 'Your text', maxLength: 200 },
        { key: 'position', label: 'Where', type: 'select', default: 'bottom', options: [
          { value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }] },
        { key: 'size', label: 'Size', type: 'number', min: 6, max: 144, step: 1, default: 24, unit: 'pt' },
        { key: 'color', label: 'Colour', type: 'select', default: '[Black]', options: [
          { value: '[Black]', label: 'Black' }, { value: '[Paper]', label: 'White' }] }] },
    ],
    note: "Edit the layout with DesignCraft's own tools, or use the text edits here. Saving keeps a new .designcraft version plus a PNG of the first page.",
  },
  wordcraft: {
    id: 'wordcraft',
    tab: 'edit',
    name: 'WordCraft',
    blurb: 'Word processing (letters, reports, documents)',
    formats: ['docx'],
    open: 'live',
    quickEdits: [
      { id: 'replaceText', group: 'Text', label: 'Replace text', params: [
        { key: 'find', label: 'Find', type: 'text', default: 'Title', maxLength: 200 },
        { key: 'replace', label: 'Replace with', type: 'text', default: 'New title', maxLength: 200 }] },
      { id: 'addParagraph', group: 'Text', label: 'Add a paragraph at the end', params: [
        { key: 'text', label: 'Text', type: 'text', default: 'Your text', maxLength: 2000 }] },
    ],
    note: "Write and format with WordCraft's own tools, or use the text edits here. Saving keeps a new .docx version plus a PNG of the first page.",
  },
  pdfcraft: {
    id: 'pdfcraft',
    tab: 'edit',
    name: 'PdfCraft',
    blurb: 'PDF viewing and editing (text, pages, marks)',
    formats: ['pdf'],
    defaultFor: ['pdf'],
    open: 'live',
    quickEdits: [
      { id: 'replaceText', group: 'Text', label: 'Replace text', params: [
        { key: 'find', label: 'Find', type: 'text', default: 'Title', maxLength: 200 },
        { key: 'replace', label: 'Replace with', type: 'text', default: 'New title', maxLength: 200 }] },
      { id: 'addText', group: 'Text', label: 'Add text to a page', params: [
        { key: 'text', label: 'Text', type: 'text', default: 'Your text', maxLength: 500 },
        { key: 'page', label: 'Page', type: 'number', min: 1, max: 10000, step: 1, default: 1 },
        { key: 'position', label: 'Place it at the', type: 'select', default: 'bottom', options: [
          { value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }] },
        { key: 'size', label: 'Size', type: 'number', min: 6, max: 96, step: 1, default: 14, unit: 'pt' }] },
      { id: 'rotatePages', group: 'Pages', label: 'Rotate pages', params: [
        { key: 'degrees', label: 'Turn', type: 'select', default: '90', options: [
          { value: '90', label: 'Clockwise 90°' }, { value: '180', label: '180°' }, { value: '270', label: 'Counter-clockwise 90°' }] },
        { key: 'pages', label: 'Pages (all, or 1,3-5)', type: 'text', default: 'all', maxLength: 60 }] },
      { id: 'deletePages', group: 'Pages', label: 'Delete pages', params: [
        { key: 'pages', label: 'Pages (for example 2,4-5)', type: 'text', default: '2', maxLength: 60 }] },
      { id: 'watermark', group: 'Marks', label: 'Add a text watermark', params: [
        { key: 'text', label: 'Text', type: 'text', default: 'DRAFT', maxLength: 60 },
        { key: 'opacity', label: 'Opacity', type: 'number', min: 5, max: 100, step: 5, default: 30, unit: '%' }] },
      { id: 'setTitle', group: 'Document', label: 'Set the document title', params: [
        { key: 'title', label: 'Title', type: 'text', default: 'Untitled', maxLength: 200 }] },
    ],
    note: "Edit text and pages with PdfCraft's own tools in the window, or use the quick edits here. Saving keeps a new .pdf version plus a PNG of the first page; the original is never changed.",
  },
  gridcraft: {
    id: 'gridcraft',
    tab: 'edit',
    name: 'GridCraft',
    blurb: 'Spreadsheets (tables, formulas, charts)',
    formats: ['xlsx'],
    open: 'live',
    quickEdits: [
      { id: 'setCell', group: 'Cells', label: 'Set a cell', params: [
        { key: 'cell', label: 'Cell (for example B2)', type: 'text', default: 'A1', maxLength: 12 },
        { key: 'value', label: 'Value or =formula', type: 'text', default: '0', maxLength: 500 }] },
      { id: 'sortColumn', group: 'Data', label: 'Sort a table by a column', params: [
        { key: 'range', label: 'Table range (for example A1:D20)', type: 'text', default: 'A1:D20', maxLength: 24 },
        { key: 'column', label: 'Column letter', type: 'text', default: 'B', maxLength: 3 },
        { key: 'order', label: 'Order', type: 'select', default: 'asc', options: [
          { value: 'asc', label: 'Smallest first' }, { value: 'desc', label: 'Largest first' }] }] },
    ],
    note: "Edit cells, formulas and charts with GridCraft's own tools, or use the quick edits here. Saving keeps a new .xlsx version (plus a picture of the window when GridCraft is open); the original is never changed.",
  },
  deckcraft: {
    id: 'deckcraft',
    tab: 'edit',
    name: 'DeckCraft',
    blurb: 'Presentations (slides, themes, transitions)',
    formats: ['deckcraft', 'pptx'],
    defaultFor: ['deckcraft', 'pptx'],
    open: 'live',
    quickEdits: [
      { id: 'replaceText', group: 'Text', label: 'Replace text on all slides', params: [
        { key: 'find', label: 'Find', type: 'text', default: 'Title', maxLength: 200 },
        { key: 'replace', label: 'Replace with', type: 'text', default: 'New title', maxLength: 200 }] },
      { id: 'addSlide', group: 'Slides', label: 'Add a slide at the end', params: [
        { key: 'title', label: 'Title', type: 'text', default: 'New slide', maxLength: 200 },
        { key: 'body', label: 'Text', type: 'text', default: 'Your text', maxLength: 1000 }] },
    ],
    note: "Design slides with DeckCraft's own tools, or use the quick edits here. Saving keeps a new .deckcraft version plus a PNG of the current slide; the original is never changed.",
  },
  figcraft: {
    id: 'figcraft',
    tab: 'edit',
    name: 'FigCraft',
    blurb: 'UI and UX design (frames, components, prototypes)',
    formats: ['figcraft'],
    open: 'live',
    quickEdits: [
      { id: 'replaceText', group: 'Text', label: 'Replace text in all layers', params: [
        { key: 'find', label: 'Find', type: 'text', default: 'Title', maxLength: 200 },
        { key: 'replace', label: 'Replace with', type: 'text', default: 'New title', maxLength: 200 }] },
      { id: 'addText', group: 'Text', label: 'Add a line of text', params: [
        { key: 'text', label: 'Text', type: 'text', default: 'Your text', maxLength: 200 },
        { key: 'position', label: 'Where', type: 'select', default: 'top', options: [
          { value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }] },
        { key: 'size', label: 'Size', type: 'number', min: 8, max: 200, step: 1, default: 16, unit: 'px' }] },
    ],
    note: "Design with FigCraft's own tools, or use the text edits here. Saving keeps a new .figcraft version plus a PNG of the page; the original is never changed.",
  },
};

/** The Edit tab's app for a file type (Color and Effects pick their app explicitly). */
export function editorFor(format: string): EditorApp | null {
  const f = format.toLowerCase();
  const preferred = Object.values(EDITOR_APPS).find((a) => a.defaultFor?.includes(f));
  if (preferred) return preferred;
  return Object.values(EDITOR_APPS).find((a) => (a.tab === 'edit' || a.tab === 'audio') && a.formats.includes(f)) ?? null;
}

/** The app a workspace tab uses for a file, or null when that tab can't open it. */
export function appForTab(tab: EditorApp['tab'], format: string): EditorApp | null {
  if (tab === 'edit') return editorFor(format);
  const f = format.toLowerCase();
  return Object.values(EDITOR_APPS).find((a) => a.tab === tab && a.formats.includes(f)) ?? null;
}

export type EditValues = Record<string, number | string>;
export type ValuesCheck = { ok: true; values: EditValues } | { ok: false; reason: string };

/** Validates user-entered values against the op's parameter specs (ranges, options). */
export function checkEditValues(op: QuickEdit, raw: Record<string, unknown>): ValuesCheck {
  const values: EditValues = {};
  for (const p of op.params) {
    const v = raw[p.key] ?? p.default;
    if (p.type === 'text') {
      // Control characters (newlines, escapes) become spaces.
      const t = typeof v === 'string' ? [...v].map((ch) => (ch < ' ' || ch === '\u007f' ? ' ' : ch)).join('').trim() : '';
      if (!t || t.length > p.maxLength) return { ok: false, reason: `${p.label} must be 1–${p.maxLength} characters.` };
      values[p.key] = t;
    } else if (p.type === 'number') {
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

// ---- Live step builders for FilmCraft, LightCraft and EffectCraft (each command verified live) ----

export interface Op { command: string; params: Record<string, unknown> }

/** What FilmCraft's sequence looks like, as far as the quick edits need it. */
export interface FilmSequence {
  fps: number;
  video: Array<{ clip: number; startFrame: number; durationFrames: number }>;
  audio: Array<{ clip: number; startFrame: number; durationFrames: number }>;
  /** Clips on the music tracks (A2 and later). */
  music?: Array<{ clip: number; startFrame: number; durationFrames: number }>;
}

/** FilmCraft engine commands for a quick edit. Targets the clips on the first video/audio track. */
export function filmcraftSteps(opId: string, v: EditValues, seq: FilmSequence): Op[] {
  const vids = seq.video.map((c) => c.clip);
  const auds = seq.audio.map((c) => c.clip);
  const all = [...vids, ...auds];
  if (!all.length) throw new Error('The FilmCraft timeline has no clips.');
  const frames = (s: number) => Math.round(s * seq.fps);
  const main = seq.video.length ? seq.video : seq.audio;
  switch (opId) {
    case 'trim': {
      const cutIn = frames(Number(v.start)), cutOut = frames(Number(v.end));
      const total = main.reduce((n, c) => n + c.durationFrames, 0);
      if (cutIn + cutOut >= total - 1) throw new Error('That would cut away the whole clip.');
      const steps: Op[] = [];
      if (cutOut > 0) steps.push({ command: 'timeline.trim', params: { clip: main.at(-1)!.clip, edge: 'out', mode: 'ripple', deltaFrames: -cutOut } });
      if (cutIn > 0) steps.push({ command: 'timeline.trim', params: { clip: main[0]!.clip, edge: 'in', mode: 'ripple', deltaFrames: cutIn } });
      if (!steps.length) throw new Error('Set how much to cut.');
      return steps;
    }
    case 'speed': return [{ command: 'clip.speedDuration', params: { clips: all, speed: v.percent, ripple: true } }];
    case 'volume':
      if (!auds.length) throw new Error('This video has no sound.');
      return [{ command: 'clip.audioGain', params: { clips: auds, mode: 'adjust', db: v.db } }];
    case 'musicVolume': {
      const music = (seq.music ?? []).map((c) => c.clip);
      if (!music.length) throw new Error('There is no music on the timeline. Add some first.');
      return [{ command: 'clip.audioGain', params: { clips: music, mode: 'adjust', db: v.db } }];
    }
    case 'crossfades': {
      // A dissolve (picture) and a constant-power fade (sound) at every cut between clips that touch.
      const len = frames(Number(v.seconds));
      const cuts = (cs: FilmSequence['video']) => cs.slice(1).filter((c, i) => Math.abs(cs[i]!.startFrame + cs[i]!.durationFrames - c.startFrame) <= 1);
      const steps: Op[] = [
        ...cuts(seq.video).map((c) => ({ command: 'sequence.applyVideoTransition', params: { clip: c.clip, effect: 'cross_dissolve', edge: 'in', frames: len } })),
        ...cuts(seq.audio).map((c) => ({ command: 'sequence.applyAudioTransition', params: { clip: c.clip, effect: 'constant_power', edge: 'in', frames: len } })),
      ];
      if (!steps.length) throw new Error('There is only one clip, so there is nothing to crossfade. Add another clip first.');
      return steps;
    }
    case 'fades': {
      const fin = frames(Number(v.fadeIn)), fout = frames(Number(v.fadeOut));
      const steps: Op[] = [];
      const vFirst = seq.video[0], vLast = seq.video.at(-1), aFirst = seq.audio[0], aLast = seq.audio.at(-1);
      if (fin > 0 && vFirst) steps.push({ command: 'sequence.applyVideoTransition', params: { clip: vFirst.clip, effect: 'dip_to_black', edge: 'in', frames: fin } });
      if (fout > 0 && vLast) steps.push({ command: 'sequence.applyVideoTransition', params: { clip: vLast.clip, effect: 'dip_to_black', edge: 'out', frames: fout } });
      if (fin > 0 && aFirst) steps.push({ command: 'sequence.applyAudioTransition', params: { clip: aFirst.clip, effect: 'constant_power', edge: 'in', frames: fin } });
      if (fout > 0 && aLast) steps.push({ command: 'sequence.applyAudioTransition', params: { clip: aLast.clip, effect: 'constant_power', edge: 'out', frames: fout } });
      // Music fades with the picture.
      const m = seq.music ?? [];
      if (fin > 0 && m[0]) steps.push({ command: 'sequence.applyAudioTransition', params: { clip: m[0].clip, effect: 'constant_power', edge: 'in', frames: fin } });
      if (fout > 0 && m.length) steps.push({ command: 'sequence.applyAudioTransition', params: { clip: m.at(-1)!.clip, effect: 'constant_power', edge: 'out', frames: fout } });
      if (!steps.length) throw new Error('Set a fade-in or fade-out length.');
      return steps;
    }
    case 'blackWhite':
      if (!vids.length) throw new Error('This file has no picture.');
      return [{ command: 'effects.apply', params: { clips: vids, effect: 'black_white' } }];
    case 'saturation':
      if (!vids.length) throw new Error('This file has no picture.');
      return [
        { command: 'effects.apply', params: { clips: vids, effect: 'lumetri' } },
        ...vids.map((clip) => ({ command: 'effects.setParam', params: { clip, effect: 'lumetri', param: 'saturation', value: v.saturation } })),
      ];
    default: throw new Error(`Unknown FilmCraft edit "${opId}".`);
  }
}

/** A DesignCraft page as far as the quick edits need it (points). */
export interface DesignPage { bounds: [number, number, number, number]; margins: { top: number; bottom: number; inside: number; outside: number } }

/**
 * DesignCraft commands for a quick edit. `createcraft.addText` is CreateCraft's own two-step
 * operation (frame.create, then find.change with attrs on the new story), run by LiveDesignCraft.
 */
export function designcraftSteps(opId: string, v: EditValues, page: DesignPage): Op[] {
  switch (opId) {
    case 'replaceText': return [{ command: 'find.change', params: { find: v.find, change: v.replace } }];
    case 'addText': {
      const [x0, y0, x1, y1] = page.bounds;
      const m = page.margins;
      const size = Number(v.size);
      const h = Math.ceil(size * 1.5 + 8);
      const top = v.position === 'top' ? y0 + m.top : v.position === 'middle' ? Math.round((y0 + y1 - h) / 2) : y1 - m.bottom - h;
      const left = x0 + Math.min(m.inside, m.outside), right = x1 - Math.min(m.inside, m.outside);
      return [{ command: 'createcraft.addText', params: { rect: [left, top, right, top + h], text: v.text, size, fill: v.color } }];
    }
    default: throw new Error(`Unknown DesignCraft edit "${opId}".`);
  }
}

/** LightCraft commands for a quick edit (develop controls by id; see `lightcraft-cli controls`). */
export function lightcraftSteps(opId: string, v: EditValues): Op[] {
  switch (opId) {
    case 'auto': return [{ command: 'develop.auto', params: {} }];
    case 'light': return [{ command: 'develop.set', params: { values: { 'light.exposure': v.exposure, 'light.contrast': v.contrast, 'light.highlights': v.highlights, 'light.shadows': v.shadows } } }];
    case 'color': return [{ command: 'develop.set', params: { values: { 'color.vibrance': v.vibrance, 'color.saturation': v.saturation } } }];
    case 'presence': return [{ command: 'develop.set', params: { values: { 'effects.clarity': v.clarity, 'effects.dehaze': v.dehaze } } }];
    case 'vignette': return [{ command: 'develop.set', params: { values: { 'vignette.amount': v.amount } } }];
    case 'blackWhite': return [{ command: 'develop.treatment', params: { bw: true } }];
    case 'look': return [{ command: 'preset.apply', params: { id: v.preset, amount: v.amount } }];
    case 'reset': return [{ command: 'develop.reset', params: {} }];
    default: throw new Error(`Unknown LightCraft edit "${opId}".`);
  }
}

/** WordCraft commands for a quick edit (verified headless and live). */
export function wordcraftSteps(opId: string, v: EditValues): Op[] {
  switch (opId) {
    case 'replaceText': return [{ command: 'edit.replaceAll', params: { text: v.find, with: v.replace, matchCase: true } }];
    case 'addParagraph': return [
      { command: 'caret.docEnd', params: {} },
      { command: 'text.newParagraph', params: {} },
      { command: 'text.insert', params: { text: v.text } },
    ];
    default: throw new Error(`Unknown WordCraft edit "${opId}".`);
  }
}

/** A page list such as "all", "2" or "1,3-5" as numbers (empty = every page); throws on anything else. */
export function parsePageList(text: string, pageCount?: number): number[] {
  const t = text.trim().toLowerCase();
  if (t === 'all' || t === '') return [];
  if (!/^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/.test(t)) throw new Error('Pages must be "all" or a list like 2,4-5.');
  const out = new Set<number>();
  for (const part of t.split(',')) {
    const [a, b] = part.split('-').map((x) => parseInt(x.trim(), 10)) as [number, number | undefined];
    const end = b ?? a;
    if (a < 1 || end < a || end - a > 10000) throw new Error('Pages must be "all" or a list like 2,4-5.');
    for (let p = a; p <= end; p++) out.add(p);
  }
  const list = [...out].sort((x, y) => x - y);
  if (pageCount && list.some((p) => p > pageCount)) throw new Error(`The document has only ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
  return list;
}

/**
 * PdfCraft operations for a quick edit. `pdf.*` commands are handled by the driver (they need to read
 * the document first); `tool:` commands are PdfCraft automation tools, sent with the open document's id.
 */
export function pdfcraftSteps(opId: string, v: EditValues): Op[] {
  switch (opId) {
    case 'replaceText': return [{ command: 'pdf.replaceText', params: { find: v.find, replace: v.replace } }];
    case 'addText': return [{ command: 'pdf.addText', params: { text: v.text, page: v.page, position: v.position, size: v.size } }];
    case 'rotatePages': {
      const pages = parsePageList(String(v.pages));
      return [{ command: 'tool:page_rotate', params: { degrees: Number(v.degrees), ...(pages.length ? { pages } : {}) } }];
    }
    case 'deletePages': {
      const pages = parsePageList(String(v.pages));
      if (!pages.length) throw new Error('Name the pages to delete (a document needs at least one page left).');
      return [{ command: 'tool:page_delete', params: { pages } }];
    }
    case 'watermark': return [{ command: 'tool:doc_watermark', params: { text: v.text, opacity: Number(v.opacity) / 100 } }];
    case 'setTitle': return [{ command: 'tool:doc_set_info', params: { key: 'Title', value: v.title } }];
    default: throw new Error(`Unknown PdfCraft edit "${opId}".`);
  }
}

/**
 * DeckCraft operations for a quick edit. The `createcraft.*` ones are CreateCraft's own multi-call
 * operations run by LiveDeckCraft (DeckCraft has no find-and-replace command, so text is replaced
 * shape by shape with its set_text tool).
 */
export function deckcraftSteps(opId: string, v: EditValues): Op[] {
  switch (opId) {
    case 'replaceText': return [{ command: 'createcraft.replaceText', params: { find: v.find, replace: v.replace } }];
    case 'addSlide': return [{ command: 'createcraft.addSlide', params: { title: v.title, body: v.body } }];
    default: throw new Error(`Unknown DeckCraft edit "${opId}".`);
  }
}

/**
 * FigCraft operations for a quick edit. Both are CreateCraft multi-call operations run by LiveFigCraft:
 * text layers are found with inspect_document and changed with set_properties; new text goes into the
 * first frame of the current page.
 */
export function figcraftSteps(opId: string, v: EditValues): Op[] {
  switch (opId) {
    case 'replaceText': return [{ command: 'createcraft.replaceText', params: { find: v.find, replace: v.replace } }];
    case 'addText': return [{ command: 'createcraft.addText', params: { text: v.text, position: v.position, size: v.size } }];
    default: throw new Error(`Unknown FigCraft edit "${opId}".`);
  }
}

const CELL = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/;
const RANGE = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$/;
/** GridCraft commands for a quick edit (verified headless and live). Cell references are checked here. */
export function gridcraftSteps(opId: string, v: EditValues): Op[] {
  switch (opId) {
    case 'setCell': {
      const cell = String(v.cell).trim().toUpperCase();
      if (!CELL.test(cell)) throw new Error(`"${String(v.cell)}" is not a cell reference like B2.`);
      return [{ command: 'cell.set', params: { cell, input: String(v.value) } }];
    }
    case 'sortColumn': {
      const range = String(v.range).trim().toUpperCase();
      const column = String(v.column).trim().toUpperCase();
      if (!RANGE.test(range)) throw new Error(`"${String(v.range)}" is not a range like A1:D20.`);
      if (!/^[A-Z]{1,3}$/.test(column)) throw new Error(`"${String(v.column)}" is not a column letter.`);
      return [{ command: 'data.sort', params: { range, header: true, keys: [{ column, order: v.order === 'desc' ? 'desc' : 'asc' }] } }];
    }
    default: throw new Error(`Unknown GridCraft edit "${opId}".`);
  }
}

/** EffectCraft operations for a quick edit. `tool:` commands are MCP tools; the rest are engine commands. */
export function effectcraftSteps(opId: string, v: EditValues, ctx: { layer: number }): Op[] {
  const fx = (effect: string, values: Record<string, unknown> = {}): Op => ({ command: 'tool:add_effect', params: { layer: ctx.layer, effect, values } });
  switch (opId) {
    case 'glow': return [fx('Glow', { radius: v.radius, intensity: v.intensity })];
    case 'blur': return [fx('Gaussian Blur', { blurriness: v.blurriness })];
    case 'brushStrokes': return [fx('Brush Strokes', { brushSize: v.brushSize, strokeLength: v.strokeLength })];
    case 'cartoon': return [fx('Cartoon')];
    case 'posterize': return [fx('Posterize', { level: v.level })];
    case 'title': return [{ command: 'layer.newText', params: { text: v.text, size: v.size, fill: v.color } }];
    default: throw new Error(`Unknown EffectCraft edit "${opId}".`);
  }
}

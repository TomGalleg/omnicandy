// Built-in creative templates (Phase 8). Each one is a real workflow for the existing engine, built
// through the same planner checks as Claude's workflows (apps, edits, presets, models are validated).
// A template carries no file choices; picking files, approval and any paid price check stay with the user.
import type { ProjectKind } from './projectPlan';
import { buildWorkflowPlan, type PlanInput } from './workflowPlan';
import { templateGraph, type WorkflowTemplate } from './workflowControl';

/** ready: only local ArtCraft steps (verified headless). paid: has an AI image step that asks before it bills. partial: works, with a stated limit. */
export type TemplateStatus = 'ready' | 'paid' | 'partial';

interface Def {
  id: string;
  name: string;
  description: string;
  kind: ProjectKind;
  status: TemplateStatus;
  /** Plain-language "what you need" and honest limits. */
  needs: string;
  input: PlanInput;
}

const imp = (file = 'your pictures'): PlanInput['steps'][number] => ({ key: 'files', type: 'import', files: [file] });
const chain = (...keys: string[]): PlanInput['connections'] => keys.slice(1).map((k, i) => ({ from: keys[i]!, to: k }));

const DEFS: Def[] = [
  {
    id: 'builtin-cinematic-poster', name: 'Cinematic poster', kind: 'design', status: 'ready',
    description: 'Gives a photo a cinematic look, adds a title, then waits for your approval and exports a web and a print-size picture.',
    needs: 'A photo in the library. Local apps only (LightCraft, EffectCraft); nothing paid.',
    input: { title: 'Cinematic poster', explanation: 'Look, title, approval, export.', steps: [
      imp(),
      { key: 'look', type: 'artcraftEdit', app: 'lightcraft', edit: 'look', edit_settings: { preset: 'lc.golden-hour', amount: 100 } },
      { key: 'vignette', type: 'artcraftEdit', app: 'lightcraft', edit: 'vignette', edit_settings: { amount: -35 } },
      { key: 'title', type: 'artcraftEdit', app: 'effectcraft', edit: 'title', edit_settings: { text: 'Your title', size: 120, color: '#ffffff' } },
      { key: 'ok', type: 'approval', note: 'Check the title and look before exporting.' },
      { key: 'out', type: 'export', presets: ['image-web', 'image-tiff'] },
    ], connections: chain('files', 'look', 'vignette', 'title', 'ok', 'out') },
  },
  {
    id: 'builtin-photo-restoration', name: 'Photo restoration', kind: 'image', status: 'partial',
    description: 'Evens out tone, lifts shadows, clears haze and sharpens an old photo, then asks you to approve.',
    needs: 'A scanned or old photo. Tone, contrast and sharpness only: it does not repair scratches, tears or missing areas (no such tool is connected).',
    input: { title: 'Photo restoration', explanation: 'Tone, clarity, sharpen, approve, export.', steps: [
      imp(),
      { key: 'auto', type: 'artcraftEdit', app: 'lightcraft', edit: 'auto' },
      { key: 'light', type: 'artcraftEdit', app: 'lightcraft', edit: 'light', edit_settings: { exposure: 0.2, contrast: 15, highlights: -25, shadows: 30 } },
      { key: 'clarity', type: 'artcraftEdit', app: 'lightcraft', edit: 'presence', edit_settings: { clarity: 25, dehaze: 20 } },
      { key: 'sharp', type: 'artcraftEdit', app: 'photocraft', edit: 'sharpen', edit_settings: { amount: 60 } },
      { key: 'ok', type: 'approval', note: 'Compare with the original; originals are never changed.' },
      { key: 'out', type: 'export', presets: ['image-png'] },
    ], connections: chain('files', 'auto', 'light', 'clarity', 'sharp', 'ok', 'out') },
  },
  {
    id: 'builtin-image-enhancement', name: 'Image enhancement', kind: 'image', status: 'ready',
    description: 'Auto settings, vibrance and gentle sharpening for a batch of photos, with your approval before export.',
    needs: 'One or many photos. Local apps only; nothing paid.',
    input: { title: 'Image enhancement', explanation: 'Auto, colour, sharpen, approve, export.', steps: [
      imp(),
      { key: 'auto', type: 'artcraftEdit', app: 'lightcraft', edit: 'auto' },
      { key: 'color', type: 'artcraftEdit', app: 'lightcraft', edit: 'color', edit_settings: { vibrance: 25, saturation: 5 } },
      { key: 'sharp', type: 'artcraftEdit', app: 'photocraft', edit: 'sharpen', edit_settings: { amount: 50 } },
      { key: 'ok', type: 'approval', note: 'Approve the photos you want to keep.' },
      { key: 'out', type: 'export', presets: ['image-jpg', 'image-web'] },
    ], connections: chain('files', 'auto', 'color', 'sharp', 'ok', 'out') },
  },
  {
    id: 'builtin-ai-image-variations', name: 'AI image variations', kind: 'image', status: 'paid',
    description: 'Makes three AI variations of a picture, lets you approve the ones you like, then exports them.',
    needs: 'A saved Gemini key. Paid: you see the price and approve before anything is sent, and the project spending limit applies. Nothing runs until you start the workflow. Edit the prompt first.',
    input: { title: 'AI image variations', explanation: 'Reference picture, three AI variations, approval, export.', steps: [
      imp(),
      { key: 'gen', type: 'aiGenerate', model_id: 'gemini-nano-banana-2.1', prompt: 'Three fresh variations of this picture in the same style, different composition and lighting', count: 3 },
      { key: 'ok', type: 'approval', note: 'Keep the variations you like.' },
      { key: 'out', type: 'export', presets: ['image-jpg'] },
    ], connections: [{ from: 'files', to: 'gen' }, { from: 'gen', to: 'ok' }, { from: 'ok', to: 'out' }] },
  },
  {
    id: 'builtin-animated-artwork', name: 'Animated artwork', kind: 'video', status: 'partial',
    description: 'Adds a glow and a title to a short clip, then exports MP4 and GIF.',
    needs: 'A short video clip (EffectCraft works on clips). Still pictures are not animated by this template. Local apps only.',
    input: { title: 'Animated artwork', explanation: 'Glow, title, approve, export.', steps: [
      imp('your clip'),
      { key: 'glow', type: 'artcraftEdit', app: 'effectcraft', edit: 'glow', edit_settings: { radius: 30, intensity: 1.2 } },
      { key: 'title', type: 'artcraftEdit', app: 'effectcraft', edit: 'title', edit_settings: { text: 'Your title', size: 90, color: '#ffffff' } },
      { key: 'ok', type: 'approval', note: 'Check the motion and title.' },
      { key: 'out', type: 'export', presets: ['video-mp4', 'video-gif'] },
    ], connections: chain('files', 'glow', 'title', 'ok', 'out') },
  },
  {
    id: 'builtin-short-cinematic-video', name: 'Short cinematic video', kind: 'video', status: 'partial',
    description: 'Gives clips a richer grade, then exports MP4. Make the clips first in AI Generate (video) or import your own.',
    needs: 'Clips already in the library (Veo clips made in AI Generate count). The workflow itself does not generate video; a paid video clip is always made in AI Generate with its own approval.',
    input: { title: 'Short cinematic video', explanation: 'Grade, approval, export.', steps: [
      imp('your clip'),
      { key: 'sat', type: 'artcraftEdit', app: 'filmcraft', edit: 'saturation', edit_settings: { saturation: 120 } },
      { key: 'ok', type: 'approval', note: 'Watch the result before exporting.' },
      { key: 'out', type: 'export', presets: ['video-mp4'] },
    ], connections: chain('files', 'sat', 'ok', 'out') },
  },
  {
    id: 'builtin-video-sequence-music', name: 'Video sequence with music', kind: 'video', status: 'partial',
    description: 'Prepares clips for a sequence (fade in and out) and exports MP4. Ask Claude to put the clips and music on the timeline.',
    needs: 'Several clips and a music file in the library. Joining clips and adding music is done by Claude or you on the FilmCraft timeline (verified), not by this workflow, which works on one clip at a time.',
    input: { title: 'Video sequence with music', explanation: 'Per-clip fades, approval, export.', steps: [
      imp('your clips'),
      { key: 'fades', type: 'artcraftEdit', app: 'filmcraft', edit: 'fades' },
      { key: 'ok', type: 'approval', note: 'Approve the clips, then build the sequence with music on the timeline.' },
      { key: 'out', type: 'export', presets: ['video-mp4'] },
    ], connections: chain('files', 'fades', 'ok', 'out') },
  },
  {
    id: 'builtin-logo-vector', name: 'Logo and vector illustration', kind: 'design', status: 'partial',
    description: 'Fits vector artwork to its artboard, then exports SVG, PDF and a 2x PNG.',
    needs: 'An existing SVG logo or illustration. It does not turn a picture into vector art and does not draw a logo for you.',
    input: { title: 'Logo and vector illustration', explanation: 'Fit artboard, approve, export.', steps: [
      imp('your artwork'),
      { key: 'fit', type: 'artcraftEdit', app: 'vectorcraft', edit: 'fitArtboard' },
      { key: 'ok', type: 'approval', note: 'Check the artwork before exporting.' },
      { key: 'out', type: 'export', presets: ['vector-svg', 'vector-pdf', 'vector-png2x'] },
    ], connections: chain('files', 'fit', 'ok', 'out') },
  },
  {
    id: 'builtin-photo-book', name: 'Photo book or publication', kind: 'design', status: 'partial',
    description: 'Updates the text of a DesignCraft layout, waits for approval and exports PDF and PNG.',
    needs: 'A DesignCraft layout (.designcraft) with the text you want to replace. One layout per run: it does not assemble many photos into pages.',
    input: { title: 'Photo book or publication', explanation: 'Replace text, approve, export.', steps: [
      imp('your layout'),
      { key: 'text', type: 'artcraftEdit', app: 'designcraft', edit: 'replaceText', edit_settings: { find: 'Title', replace: 'My photo book' } },
      { key: 'ok', type: 'approval', note: 'Check the pages.' },
      { key: 'out', type: 'export', presets: ['design-pdf', 'design-png'] },
    ], connections: chain('files', 'text', 'ok', 'out') },
  },
  {
    id: 'builtin-document-pdf', name: 'Document to PDF', kind: 'design', status: 'partial',
    description: 'Replaces a phrase in a Word document (.docx), waits for approval and exports a PDF and plain text.',
    needs: 'A Word document (.docx) with the phrase you want to change. One document per run; it edits text only (no layout or style changes).',
    input: { title: 'Document to PDF', explanation: 'Replace text, approve, export.', steps: [
      imp('your document'),
      { key: 'text', type: 'artcraftEdit', app: 'wordcraft', edit: 'replaceText', edit_settings: { find: 'Title', replace: 'Final title' } },
      { key: 'ok', type: 'approval', note: 'Check the document before exporting.' },
      { key: 'out', type: 'export', presets: ['document-pdf', 'document-txt'] },
    ], connections: chain('files', 'text', 'ok', 'out') },
  },
  {
    id: 'builtin-pdf-touch-up', name: 'PDF touch-up', kind: 'design', status: 'partial',
    description: 'Replaces a phrase in a PDF, waits for approval and exports a smaller PDF and plain text.',
    needs: 'A PDF with the phrase you want to change (text PDFs; scans have no text to replace). One PDF per run; the original is never changed.',
    input: { title: 'PDF touch-up', explanation: 'Replace text, approve, export.', steps: [
      imp('your PDF'),
      { key: 'text', type: 'artcraftEdit', app: 'pdfcraft', edit: 'replaceText', edit_settings: { find: 'Title', replace: 'Final title' } },
      { key: 'ok', type: 'approval', note: 'Check the PDF before exporting.' },
      { key: 'out', type: 'export', presets: ['pdf-small', 'pdf-txt'] },
    ], connections: chain('files', 'text', 'ok', 'out') },
  },
];

export type BuiltinTemplate = WorkflowTemplate & { builtin: true; kind: ProjectKind; status: TemplateStatus; needs: string; costNote: string };

let cache: BuiltinTemplate[] | null = null;

export function builtinTemplates(): BuiltinTemplate[] {
  if (cache) return cache;
  cache = DEFS.map((d) => {
    const named = d.input.steps.find((s) => s.type === 'import')!.files![0]!;
    const r = buildWorkflowPlan(d.input, { assets: [{ id: 'placeholder', name: named, sourceFormat: 'png' }], configuredProviders: [] });
    if (!r.ok) throw new Error(`Template "${d.id}" is invalid: ${r.issues.join(' ')}`);
    return {
      id: d.id, name: d.name, description: d.description, createdAt: '2026-10-14T00:00:00.000Z',
      graph: templateGraph(r.plan.graph), builtin: true as const, kind: d.kind, status: d.status, needs: d.needs, costNote: r.plan.costNote,
    };
  });
  return cache;
}

/** The short list Claude reads when recommending a template for a described project. */
export function templateCatalogForClaude(): string {
  return builtinTemplates().map((t) => `${t.id}: ${t.name} (${t.status}) ${t.description} Needs: ${t.needs}`).join('\n');
}

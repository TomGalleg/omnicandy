// Deliver tab: export presets. Every preset runs an ArtCraft app's own command-line tool headless
// (no window), and each one was verified against the installed apps (docs/integration-audit.md).
// Exports go to the project's exports/ folder; the library files themselves are only read.

import type { EditorAppId } from './appEditors';
import type { Asset } from './types';

export type DeliverGroup = 'image' | 'vector' | 'audio' | 'video' | 'design';

export interface DeliverPreset {
  id: string;
  group: DeliverGroup;
  label: string;
  /** Short description shown under the label. */
  note: string;
  ext: string;
  /** Which ArtCraft app's command-line tool writes it. */
  app: EditorAppId;
  /** Added to the source name: sunset-still-web.jpg. Empty keeps the name. */
  suffix: string;
}

/** Source file types each group takes (lower-case extensions). */
export const DELIVER_SOURCES: Record<DeliverGroup, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'gif', 'psd', 'pcraft'],
  vector: ['svg', 'svgz', 'ai', 'eps', 'pdf', 'vectorcraft'],
  audio: ['wav', 'flac', 'aif', 'aiff'],
  video: ['mp4', 'mov', 'webm', 'mkv'],
  design: ['designcraft'],
};

export const DELIVER_PRESETS: DeliverPreset[] = [
  { id: 'image-png', group: 'image', label: 'PNG', note: 'Full size, lossless', ext: 'png', app: 'photocraft', suffix: '' },
  { id: 'image-jpg', group: 'image', label: 'JPEG, high quality', note: 'Full size, quality 92', ext: 'jpg', app: 'photocraft', suffix: '' },
  { id: 'image-web', group: 'image', label: 'JPEG for the web', note: 'Long side at most 1920 px, quality 80', ext: 'jpg', app: 'photocraft', suffix: '-web' },
  { id: 'image-webp', group: 'image', label: 'WebP', note: 'Full size, quality 85', ext: 'webp', app: 'photocraft', suffix: '' },
  { id: 'image-tiff', group: 'image', label: 'TIFF for print', note: 'Full size, flat, lossless', ext: 'tif', app: 'photocraft', suffix: '' },
  { id: 'image-psd', group: 'image', label: 'Photoshop (PSD)', note: 'Keeps layers from PhotoCraft files', ext: 'psd', app: 'photocraft', suffix: '' },

  { id: 'vector-svg', group: 'vector', label: 'SVG', note: 'Scalable, for the web', ext: 'svg', app: 'vectorcraft', suffix: '' },
  { id: 'vector-pdf', group: 'vector', label: 'PDF', note: 'Scalable, for print', ext: 'pdf', app: 'vectorcraft', suffix: '' },
  { id: 'vector-png', group: 'vector', label: 'PNG', note: 'Artboard size', ext: 'png', app: 'vectorcraft', suffix: '' },
  { id: 'vector-png2x', group: 'vector', label: 'PNG at 2×', note: 'Double size, for sharp screens', ext: 'png', app: 'vectorcraft', suffix: '@2x' },
  { id: 'vector-eps', group: 'vector', label: 'EPS', note: 'For older print workflows', ext: 'eps', app: 'vectorcraft', suffix: '' },

  { id: 'audio-wav', group: 'audio', label: 'WAV, 24-bit', note: 'Studio master, original sample rate', ext: 'wav', app: 'soundcraft', suffix: '-24bit' },
  { id: 'audio-cd', group: 'audio', label: 'WAV, CD quality', note: '16-bit, 44.1 kHz', ext: 'wav', app: 'soundcraft', suffix: '-cd' },
  { id: 'audio-normalized', group: 'audio', label: 'WAV, normalized', note: 'Loudest peak brought to full scale', ext: 'wav', app: 'soundcraft', suffix: '-normalized' },
  { id: 'audio-flac', group: 'audio', label: 'FLAC', note: 'Lossless and smaller', ext: 'flac', app: 'soundcraft', suffix: '' },
  { id: 'audio-aiff', group: 'audio', label: 'AIFF', note: 'For Apple software', ext: 'aiff', app: 'soundcraft', suffix: '' },

  { id: 'video-mp4', group: 'video', label: 'MP4 (H.264)', note: 'Full size, plays everywhere', ext: 'mp4', app: 'filmcraft', suffix: '' },
  { id: 'video-mp4-half', group: 'video', label: 'MP4, half size', note: 'Smaller file for sharing', ext: 'mp4', app: 'filmcraft', suffix: '-half' },
  { id: 'video-prores', group: 'video', label: 'ProRes (MOV)', note: 'High quality for further editing', ext: 'mov', app: 'filmcraft', suffix: '-prores' },
  { id: 'video-gif', group: 'video', label: 'Animated GIF', note: 'Half size, no sound', ext: 'gif', app: 'filmcraft', suffix: '' },
  { id: 'video-aac', group: 'video', label: 'Sound only (AAC)', note: 'Compressed .m4a', ext: 'm4a', app: 'filmcraft', suffix: '-sound' },
  { id: 'video-wav', group: 'video', label: 'Sound only (WAV)', note: 'Uncompressed', ext: 'wav', app: 'filmcraft', suffix: '-sound' },

  { id: 'design-pdf', group: 'design', label: 'PDF', note: 'All pages, for print or sharing', ext: 'pdf', app: 'designcraft', suffix: '' },
  { id: 'design-png', group: 'design', label: 'PNG of page 1 at 2×', note: 'For screens and social posts', ext: 'png', app: 'designcraft', suffix: '@2x' },
];

export const presetById = (id: string) => DELIVER_PRESETS.find((p) => p.id === id);

export function deliverGroupFor(format: string): DeliverGroup | null {
  const f = format.toLowerCase();
  return (Object.keys(DELIVER_SOURCES) as DeliverGroup[]).find((g) => DELIVER_SOURCES[g].includes(f)) ?? null;
}

/** Presets that can export this file. */
export function presetsFor(format: string): DeliverPreset[] {
  const g = deliverGroupFor(format);
  return g ? DELIVER_PRESETS.filter((p) => p.group === g) : [];
}

/** The file's versions, oldest first: the original, then each version it was saved from. */
export function lineage(assets: Asset[], assetId: string): Asset[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out: Asset[] = [];
  for (let a = byId.get(assetId); a && out.length < 100; a = a.parentId ? byId.get(a.parentId) : undefined) out.unshift(a);
  return out;
}

/** Versions saved from this file (direct and further), newest first, same kind only (no PNG previews). */
export function laterVersions(assets: Asset[], assetId: string): Asset[] {
  const root = assets.find((a) => a.id === assetId);
  if (!root) return [];
  const out: Asset[] = [];
  let frontier = [assetId];
  while (frontier.length && out.length < 200) {
    const next = assets.filter((a) => a.parentId && frontier.includes(a.parentId));
    out.push(...next.filter((a) => a.kind === root.kind));
    frontier = next.map((a) => a.id);
  }
  return out.sort((a, b) => b.provenance.createdAt.localeCompare(a.provenance.createdAt));
}

export type DeliverStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface DeliverJob {
  id: string;
  assetId: string;
  assetName: string;
  presetId: string;
  presetLabel: string;
  status: DeliverStatus;
  requestedBy: 'user' | 'claude';
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Exported file name in the exports folder. */
  output?: string;
  bytes?: number;
  error?: string;
}

/** One finished export as recorded in exports/manifest.json. */
export interface DeliverRecord {
  jobId: string;
  at: string;
  preset: string;
  presetLabel: string;
  app: EditorAppId;
  requestedBy: 'user' | 'claude';
  source: { assetId: string; name: string; sha256: string; versions: string[] };
  output: { file: string; bytes: number; sha256: string };
  ms: number;
}

export const MANIFEST_FILE = 'manifest.json';

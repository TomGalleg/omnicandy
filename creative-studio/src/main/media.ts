// Lightweight, dependency-free metadata sniffing for the formats the Phase 1 library supports.
// Reads headers only; never decodes or rewrites media.

import type { AssetKind } from '@shared/types';

const KIND_BY_EXT: Record<string, AssetKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image', tif: 'image', tiff: 'image',
  svg: 'vector', svgz: 'vector', ai: 'vector', eps: 'vector', pdf: 'document',
  wav: 'audio', mp3: 'audio', flac: 'audio', ogg: 'audio', aif: 'audio', aiff: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video',
  designcraft: 'design',
  docx: 'document',
  xlsx: 'sheet',
  deckcraft: 'deck', pptx: 'deck',
  pcraft: 'project', psd: 'project', vectorcraft: 'project', scraft: 'project', fcproj: 'project', ecproj: 'project',
};

export const IMPORTABLE_EXTENSIONS = Object.keys(KIND_BY_EXT);

export function kindForExtension(ext: string): AssetKind | null {
  return KIND_BY_EXT[ext.toLowerCase().replace(/^\./, '')] ?? null;
}

export interface MediaInfo {
  width?: number;
  height?: number;
  durationSec?: number;
}

function pngInfo(b: Buffer): MediaInfo {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return {};
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegInfo(b: Buffer): MediaInfo {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return {};
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return {};
}

function svgInfo(b: Buffer): MediaInfo {
  const head = b.subarray(0, 4096).toString('utf8');
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!tag) return {};
  const num = (attr: string) => {
    const m = new RegExp(`\\b${attr}\\s*=\\s*["']([0-9.]+)(px)?["']`, 'i').exec(tag);
    return m ? Math.round(parseFloat(m[1]!)) : undefined;
  };
  const w = num('width');
  const h = num('height');
  if (w && h) return { width: w, height: h };
  const vb = /\bviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(tag);
  return vb ? { width: Math.round(parseFloat(vb[1]!)), height: Math.round(parseFloat(vb[2]!)) } : {};
}

function wavInfo(b: Buffer): MediaInfo {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return {};
  let i = 12;
  let byteRate = 0;
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === 'fmt ') byteRate = b.readUInt32LE(i + 16);
    if (id === 'data' && byteRate) return { durationSec: Math.round((size / byteRate) * 100) / 100 };
    i += 8 + size + (size % 2);
  }
  return {};
}

/**
 * MP4/MOV (ISO BMFF): duration from `mvhd`, picture size from the first video `tkhd`. The `moov`
 * box is often at the end of the file, so callers pass the file's tail as well as its head.
 */
export function mp4Info(...parts: Buffer[]): MediaInfo {
  const out: MediaInfo = {};
  for (const b of parts) {
    const mv = b.indexOf('mvhd');
    if (mv >= 4 && out.durationSec === undefined && mv + 32 <= b.length) {
      const v = b[mv + 4];
      const scale = v === 1 ? b.readUInt32BE(mv + 24) : b.readUInt32BE(mv + 16);
      const dur = v === 1 ? Number(b.readBigUInt64BE(mv + 28)) : b.readUInt32BE(mv + 20);
      if (scale > 0) out.durationSec = Math.round((dur / scale) * 100) / 100;
    }
    for (let i = b.indexOf('tkhd'); i >= 4 && out.width === undefined; i = b.indexOf('tkhd', i + 4)) {
      const v = b[i + 4];
      const at = i + 4 + (v === 1 ? 88 : 76); // after version/flags, times, track id, duration, layer…, matrix
      if (at + 8 > b.length) break;
      const w = b.readUInt32BE(at) >>> 16, h = b.readUInt32BE(at + 4) >>> 16;
      if (w > 0 && h > 0) { out.width = w; out.height = h; }
    }
  }
  return out;
}

export function sniffMedia(ext: string, head: Buffer, tail?: Buffer): MediaInfo {
  switch (ext.toLowerCase().replace(/^\./, '')) {
    case 'mp4': case 'mov': return tail ? mp4Info(head, tail) : mp4Info(head);
    case 'png': return pngInfo(head);
    case 'jpg': case 'jpeg': return jpegInfo(head);
    case 'svg': return svgInfo(head);
    case 'wav': return wavInfo(head);
    default: return {};
  }
}

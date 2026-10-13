// Minimal PNG writer (RGBA, no filtering) for the offline mock provider's test pattern.

import { deflateSync } from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (b: Buffer) => {
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Deterministic gradient + rings pattern; `seed` changes the colours. */
export function testPattern(width: number, height: number, seed: number): Buffer {
  const px = Buffer.alloc(width * height * 4);
  const h = (seed * 137.508) % 360;
  const hue = (deg: number, l: number) => {
    const a = 0.6 * Math.min(l, 1 - l);
    const f = (n: number) => { const k = (n + deg / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x / width - 0.5, dy = y / height - 0.5;
      const ring = Math.sin(Math.hypot(dx, dy) * 40) * 0.08;
      const [r, g, b] = hue(h + (x / width) * 90, 0.35 + (y / height) * 0.3 + ring);
      const i = (y * width + x) * 4;
      px[i] = r!; px[i + 1] = g!; px[i + 2] = b!; px[i + 3] = 255;
    }
  }
  return encodePng(width, height, px);
}

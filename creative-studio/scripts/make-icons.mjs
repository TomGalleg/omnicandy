// Builds the app icons from Assets/ClaudeCraft.jpg using PhotoCraft itself (photocraft-cli):
//   white background → transparent (Color to Alpha), squared canvas, then each size with Lanczos.
// Outputs:
//   resources/icon.ico                  multi-size Windows icon (16–256, PNG-compressed entries)
//   resources/icon.png                  256 px (window icon)
//   src/renderer/src/assets/logo.png    128 px (in-app logo)
// Usage: node scripts/make-icons.mjs [source image]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.resolve(process.argv[2] ?? path.join(root, 'Assets', 'ClaudeCraft.jpg'));
const cli = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PhotoCraft', 'photocraft-cli.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-icons-'));
const pc = (...args) => execFileSync(cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });

// 1. Master: transparent background, square 1024 canvas.
const master = path.join(tmp, 'master.pcraft');
pc('run', src,
  '--cmd', 'filter.other.colorToAlpha', '--params', JSON.stringify({ color: '#ffffff', transparencyThreshold: 0.03, opacityThreshold: 0.4 }),
  '--cmd', 'image.canvasSize', '--params', JSON.stringify({ width: 1024, height: 1024, anchor: 'center', extensionColor: 'transparent' }),
  '--out', master);

// 2. Sizes.
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngs = new Map();
for (const s of SIZES) {
  const out = path.join(tmp, `icon-${s}.png`);
  pc('run', master, '--cmd', 'image.imageSize', '--params', JSON.stringify({ width: s, height: s, resample: 'lanczos' }), '--out', out);
  pngs.set(s, fs.readFileSync(out));
}

// 3. ICO container (Vista+ PNG entries).
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
const dir = Buffer.alloc(16 * SIZES.length);
let offset = 6 + dir.length;
SIZES.forEach((s, i) => {
  const data = pngs.get(s);
  const e = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, e); dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
  dir.writeUInt8(0, e + 2); dir.writeUInt8(0, e + 3);
  dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(data.length, e + 8); dir.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
fs.mkdirSync(path.join(root, 'src', 'renderer', 'src', 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'resources', 'icon.ico'), Buffer.concat([header, dir, ...SIZES.map((s) => pngs.get(s))]));
fs.writeFileSync(path.join(root, 'resources', 'icon.png'), pngs.get(256));
fs.writeFileSync(path.join(root, 'src', 'renderer', 'src', 'assets', 'logo.png'), pngs.get(128));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`icons written: resources/icon.ico (${SIZES.join(', ')}), resources/icon.png, src/renderer/src/assets/logo.png`);

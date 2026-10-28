// Builds the "Sample media" pack that ships with OmniCandy from a project of your own results.
//   node scripts/build-samples.mjs "<project folder>" [--include-imported]
// It reads the project's list, keeps only files OmniCandy's users may play with (pictures, real SVG and videos that were MADE
// by an AI model in that project), shrinks them to sample size and writes resources/samples/ (files/, thumbs/, samples.json).
// ONE file per AI model card: the newest result you made with each model (those are the files that fill the cards).
// Left out on purpose, and listed in the report so you can change the rules below:
//   * the Dragon Burger branding set, files whose prompt names a trademark (NFL), the offline Mock picture, app documents,
//   * files that were imported from outside (unknown origin), unless --include-imported is given.
// Needs ffmpeg on this PC (build time only). Nothing is sent anywhere.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const project = process.argv[2];
const includeImported = process.argv.includes('--include-imported');
if (!project || !existsSync(path.join(project, 'project.json'))) { console.error('usage: node scripts/build-samples.mjs "<project folder>" [--include-imported]'); process.exit(2); }

// ---- the rules (edit here) ----
const EXCLUDE_NAME = /^polished-promotional-food-photograph/i;           // the Dragon Burger branding test
const EXCLUDE_PROMPT = /\b(nfl|star wars|jedi|disney|marvel|pokemon|nintendo|harry potter|lego|mario|batman|spider-?man|dragon burger)\b/i;
const EXCLUDE_MODEL = /^mock-image$/;
const MAX_IMAGE_SIDE = 1600;
const MAX_VIDEO_SECONDS = 10;

// ---- model names: read from the app's own registry so a sample says exactly what made it ----
const bundle = buildSync({ entryPoints: [path.join(root, 'src/shared/providerCapabilities.ts')], bundle: true, write: false, format: 'esm', platform: 'node', alias: { '@shared': path.join(root, 'src/shared') } });
const reg = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const labelOf = (provider, model) => reg.studioModel(provider, model)?.label ?? reg.studioModel(provider, `recraft-tool/${model}`)?.label ?? model;
const providerOf = (provider) => reg.studioProvider(provider)?.label ?? provider;

const manifest = JSON.parse(readFileSync(path.join(project, 'project.json'), 'utf8'));
const out = path.join(root, 'resources', 'samples');
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'files'), { recursive: true });
mkdirSync(path.join(out, 'thumbs'), { recursive: true });

const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const probe = (file) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=pix_fmt,width,height,duration', '-of', 'json', file]).toString();
const find = (a) => { const exts = a.sourceFormat.toLowerCase(); const candidates = [a.path, a.file, a.relPath].filter(Boolean); for (const c of candidates) { const p = path.join(project, c); if (existsSync(p)) return p; } return null; };

let kept = []; const skipped = [];
for (const a of manifest.assets) {
  const p = a.provenance ?? {};
  const why =
    !['image', 'vector', 'video'].includes(a.kind) ? 'an app document' :
    p.origin === 'imported' && !includeImported ? 'imported from outside (unknown origin)' :
    p.origin !== 'generated' && p.origin !== 'imported' ? `origin ${p.origin}` :
    EXCLUDE_NAME.test(a.name) ? 'Dragon Burger branding set' :
    EXCLUDE_PROMPT.test(p.prompt ?? '') ? 'the prompt names a trademark' :
    EXCLUDE_MODEL.test(p.model ?? '') ? 'offline Mock picture' : '';
  if (why) { skipped.push(`${a.kind.padEnd(6)} ${a.name.slice(0, 50)}  <- ${why}`); continue; }
  kept.push(a);
}

// One per model card: keep the newest result of each model; older ones are left out.
const keyOf = (a) => `${a.provenance?.provider}/${a.provenance?.model}`;
const newest = new Map();
for (const a of kept) {
  const cur = newest.get(keyOf(a));
  if (!cur) { newest.set(keyOf(a), a); continue; }
  const aIsNewer = (a.provenance?.createdAt ?? '') > (cur.provenance?.createdAt ?? '');
  const older = aIsNewer ? cur : a;
  newest.set(keyOf(a), aIsNewer ? a : cur);
  skipped.push(`${older.kind.padEnd(6)} ${older.name.slice(0, 50)}  <- an older result of the same model (one file per card)`);
}
const order = (a) => reg.STUDIO_MODELS.findIndex((m) => m.providerId === a.provenance?.provider && (m.id === a.provenance?.model || m.id === `recraft-tool/${a.provenance?.model}`));
kept = [...newest.values()].sort((x, y) => (order(x) < 0 ? 999 : order(x)) - (order(y) < 0 ? 999 : order(y)));

const samples = [];
const svgJobs = [];
let n = 0;
for (const a of kept) {
  const src = find(a);
  if (!src) { skipped.push(`${a.kind} ${a.name}  <- file not found in the project`); continue; }
  n++;
  const id = `sample-${String(n).padStart(2, '0')}`;
  const p = a.provenance ?? {};
  let file; let thumb = `thumbs/${id}.jpg`;
  if (a.kind === 'vector') {
    file = `files/${id}.svg`; copyFileSync(src, path.join(out, file));
    svgJobs.push({ svg: path.join(out, file), out: path.join(out, thumb) });
  } else if (a.kind === 'image') {
    const hasAlpha = /rgba|ya8|argb|bgra|pal8/.test(probe(src));
    file = `files/${id}.${hasAlpha ? 'png' : 'jpg'}`;
    ff('-i', src, '-vf', `scale='min(${MAX_IMAGE_SIDE},iw)':'min(${MAX_IMAGE_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`, ...(hasAlpha ? [] : ['-q:v', '3']), path.join(out, file));
    ff('-i', src, '-vf', 'scale=480:-2', '-frames:v', '1', '-q:v', '5', path.join(out, thumb));
  } else {
    file = `files/${id}.mp4`;
    ff('-i', src, '-t', String(MAX_VIDEO_SECONDS), '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', path.join(out, file));
    ff('-ss', '1', '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', path.join(out, thumb));
  }
  const model = labelOf(p.provider, p.model);
  const words = (p.prompt ?? '').replace(/\s+/g, ' ').trim();
  const title = words ? (words.split(' ').slice(0, 7).join(' ') + (words.split(' ').length > 7 ? '…' : '')).replace(/^./, (c) => c.toUpperCase()) : a.name;
  const how = a.kind === 'vector' ? 'A real SVG: open it in VectorCraft and edit the shapes.'
    : a.kind === 'video' ? 'Open it in FilmCraft to cut and edit, or use it as the source for a video tool.'
    : 'Open it in PhotoCraft to edit, or use it in AI Generate as a reference or to upscale and cut out.';
  samples.push({
    id, file, thumb, kind: a.kind, format: path.extname(file).slice(1), name: path.basename(a.name).replace(/\.[^.]+$/, '') ? `${title}` : title,
    blurb: `Made with ${model} (${providerOf(p.provider)}). ${how}`,
    model, prompt: words.slice(0, 240), bytes: statSync(path.join(out, file)).size,
  });
}

// SVG thumbnails are drawn by VectorCraft's own command line (ffmpeg cannot read SVG), then placed on white.
const VC = ['C:/Program Files/VectorCraft/vectorcraft-cli.exe', path.join(process.env.LOCALAPPDATA ?? '', 'Programs/VectorCraft/vectorcraft-cli.exe')].find(existsSync);
for (const j of svgJobs) {
  if (!VC) { console.error('VectorCraft is not installed here, so vector thumbnails cannot be drawn.'); process.exit(1); }
  const png = `${j.out}.png`;
  execFileSync(VC, ['run', '--in', j.svg, '--export', png, '--scale', '1'], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 120_000 });
  ff('-f', 'lavfi', '-i', 'color=c=white:s=480x480', '-i', png, '-filter_complex', '[1:v]scale=480:480:force_original_aspect_ratio=decrease[fg];[0:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1', '-frames:v', '1', '-q:v', '4', j.out);
  rmSync(png, { force: true });
}
writeFileSync(path.join(out, 'samples.json'), `${JSON.stringify({ version: 1, samples }, null, 2)}\n`);
const total = samples.reduce((s, x) => s + x.bytes, 0);
console.log(`Sample pack: ${samples.length} files, ${(total / 1048576).toFixed(1)} MB  -> ${out}`);
console.log('\nKept:'); for (const s of samples) console.log(`  ${s.id}  ${s.kind.padEnd(6)} ${(s.bytes / 1024).toFixed(0).padStart(6)} KB  ${s.model}  |  ${s.name}`);
const shown = reg.STUDIO_MODELS.filter((m) => m.availability === 'wired' && m.providerId !== 'mock');
const have = new Set(kept.map((a) => reg.STUDIO_MODELS[order(a)]?.id));
const missing = shown.filter((m) => !have.has(m.id));
console.log(`\nModel cards with NO result in this project yet (${missing.length}): ${missing.map((m) => m.label).join(', ') || 'none'}`);
console.log(`\nLeft out (${skipped.length}):`); for (const s of skipped) console.log(`  ${s}`);

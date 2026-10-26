// Collects the source files an installed OmniCandy hands to "Set up editing" (the Build panel): the code, scripts, resources and
// docs, but no node_modules, build output, archives or private files. electron-builder ships build-source/ as resources/source.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'build-source');
const items = ['src', 'scripts', 'resources', 'fixtures', 'docs', 'package.json', 'package-lock.json', 'electron.vite.config.ts',
  'tsconfig.node.json', 'tsconfig.web.json', 'eslint.config.mjs', 'vitest.config.ts', 'electron-builder.yml', 'CLAUDE.md', 'README.md'];
const skipName = /\.(zip|map|key\.pem|log)$/i;

await fs.rm(out, { recursive: true, force: true });
let files = 0;
for (const item of items) {
  const from = path.join(root, item);
  try { await fs.access(from); } catch { continue; }
  await fs.cp(from, path.join(out, item), {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src).split(path.sep).join('/');
      if (rel.split('/').some((p) => p === 'node_modules' || p === 'research' || p === 'screenshots')) return false;
      if (skipName.test(rel)) return false;
      if (rel.startsWith('docs/') && rel.split('/').length > 2) return false;
      files++;
      return true;
    },
  });
}
await fs.writeFile(path.join(out, '.omnicandy-source'), `packed ${new Date().toISOString()}\n`);
console.log(`packed ${files} source entries into build-source/`);

import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const shared = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: { externalizeDeps: true },
  },
  preload: {
    resolve: { alias: shared },
    // Sandboxed preloads must be a single CommonJS file with no node_modules imports.
    build: { externalizeDeps: { exclude: ['zod'] }, rollupOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: shared },
    plugins: [react()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});

import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Tests that spawn real processes (scans, restricted adapter children, mock programs) can pass 5 s when many files run in parallel on Windows.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

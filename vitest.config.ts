import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@signalpipe/shared': resolve(__dirname, 'packages/shared/src/index.ts') },
  },
  test: { include: ['services/**/*.test.ts', 'packages/**/*.test.ts'] },
});

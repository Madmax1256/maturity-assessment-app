import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@fs/model': r('./packages/model/src/index.ts'),
      '@fs/engine': r('./packages/engine/src/index.ts'),
      '@fs/db': r('./packages/db/src/index.ts'),
    },
  },
  test: { include: ['packages/*/test/**/*.test.ts'] },
});

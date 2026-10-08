import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Versión vigente de la app de tablet, para marcar tablets desactualizadas.
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL('../tablet/package.json', import.meta.url), 'utf8')).version) },
  base: './',
  resolve: {
    alias: {
      '@fs/model': r('../../packages/model/src/index.ts'),
      '@fs/engine': r('../../packages/engine/src/index.ts'),
      '@fs/ui': r('../../packages/ui/src/index.ts'),
    },
  },
  server: { port: 5174, fs: { allow: [r('../..')] } },
  preview: { port: 4174 },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});

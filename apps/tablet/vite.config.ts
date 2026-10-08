import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Rutas relativas: el mismo build sirve en el WebView de Android (Capacitor) y en un servidor web.
  base: './',
  resolve: {
    alias: {
      '@fs/model': r('../../packages/model/src/index.ts'),
      '@fs/engine': r('../../packages/engine/src/index.ts'),
      '@fs/db': r('../../packages/db/src/index.ts'),
    },
  },
  server: { fs: { allow: [r('../..')] } },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});

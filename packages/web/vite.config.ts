import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The base path is configurable because the same build is deployed three
 * ways: to GitHub Pages under a repository subpath, into the Electron shell
 * from the filesystem, and into the Premiere CEP panel. Only the first needs
 * a subpath, and hardcoding it breaks the other two.
 */
const base = process.env.EASYCOLOR_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@easycolor/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    // Colour work is not casual browsing: a slightly larger bundle is a fair
    // trade for keeping the engine in one chunk that the GPU path can rely on.
    chunkSizeWarningLimit: 1200,
    target: 'es2022',
  },
  server: { port: 5173, host: true },
});

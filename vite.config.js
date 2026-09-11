import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The WebGPU renderer under src/zarr-viewer/ is a self-contained app that imports its own source
// through these path aliases. Mirror them here (pointing at the same source) so the main app can
// import its `run()` entry directly. See src/zarr-viewer/vite.config.ts.
const zarrViewerSrc = resolve(import.meta.dirname, 'src/zarr-viewer/src');

export default defineConfig({
  // BASE_PATH is a build-time-only Node env var (read via process.env, not import.meta.env — it's
  // consumed here in Vite's own Node config context, not by client code). Falls back to today's
  // value so local `npm run dev`/`vite build` behavior is unchanged when unset.
  base: process.env.BASE_PATH || '/tomo_viewer/',
  resolve: {
    alias: {
      '@zarr-viewer/core': resolve(zarrViewerSrc, 'core/index.ts'),
      '@zarr-viewer/math': resolve(zarrViewerSrc, 'math/index.ts'),
      '@zarr-viewer/scene': resolve(zarrViewerSrc, 'scene/index.ts'),
      '@zarr-viewer/controls': resolve(zarrViewerSrc, 'controls/index.ts'),
      '@zarr-viewer/io': resolve(zarrViewerSrc, 'io/index.ts'),
      '@zarr-viewer/render': resolve(zarrViewerSrc, 'render/index.ts'),
      '@zarr-viewer/fx': resolve(zarrViewerSrc, 'fx/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    allowedHosts: ['react', 'localhost', 'tiled-test'],
    proxy: {
      '/viewer': {
        target: 'http://viewer:8082',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/viewer/, '')
      },
      '/tiled': {
        target: 'http://tiled:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tiled/, '')
      }
    }
  },
  plugins: [react()]
});


// create a react router
// create a fallback (/*)
// nginx config : can you make sure that this does not proxy redirect...


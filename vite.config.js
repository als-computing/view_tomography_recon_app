import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // This should match how your Vite server is running
  base: '/react/',
  server: {
    host: '0.0.0.0',
    port: 5174,
    allowedHosts: ['react', 'localhost'],
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


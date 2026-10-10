import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev server proxies the bridge (npm run dev starts both)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    proxy: {
      '/box': 'http://127.0.0.1:7777',
      '/healthz': 'http://127.0.0.1:7777',
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
    },
  },
  build: { outDir: 'dist', target: 'es2022' },
});

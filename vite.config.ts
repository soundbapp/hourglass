import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'spa',
  server: { port: 5173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2048,
  },
});

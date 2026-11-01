import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { serviceWorkerPlugin } from './src/pwa/swPlugin';

export default defineConfig({
  plugins: [react(), serviceWorkerPlugin()],
  worker: { format: 'es' },
  // pdf.js CMaps / standard fonts are imported with ?inline (see renderQueue.ts)
  assetsInclude: ['**/*.bcmap', '**/*.pfb'],
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
});

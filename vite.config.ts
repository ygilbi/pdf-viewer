import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  // pdf.js CMaps / standard fonts are imported with ?inline (see renderQueue.ts)
  assetsInclude: ['**/*.bcmap', '**/*.pfb'],
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
});

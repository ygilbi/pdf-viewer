import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { serviceWorkerPlugin } from './src/pwa/swPlugin';
import { appVersionPlugin } from './src/pwa/appVersionPlugin';
import { pdfjsPatchPlugin } from './src/core/pdfjsPatchPlugin';

export default defineConfig({
  plugins: [pdfjsPatchPlugin(), react(), serviceWorkerPlugin(), appVersionPlugin()],
  // The render worker bundles pdf.js too: same display-layer patch there (see pdfjsPatchPlugin.ts).
  worker: { format: 'es', plugins: () => [pdfjsPatchPlugin()] },
  // pdf.js CMaps / standard fonts are imported with ?inline (see renderQueue.ts)
  assetsInclude: ['**/*.bcmap', '**/*.pfb'],
  build: {
    target: 'es2022',
    // Extra pages: /download (logo + links), /login (e-mail code / passkey sign-in, access request) and /welcome (post-registration gate). Vercel cleanUrls serves x.html at /x.
    rollupOptions: { input: { main: 'index.html', download: 'download.html', login: 'login.html', welcome: 'welcome.html' } },
  },
  // pdf-lib is only reached through the lazy export worker; pre-bundle it so the first export in dev doesn't trigger a reload.
  optimizeDeps: { exclude: ['pdfjs-dist'], include: ['pdf-lib', '@pdf-lib/fontkit'] },
});

/**
 * PWA bootstrap, loaded from index.html (<script type="module">).
 * - starts capturing `beforeinstallprompt` immediately
 * - registers the service worker in production only, top-level window only,
 *   and never inside the Windows desktop app (Electron serves the files itself)
 * - then keeps looking for new versions (updates.ts → UpdateToast)
 */
import './installPrompt';
import { watchServiceWorker } from './updates';

function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  try {
    if (!('serviceWorker' in navigator)) return;
    if (window.top !== window) return; // iframes / embedded previews
    if ((window as { pdfDesktop?: unknown }).pdfDesktop) return; // desktop app (desktop/preload.cjs)
    const url = `${import.meta.env.BASE_URL}sw.js`;
    const register = () => {
      navigator.serviceWorker
        .register(url, { updateViaCache: 'none' })
        .then(watchServiceWorker)
        .catch((err) => console.warn('[pwa] SW registration failed', err));
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  } catch (err) {
    // SecurityError in sandboxed iframes / blocked storage
    console.warn('[pwa] SW unavailable', err);
  }
}

registerServiceWorker();

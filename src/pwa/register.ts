/**
 * PWA bootstrap, loaded from index.html (<script type="module">).
 * - starts capturing `beforeinstallprompt` immediately
 * - registers the service worker in production only, top-level window only
 */
import './installPrompt';

function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  try {
    if (!('serviceWorker' in navigator)) return;
    if (window.top !== window) return; // iframes / embedded previews
    const url = `${import.meta.env.BASE_URL}sw.js`;
    const register = () => {
      navigator.serviceWorker.register(url).catch((err) => console.warn('[pwa] SW registration failed', err));
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  } catch (err) {
    // SecurityError in sandboxed iframes / blocked storage
    console.warn('[pwa] SW unavailable', err);
  }
}

registerServiceWorker();

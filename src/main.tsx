import './diag/boot'; // crash reporter: must stay the first import
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { blockNativeZoom } from './pwa/blockNativeZoom';
import { lockLayoutScroll } from './components/ui/scrollWithin';

blockNativeZoom();
lockLayoutScroll();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

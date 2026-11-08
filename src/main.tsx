import './diag/boot'; // crash reporter: must stay the first import
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { blockNativeZoom } from './pwa/blockNativeZoom';

blockNativeZoom();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

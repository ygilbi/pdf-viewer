import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DownloadPage from './DownloadPage';
import '../auth/page.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DownloadPage />
  </StrictMode>,
);

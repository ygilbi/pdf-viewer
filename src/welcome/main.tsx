import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import WelcomePage from './WelcomePage';
import '../auth/page.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WelcomePage />
  </StrictMode>,
);

// Side-effect import: first import of main.tsx, so recording starts before the rest of the app evaluates.
import { initDiagnostics } from './recorder';

initDiagnostics();

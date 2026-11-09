import type { ReactNode } from 'react';
import { ToolPalette } from './ToolPalette';
import { EditToolbar } from './EditToolbar';

/**
 * Edit-mode chrome — a lazy chunk (not parsed while a file opens; prefetched at idle after the
 * first page is drawn): the right palette on desktop, the bottom toolbar on phones.
 */
export default function EditChrome({ variant, toggle }: { variant: 'palette' | 'bar'; toggle?: ReactNode }) {
  return variant === 'bar' ? <EditToolbar toggle={toggle} /> : <ToolPalette />;
}

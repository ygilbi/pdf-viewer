import type { ReactNode } from 'react';
/** Icons of the document tools (edit existing text, signature) — same style as ui/icons. */
const Svg = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** Text with a cursor over a paper patch: "edit existing text". */
export const IconTextEdit = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="5" width="13" height="14" rx="1.5" strokeDasharray="2.5 2" />
    <path d="M6.5 9h6M9.5 9v7" />
    <path d="M19 4v16M17 4h4M17 20h4" />
  </Svg>
);

/** Signature scribble on a line. */
export const IconSignature = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 15c2-4 3.5-8 5-8s-1 9 1 9 3-5 4.5-5-0.5 4 1 4 2.5-2 3.5-2" />
    <path d="M3 19.5h18" />
  </Svg>
);

import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconFolderOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
    <path d="M3 7v11a2 2 0 0 0 2 2h13.5a2 2 0 0 0 1.9-1.4L22 12H7.5a2 2 0 0 0-1.9 1.4L3 20" />
  </Svg>
);

export const IconHand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 11V6a2 2 0 0 0-4 0v5" />
    <path d="M14 10V4a2 2 0 0 0-4 0v6" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L6 15" />
  </Svg>
);

export const IconRuler = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0Z" />
    <path d="m14.5 12.5 2-2" />
    <path d="m11.5 9.5 2-2" />
    <path d="m8.5 6.5 2-2" />
    <path d="m17.5 15.5 2-2" />
  </Svg>
);

export const IconPolygon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 8 12 3l7 5-2.5 11h-9Z" fill="currentColor" fillOpacity={0.15} />
    <circle cx="12" cy="3" r="1.2" fill="currentColor" />
    <circle cx="19" cy="8" r="1.2" fill="currentColor" />
    <circle cx="5" cy="8" r="1.2" fill="currentColor" />
    <circle cx="16.5" cy="19" r="1.2" fill="currentColor" />
    <circle cx="7.5" cy="19" r="1.2" fill="currentColor" />
  </Svg>
);

export const IconZoomIn = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3M11 8v6M8 11h6" />
  </Svg>
);

export const IconZoomOut = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3M8 11h6" />
  </Svg>
);

export const IconFit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
    <rect x="8" y="8" width="8" height="8" rx="1" />
  </Svg>
);

/** Chevron pointing to the visual "next" side in RTL (left). */
export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);

export const IconFilePdf = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </Svg>
);

export const IconPanel = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Svg>
);

export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </Svg>
);

/** Opening to deduct: hatched rectangle with a minus badge. */
export const IconDeduct = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="13" height="14" rx="1" />
    <path d="M3 11l6-6M3 17 15 5M7 19l9-9M13 19l3-3" strokeWidth={1.2} />
    <circle cx="18.5" cy="17.5" r="4" fill="currentColor" fillOpacity={0.15} />
    <path d="M16.5 17.5h4" />
  </Svg>
);

/** Length: open polyline with end ticks. */
export const IconLength = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 18 9 9l6 6 6-9" />
    <circle cx="3" cy="18" r="1.4" fill="currentColor" />
    <circle cx="9" cy="9" r="1.2" fill="currentColor" />
    <circle cx="15" cy="15" r="1.2" fill="currentColor" />
    <circle cx="21" cy="6" r="1.4" fill="currentColor" />
  </Svg>
);

/** Count: numbered markers. */
export const IconCount = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="3.2" />
    <circle cx="17" cy="7" r="3.2" />
    <circle cx="7" cy="17" r="3.2" />
    <path d="M14.5 17h5M17 14.5v5" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
);

export const IconFullscreen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
  </Svg>
);

export const IconFullscreenExit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />
  </Svg>
);

export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 6 4 4v2H6v-2l4-4Z" />
  </Svg>
);

export const IconPages = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="3" width="11" height="14" rx="1.5" />
    <path d="M9 21h9.5a1.5 1.5 0 0 0 1.5-1.5V8" />
  </Svg>
);

export const IconCollapse = (p: IconProps) => (
  <Svg {...p}>
    <path d="m7 14 5-5 5 5" />
  </Svg>
);

// ---- area + markup tools ----------------------------------------------------

/** Area tool: filled polygon with "m²". */
export const IconAreaM2 = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 9 10 3l11 4-2 13H5Z" fill="currentColor" fillOpacity={0.28} />
    <text
      x="12"
      y="15.5"
      textAnchor="middle"
      fontSize="8.5"
      fontWeight={700}
      fill="currentColor"
      stroke="none"
      fontFamily="system-ui, Arial, sans-serif"
    >
      m²
    </text>
  </Svg>
);

export const IconNote = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 4v-4H6a2 2 0 0 1-2-2Z" />
    <path d="M8 8h8M8 11.5h5" />
  </Svg>
);

export const IconText = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 6V4h14v2M12 4v16M9 20h6" />
  </Svg>
);

export const IconRect = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="6" width="16" height="12" rx="0.5" />
  </Svg>
);

export const IconCloud = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 7c0-2 3-2 3 0 0-2 3-2 3 0 0-2 3-2 3 0 2 0 2 3 0 3 2 0 2 3 0 3 0 2-3 2-3 0 0 2-3 2-3 0 0 2-3 2-3 0-2 0-2-3 0-3-2 0-2-3 0-3Z" />
  </Svg>
);

export const IconArrow = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 19 18 6" />
    <path d="M10 5.5h8.5V14" />
  </Svg>
);

export const IconPen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 17c3-4 5 2 8-1s2-7 5-7 3 4 5 3" />
  </Svg>
);

export const IconHighlight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m14 4 6 6-8 8H8v-4Z" />
    <path d="M8 18 5 21H3l3-5" />
    <path d="M4 21h16" strokeOpacity={0.5} strokeWidth={3} />
  </Svg>
);

/** Labels on/off (text lines next to a square). */
export const IconLabels = (p: IconProps) => (
  <Svg {...p}>
    <rect x="15" y="4" width="5" height="5" rx="1" />
    <rect x="15" y="15" width="5" height="5" rx="1" />
    <path d="M4 6.5h8M4 17.5h8" />
  </Svg>
);

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16Z" />
    <path d="m13.5 6.5 4 4" />
  </Svg>
);

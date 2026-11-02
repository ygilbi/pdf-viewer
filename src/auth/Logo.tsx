const BASE = import.meta.env.BASE_URL;

/**
 * The white line-art "PDF" logo: the drawn mark + "PDF" as an image, and the tagline
 * as real text so it can be set much larger than in the original artwork (where it is
 * a thin line under the mark). Width comes from the caller (className/style); the
 * tagline scales with the logo's own width (container query units).
 */
export function WordmarkLogo({ className, style, sizes = '92vw' }: { className?: string; style?: React.CSSProperties; sizes?: string }) {
  return (
    <figure className={`brand-logo ${className ?? ''}`} style={style} role="img" aria-label="PDF — Professional Document Solutions">
      <img
        src={`${BASE}icons/logo-mark-white.png`}
        srcSet={`${BASE}icons/logo-mark-white.png 560w, ${BASE}icons/logo-mark-white@2x.png 1120w`}
        sizes={sizes}
        width={560}
        height={363}
        alt=""
        draggable={false}
        className="brand-mark"
      />
      <figcaption className="brand-tagline" aria-hidden="true">
        <span>PROFESSIONAL</span>
        <span>DOCUMENT SOLUTIONS</span>
      </figcaption>
    </figure>
  );
}

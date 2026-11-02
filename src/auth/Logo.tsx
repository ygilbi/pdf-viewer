const BASE = import.meta.env.BASE_URL;

/** The white line-art "PDF" wordmark (560px + 1120px @2x). Sized by the caller via className/style. */
export function WordmarkLogo({ className, style, sizes = '92vw' }: { className?: string; style?: React.CSSProperties; sizes?: string }) {
  return (
    <img
      src={`${BASE}icons/logo-wordmark-white.png`}
      srcSet={`${BASE}icons/logo-wordmark-white.png 560w, ${BASE}icons/logo-wordmark-white@2x.png 1120w`}
      sizes={sizes}
      width={560}
      height={433}
      alt="PDF — Professional Document Solutions"
      draggable={false}
      className={className}
      style={style}
    />
  );
}

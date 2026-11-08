#!/usr/bin/env python3
"""Generate all app icons from the brand logo (line-art "PDF" mark).

Usage: python3 scripts/make-icons.py      (needs Pillow + numpy)

Source: scripts/assets/logo-source.jpg — a grayscale crop of the supplied logo
(black hand-drawn outline letters "PDF" + "PDF" wordmark + tagline on textured
paper). The paper texture is removed by turning darkness into a soft alpha
(anti-aliased, no hard threshold); strokes are thickened for small sizes so the
mark stays legible.

Outputs (public/icons/):
  icon-192.png, icon-512.png          purpose "any": black mark on off-white rounded tile
  maskable-192.png, maskable-512.png  full-bleed off-white, mark inside the 80% safe zone
  apple-touch-icon.png (180)          full-bleed (iOS rounds it itself)
  favicon.ico (16/32/48), favicon-32.png
  file-pdf-{32,48,256,512}.png, file-pdf.ico
                                      dark-blue sheet with folded corner + bold white "P"
                                      (manifest file_handlers icons / Windows .pdf file-type icon)
  logo-mark-white.png / @2x           white line-art mark only (no "PDF" caption, no tagline),
                                      for the dark start / login / download pages
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "scripts" / "assets" / "logo-source.jpg"
OUT = ROOT / "public" / "icons"

INK = (17, 17, 17)
PAPER = (250, 248, 243)       # off-white tile / page
EDGE = (205, 200, 190)        # hairline around the tile so it reads on light taskbars
SS = 4                        # supersampling for shapes

# Regions in source-crop coordinates (scripts/assets/logo-source.jpg, 1080x845).
WORDMARK_BOX = (320, 570, 1080, 845)   # "PDF" text + tagline (not part of the line-art mark)
TAGLINE_TOP = 775                      # tagline row
SMUDGE_BOX = (960, 765, 1050, 835)     # pen smudge across "IO" in the tagline


# ---------------------------------------------------------------- extraction

def load_alpha() -> np.ndarray:
    """Soft ink alpha in [0,1]: paper (>= ~232 gray) -> 0, ink (<= ~80) -> 1."""
    g = np.asarray(Image.open(SRC).convert("L")).astype(np.float32)
    a = np.clip((228.0 - g) / 148.0, 0.0, 1.0)
    a = a * a * (3 - 2 * a)            # smoothstep falloff keeps AA edges soft
    x0, y0, x1, y1 = SMUDGE_BOX        # stricter threshold inside the smudge
    sub = g[y0:y1, x0:x1]
    a[y0:y1, x0:x1] = np.clip((105.0 - sub) / 55.0, 0.0, 1.0)
    # the smudge broke the diagonal of the "N": erase it and redraw it cleanly
    a[780:826, 992:1011] = 0
    fix = Image.new("L", (a.shape[1] * SS, a.shape[0] * SS), 0)
    fd = ImageDraw.Draw(fix)
    fd.line([(999 * SS, 784 * SS), (999 * SS, 822 * SS)], fill=255, width=3 * SS)          # left stem
    fd.line([(999.5 * SS, 785 * SS), (1011.5 * SS, 821 * SS)], fill=255, width=3 * SS)   # diagonal
    fix = np.asarray(fix.resize((a.shape[1], a.shape[0]), Image.LANCZOS)).astype(np.float32) / 255
    np.maximum(a, fix, out=a)
    a[a < 0.04] = 0.0
    return a


def bbox_crop(a: np.ndarray) -> np.ndarray:
    ys, xs = np.nonzero(a > 0.1)
    return a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def mark_alpha(a: np.ndarray) -> np.ndarray:
    m = a.copy()
    x0, y0, x1, y1 = WORDMARK_BOX
    m[y0:y1, x0:x1] = 0
    m[TAGLINE_TOP:, :] = 0
    return bbox_crop(m)


def wordmark_alpha(a: np.ndarray) -> np.ndarray:
    return bbox_crop(a)


SRC_STROKE = 5.0  # measured line width in the source crop (px)


def maxpool(a: np.ndarray, k: int) -> np.ndarray:
    h, w = a.shape
    h2, w2 = -(-h // k) * k, -(-w // k) * k
    p = np.zeros((h2, w2), a.dtype)
    p[:h, :w] = a
    return p.reshape(h2 // k, k, w2 // k, k).max(axis=(1, 3))


def dilate(a: np.ndarray, r: float) -> np.ndarray:
    """Grey dilation with a disk of radius r (px)."""
    if r <= 0.25:
        return a
    ri = int(np.ceil(r))
    out = a.copy()
    pad = np.pad(a, ri)
    h, w = a.shape
    for dy in range(-ri, ri + 1):
        for dx in range(-ri, ri + 1):
            d = (dx * dx + dy * dy) ** 0.5
            if d > r + 0.5:
                continue
            wgt = min(1.0, r + 0.5 - d)  # soft disk edge
            np.maximum(out, pad[ri + dy:ri + dy + h, ri + dx:ri + dx + w] * wgt, out=out)
    return out


def render(alpha: np.ndarray, width: int, stroke: float) -> Image.Image:
    """Scale the alpha map to `width` px wide with lines ~`stroke` px thick.

    Works at 4x the target: area-preserving max-pool (thin lines survive), disk
    dilation to the wanted thickness, then a high-quality downscale (keeps AA).
    """
    h0, w0 = alpha.shape
    inter_w = width * 4
    scale = inter_w / w0
    if scale < 1:
        k = max(1, int(round(1 / scale)))
        a = maxpool(alpha, k)
        native = max(1.0, SRC_STROKE / k)
    else:
        a = alpha
        native = SRC_STROKE
    img = Image.fromarray((a * 255).astype(np.uint8))
    ih = max(1, round(h0 * inter_w / w0))
    img = img.resize((inter_w, ih), Image.LANCZOS)
    native_inter = native * inter_w / a.shape[1]
    want = stroke * 4
    a = np.asarray(img).astype(np.float32) / 255
    a = dilate(a, (want - native_inter) / 2)
    img = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    return img.resize((width, max(1, round(ih / 4))), Image.LANCZOS)


def stroke_for(size: int) -> float:
    """Target line thickness (px) for an icon `size` px tall/wide."""
    if size <= 16:
        return 0.85
    if size <= 32:
        return 0.95
    if size <= 48:
        return 1.15
    if size <= 64:
        return 1.5
    return min(3.6, 0.8 + size * 0.0058)


def colored(a: Image.Image, rgb) -> Image.Image:
    layer = Image.new("RGBA", a.size, rgb + (0,))
    layer.putalpha(a)
    return layer


def place(canvas: Image.Image, alpha: np.ndarray, box, rgb=INK, stroke=None) -> None:
    """Fit the mark into box=(x0,y0,x1,y1), centred."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    h, w = alpha.shape
    s = min(bw / w, bh / h)
    tw = max(1, round(w * s))
    a = render(alpha, tw, stroke if stroke is not None else stroke_for(canvas.width))
    lay = colored(a, rgb)
    canvas.alpha_composite(lay, (round(x0 + (bw - lay.width) / 2), round(y0 + (bh - lay.height) / 2)))


# ---------------------------------------------------------------- shapes

def rounded_tile(size: int, radius: float, fill, edge=None, inset: float = 0) -> Image.Image:
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    i = inset * SS
    d.rounded_rectangle([i, i, big - 1 - i, big - 1 - i], radius=radius * SS, fill=fill,
                        outline=edge, width=max(SS, round(size / 128 * SS)) if edge else 0)
    return img.resize((size, size), Image.LANCZOS)


def icon_any(m: np.ndarray, size: int) -> Image.Image:
    inset = size * 0.04 if size >= 64 else 0
    img = rounded_tile(size, size * 0.2, PAPER + (255,), EDGE + (255,) if size >= 32 else None, inset)
    pad = size * (0.15 if size >= 64 else 0.06)
    place(img, m, (pad, pad, size - pad, size - pad))
    return img


def icon_maskable(m: np.ndarray, size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), PAPER + (255,))
    pad = size * 0.2  # mark inside the central 60% (safe zone is the 80% circle)
    place(img, m, (pad, pad, size - pad, size - pad))
    return img


FILE_NAVY = (16, 38, 86)      # .pdf file icon: dark blue sheet …
FILE_FOLD = (64, 98, 168)     # … lighter folded corner
FILE_EDGE = (9, 22, 52)       # … dark hairline so it reads on dark Explorer themes too


def p_glyph(w: int, h: int) -> Image.Image:
    """Solid rounded "P" (stem + bowl with counter) as an L mask of w×h, drawn supersampled."""
    k = 8
    W, H = w * k, h * k
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)
    sw, bh, r = W * 0.40, H * 0.62, W * 0.14
    d.rounded_rectangle([0, 0, W, bh], radius=min(bh / 2, W * 0.5), fill=255)   # bowl
    d.rounded_rectangle([0, 0, sw, H], radius=r, fill=255)                       # stem
    d.rounded_rectangle([0, 0, W * 0.6, bh], radius=r, fill=255)                 # square-ish top-left
    t = W * 0.17 * 0.95
    ch = bh - 2 * t
    d.rounded_rectangle([sw - W * 0.02, t, W - W * 0.17, t + ch], radius=ch / 2, fill=0)  # counter
    return m.resize((w, h), Image.LANCZOS)


def file_icon(size: int) -> Image.Image:
    """.pdf file-type icon: dark-blue page with a folded top-right corner and a bold white "P".

    A solid letter instead of the line-art mark: it stays crisp from 16 px up and makes PDF files
    stand out in Explorer at every view size.
    """
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = big * 0.76
    x0 = (big - w) / 2
    x1 = x0 + w
    y0, y1 = big * 0.04, big * 0.96
    fold = w * 0.28
    lw = max(SS, round(big / 64))
    page = [(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)]
    shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x + big * 0.012, y + big * 0.02) for x, y in page], fill=(0, 0, 0, 80))
    shadow = shadow.filter(ImageFilter.GaussianBlur(big * 0.012))
    img.alpha_composite(shadow)
    d.polygon(page, fill=FILE_NAVY + (255,))
    d.line(page + [page[0]], fill=FILE_EDGE + (255,), width=lw, joint="curve")
    flap = [(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)]
    d.polygon(flap, fill=FILE_FOLD + (255,))
    d.line(flap + [flap[0]], fill=FILE_EDGE + (255,), width=lw, joint="curve")
    img = img.resize((size, size), Image.LANCZOS)
    s = size / big
    gh = round(size * 0.50)
    gw = round(gh * 0.74)
    cx = (x0 + x1) / 2 * s - size * 0.02
    cy = (y0 + fold * 0.6 + y1) / 2 * s
    img.alpha_composite(colored(p_glyph(gw, gh), (255, 255, 255)), (round(cx - gw / 2), round(cy - gh / 2)))
    return img


def _largest_component(mask: np.ndarray) -> np.ndarray:
    """Boolean mask of the largest 8-connected component (pure numpy/BFS, no scipy)."""
    from collections import deque
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    best, best_n, n = None, 0, 0
    for y, x in zip(*np.nonzero(mask)):
        if lab[y, x]:
            continue
        n += 1
        lab[y, x] = n
        q, count = deque([(y, x)]), 0
        while q:
            cy, cx = q.popleft()
            count += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = n
                        q.append((ny, nx))
        if count > best_n:
            best, best_n = n, count
    return lab == best


def crop_mark_only(src: Path, dst: Path) -> None:
    """Keep only the line-art mark: drop the tagline row and the separate "PDF" letters
    under it (everything except the largest connected shape), then crop tight."""
    im = Image.open(src).convert("RGBA")
    arr = np.array(im)
    keep = _largest_component(arr[:, :, 3] > 30)
    # Grow by 2px so the anti-aliased edge of the mark survives.
    h, w = keep.shape
    padded = np.pad(keep, 2)
    grown = np.zeros_like(keep)
    for dy in range(5):
        for dx in range(5):
            grown |= padded[dy:dy + h, dx:dx + w]
    arr[:, :, 3] = np.where(grown, arr[:, :, 3], 0)
    out = Image.fromarray(arr)
    out.crop(out.getbbox()).save(dst, optimize=True)


def wordmark_white(w_alpha: np.ndarray, width: int) -> Image.Image:
    a = render(w_alpha, width, max(1.6, width / 330))
    return colored(a, (241, 245, 249))  # slate-100


# ---------------------------------------------------------------- main

def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    a = load_alpha()
    m = mark_alpha(a)
    wm = wordmark_alpha(a)

    for s in (192, 512):
        icon_any(m, s).save(OUT / f"icon-{s}.png", optimize=True)
        icon_maskable(m, s).save(OUT / f"maskable-{s}.png", optimize=True)
    apple = Image.new("RGBA", (180, 180), PAPER + (255,))
    place(apple, m, (180 * 0.14, 180 * 0.14, 180 * 0.86, 180 * 0.86))
    apple.convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)

    fav = {s: icon_any(m, s) for s in (16, 32, 48)}
    fav[32].save(OUT / "favicon-32.png", optimize=True)
    fav[48].save(OUT / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)],
                 append_images=[fav[16], fav[32]])

    for s in (32, 48, 256, 512):
        file_icon(s).save(OUT / f"file-pdf-{s}.png", optimize=True)
    # Windows .pdf file-type icon (installer DefaultIcon): every size drawn natively, not scaled.
    ico_sizes = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
    frames = [file_icon(s) for s in ico_sizes]
    frames[-1].save(OUT / "file-pdf.ico", format="ICO", sizes=[(s, s) for s in ico_sizes],
                    append_images=frames[:-1])

    wordmark_white(wm, 560).save(OUT / "logo-wordmark-white.png", optimize=True)
    # 2x for the large logo on /download and /login (srcset); ~ the source crop's resolution.
    wordmark_white(wm, 1120).save(OUT / "logo-wordmark-white@2x.png", optimize=True)
    # Line-art mark only (the small "PDF" caption and the tagline are dropped; pages render the
    # tagline as HTML text). The full wordmark is only an intermediate and is not shipped.
    for name in ("logo-wordmark-white.png", "logo-wordmark-white@2x.png"):
        crop_mark_only(OUT / name, OUT / name.replace("wordmark-white", "mark-white"))
        (OUT / name).unlink()
    print("wrote", ", ".join(sorted(p.name for p in OUT.iterdir())))


if __name__ == "__main__":
    main()

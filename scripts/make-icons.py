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
  file-pdf-{32,48,256,512}.png        document sheet with folded corner + mark
                                      (manifest file_handlers icons = .pdf file-type icon)
  logo-wordmark-white.png             white lines on transparent, for the dark start screen
  logo-wordmark-white@2x.png          same at 1120px wide (big logo on /download, /login)
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


def file_icon(m: np.ndarray, size: int) -> Image.Image:
    """A page sheet with a folded top-left corner (RTL-neutral) and the mark."""
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
    # soft shadow
    shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x + big * 0.012, y + big * 0.02) for x, y in page], fill=(0, 0, 0, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(big * 0.012))
    img.alpha_composite(shadow)
    d.polygon(page, fill=(255, 255, 255, 255))
    d.line(page + [page[0]], fill=(120, 116, 108, 255), width=lw, joint="curve")
    flap = [(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)]
    d.polygon(flap, fill=(226, 222, 214, 255))
    d.line(flap + [flap[0]], fill=(120, 116, 108, 255), width=lw, joint="curve")
    # red "PDF" band at the bottom for instant file-type recognition at large sizes
    if size >= 128:
        by0 = y1 - big * 0.2
        d.rectangle([x0 + lw, by0, x1 - lw, y1 - lw], fill=(220, 38, 38, 255))
    img = img.resize((size, size), Image.LANCZOS)
    s = size / big
    mx0, mx1 = x0 * s + size * 0.08, x1 * s - size * 0.08
    if size >= 128:
        my0, my1 = (y0 + fold * 0.9) * s, (y1 - big * 0.2) * s - size * 0.05
    else:
        my0, my1 = (y0 + fold * 0.75) * s, y1 * s - size * 0.08
    place(img, m, (mx0, my0, mx1, my1), stroke=stroke_for(size) * (0.85 if size >= 128 else 1))
    if size >= 128:
        draw_pdf_label(img, x0 * s, (y1 - big * 0.2) * s, x1 * s, y1 * s)
    return img


def draw_pdf_label(img: Image.Image, x0, y0, x1, y1) -> None:
    """White 'PDF' letters in the red band, drawn as strokes (no font dependency)."""
    big = Image.new("RGBA", (img.width * SS, img.height * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    h = (y1 - y0) * 0.52 * SS
    cy = (y0 + y1) / 2 * SS
    lw = max(SS, round(h * 0.17))
    lt = cy - h / 2
    lb = cy + h / 2
    gw = h * 0.62
    gap = h * 0.28
    total = 3 * gw + 2 * gap
    x = (x0 + x1) / 2 * SS - total / 2
    col = (255, 255, 255, 255)
    r = h * 0.27
    # P
    d.line([(x, lb), (x, lt)], fill=col, width=lw)
    d.arc([x - gw * 0.4, lt, x + gw, lt + 2 * r * 1.0 + h * 0.02], 270, 90, fill=col, width=lw)
    d.line([(x, lt + lw / 2 - 1), (x + gw * 0.3, lt + lw / 2 - 1)], fill=col, width=lw)
    d.line([(x, lt + 2 * r + h * 0.02 - lw / 2 + 1), (x + gw * 0.3, lt + 2 * r + h * 0.02 - lw / 2 + 1)], fill=col, width=lw)
    x += gw + gap
    # D
    d.line([(x, lb), (x, lt)], fill=col, width=lw)
    d.arc([x - gw * 0.6, lt, x + gw, lb], 270, 90, fill=col, width=lw)
    x += gw + gap
    # F
    d.line([(x, lb), (x, lt)], fill=col, width=lw)
    d.line([(x, lt + lw / 2), (x + gw, lt + lw / 2)], fill=col, width=lw)
    d.line([(x, cy), (x + gw * 0.8, cy)], fill=col, width=lw)
    img.alpha_composite(big.resize(img.size, Image.LANCZOS))


def crop_mark_only(src: Path, dst: Path) -> None:
    """Cut the tagline (last text row, below the widest blank row gap) off a wordmark PNG."""
    im = Image.open(src)
    rows = np.where(np.array(im)[:, :, 3].max(1) > 40)[0]
    gaps = [(rows[i], rows[i + 1]) for i in range(len(rows) - 1) if rows[i + 1] - rows[i] > 3]
    cut = int(max(gaps, key=lambda g: g[1] - g[0])[0]) + 2
    box = im.getbbox()
    im.crop((box[0], 0, box[2], cut)).save(dst, optimize=True)


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
        file_icon(m, s).save(OUT / f"file-pdf-{s}.png", optimize=True)

    wordmark_white(wm, 560).save(OUT / "logo-wordmark-white.png", optimize=True)
    # 2x for the large logo on /download and /login (srcset); ~ the source crop's resolution.
    wordmark_white(wm, 1120).save(OUT / "logo-wordmark-white@2x.png", optimize=True)
    # Mark + "PDF" only (tagline cropped off): the pages render the tagline as large HTML text.
    for name in ("logo-wordmark-white.png", "logo-wordmark-white@2x.png"):
        crop_mark_only(OUT / name, OUT / name.replace("wordmark-white", "mark-white"))
    print("wrote", ", ".join(sorted(p.name for p in OUT.iterdir())))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate PWA icons (ruler on blueprint grid) into public/icons/.

Usage: python3 scripts/make-icons.py
Outputs: icon-192.png, icon-512.png (rounded, transparent corners),
         maskable-192.png, maskable-512.png (full bleed, glyph in 80% safe zone),
         file-pdf-256.png (file-handler icon), apple-touch-icon.png (180).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = (15, 23, 42)          # slate-900 / #0f172a
GRID = (30, 64, 120)
GRID_MAJOR = (45, 95, 170)
RULER = (203, 213, 225)    # aluminum silver
RULER_EDGE = (100, 116, 139)
TICK = (15, 23, 42)
ACCENT = (56, 189, 248)    # sky-400
SS = 4                     # supersampling factor


def glyph(d: ImageDraw.ImageDraw, size: int, inset: float) -> None:
    """Draw grid + diagonal ruler inside [inset, size-inset]."""
    lo, hi = size * inset, size * (1 - inset)
    span = hi - lo
    step = span / 8
    for i in range(9):
        p = lo + i * step
        col = GRID_MAJOR if i % 4 == 0 else GRID
        w = max(1, int(size / 170))
        d.line([(p, lo), (p, hi)], fill=col, width=w)
        d.line([(lo, p), (hi, p)], fill=col, width=w)
    # measured polygon (facade) outline in accent
    a = [(lo + span * 0.18, lo + span * 0.30), (lo + span * 0.62, lo + span * 0.18),
         (lo + span * 0.62, lo + span * 0.55), (lo + span * 0.18, lo + span * 0.55)]
    d.polygon(a, outline=ACCENT, width=max(2, int(size / 60)))
    r = size / 55
    for x, y in a:
        d.ellipse([x - r, y - r, x + r, y + r], fill=ACCENT)
    # ruler: a rotated rectangle along the lower diagonal
    import math
    ang = math.radians(-35)
    cx, cy = lo + span * 0.52, lo + span * 0.74
    L, W = span * 0.92, span * 0.17
    ux, uy = math.cos(ang), math.sin(ang)
    vx, vy = -uy, ux
    def pt(s, t):
        return (cx + ux * s + vx * t, cy + uy * s + vy * t)
    body = [pt(-L / 2, -W / 2), pt(L / 2, -W / 2), pt(L / 2, W / 2), pt(-L / 2, W / 2)]
    d.polygon(body, fill=RULER, outline=RULER_EDGE, width=max(1, int(size / 120)))
    n = 16
    for i in range(1, n):
        s = -L / 2 + L * i / n
        tl = W * (0.55 if i % 4 == 0 else 0.3)
        d.line([pt(s, -W / 2), pt(s, -W / 2 + tl)], fill=TICK, width=max(1, int(size / 140)))


def render(size: int, maskable: bool) -> Image.Image:
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, S, S], fill=BG)
        glyph(d, S, 0.2)          # keep inside the 80% safe circle
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.18, fill=BG)
        glyph(d, S, 0.1)
    return img.resize((size, size), Image.LANCZOS)


def render_file_icon(size: int) -> Image.Image:
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    l, t, r, b, fold = S * 0.18, S * 0.06, S * 0.82, S * 0.94, S * 0.18
    d.polygon([(l, t), (r - fold, t), (r, t + fold), (r, b), (l, b)], fill=BG)
    d.polygon([(r - fold, t), (r - fold, t + fold), (r, t + fold)], fill=GRID_MAJOR)
    inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    glyph(ImageDraw.Draw(inner), S, 0.26)
    img.alpha_composite(inner.crop((0, 0, S, int(S * 0.78))), (0, 0))
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", int(S * 0.14))
    except OSError:
        font = ImageFont.load_default()
    d = ImageDraw.Draw(img)
    d.rectangle([l, S * 0.74, r, b], fill=(220, 38, 38))
    d.text(((l + r) / 2, (S * 0.74 + b) / 2), "PDF", fill="white", font=font, anchor="mm")
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (192, 512):
        render(s, False).save(OUT / f"icon-{s}.png", optimize=True)
        render(s, True).save(OUT / f"maskable-{s}.png", optimize=True)
    a = render(180, True).convert("RGB")
    a.save(OUT / "apple-touch-icon.png", optimize=True)
    render_file_icon(256).save(OUT / "file-pdf-256.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()

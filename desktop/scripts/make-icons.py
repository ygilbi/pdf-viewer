#!/usr/bin/env python3
"""Build the Windows icons for the desktop app from the web app's icons.

Usage: python3 desktop/scripts/make-icons.py      (needs Pillow)

  desktop/build/icon.ico      app / installer / shortcut icon, 16..256
                              (16/32/48 frames come from public/icons/favicon.ico, which
                              scripts/make-icons.py renders with thickened strokes; the
                              larger frames are downscaled from icon-512.png)
  desktop/build/file-pdf.ico  .pdf file-type icon (copied from public/icons/file-pdf.ico)

Re-run after `python3 scripts/make-icons.py` changes the logo.
"""
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ICONS = ROOT / "public" / "icons"
OUT = ROOT / "desktop" / "build"
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    big = Image.open(ICONS / "icon-512.png").convert("RGBA")
    fav = Image.open(ICONS / "favicon.ico")
    small = {}
    for s in fav.info.get("sizes", ()):  # exact hand-tuned small frames
        fav.size = s
        small[s[0]] = fav.convert("RGBA").copy()
    frames = []
    for n in SIZES:
        frames.append(small[n] if n in small else big.resize((n, n), Image.LANCZOS))
    largest = frames[-1]
    largest.save(OUT / "icon.ico", format="ICO", sizes=[(n, n) for n in SIZES], append_images=frames[:-1])
    shutil.copyfile(ICONS / "file-pdf.ico", OUT / "file-pdf.ico")
    # Linux / `electron .` window icon
    big.resize((256, 256), Image.LANCZOS).save(OUT / "icon.png")
    print("wrote", OUT / "icon.ico", Image.open(OUT / "icon.ico").info["sizes"])


if __name__ == "__main__":
    main()

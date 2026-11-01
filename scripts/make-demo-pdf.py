#!/usr/bin/env python3
"""Generate public/demo-facade.pdf - a demo architectural drawing set at true 1:100.

A2 landscape (594 x 420 mm). At 1:100, 1 m in reality = 1 cm on paper = 72/2.54 pt.
Page 1: South facade, page 2: North facade, page 3: ground floor plan.

Usage:  python3 scripts/make-demo-pdf.py   (requires reportlab: pip install --user reportlab)
"""
import os
from reportlab.lib.pagesizes import A2, landscape
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "demo-facade.pdf")
PW, PH = landscape(A2)            # 1683.78 x 1190.55 pt
M = 72 / 2.54                     # 1 m at 1:100 in pt (28.3465)

# Fonts: DejaVu Sans includes Hebrew glyphs. Fall back to Helvetica (English only).
FONT, FONTB, HEB = "Helvetica", "Helvetica-Bold", False
for reg, bold in [("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                   "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")]:
    if os.path.exists(reg) and os.path.exists(bold):
        pdfmetrics.registerFont(TTFont("DV", reg))
        pdfmetrics.registerFont(TTFont("DVB", bold))
        FONT, FONTB, HEB = "DV", "DVB", True


def heb(s, fallback):
    """Hebrew in visual order (reversed); pure-Hebrew strings only (no digits)."""
    return s[::-1] if HEB else fallback


# Building origin (bottom-left corner of facade at +-0.00), reportlab coords (bottom-left page origin)
OX, OY = 360.0, 330.0
W, H = 24.0, 14.0
FLOOR = 3.2
AXES = [0, 6, 12, 18, 24]


def P(x, y):
    return OX + x * M, OY + y * M


class Sheet:
    def __init__(self, c):
        self.c = c

    def lw(self, w, gray=0.0):
        self.c.setLineWidth(w)
        self.c.setStrokeGray(gray)

    def line(self, x1, y1, x2, y2):
        a, b = P(x1, y1), P(x2, y2)
        self.c.line(a[0], a[1], b[0], b[1])

    def rect(self, x, y, w, h, fill=None):
        a = P(x, y)
        if fill is not None:
            self.c.setFillGray(fill)
        self.c.rect(a[0], a[1], w * M, h * M, stroke=1, fill=1 if fill is not None else 0)
        self.c.setFillGray(0)

    def text(self, x, y, s, size=9, font=None, anchor="middle", rot=0):
        c = self.c
        px, py = P(x, y)
        c.saveState()
        c.translate(px, py)
        if rot:
            c.rotate(rot)
        c.setFont(font or FONT, size)
        c.setFillGray(0)
        if anchor == "middle":
            c.drawCentredString(0, 0, s)
        elif anchor == "end":
            c.drawRightString(0, 0, s)
        else:
            c.drawString(0, 0, s)
        c.restoreState()

    # Horizontal dimension at height y, between x1/x2, extension lines from ext_from
    def hdim(self, x1, x2, y, label=None, ext_from=None):
        self.lw(0.5)
        self.line(x1 - 0.3, y, x2 + 0.3, y)
        for x in (x1, x2):
            if ext_from is not None:
                gap = 0.2 if ext_from > y else -0.2
                self.line(x, ext_from - gap, x, y - 0.25 if ext_from > y else y + 0.25)
            self.lw(1.2)
            self.line(x - 0.18, y - 0.18, x + 0.18, y + 0.18)   # architectural tick
            self.lw(0.5)
        self.text((x1 + x2) / 2, y + 0.15, label or f"{x2 - x1:.2f}", size=10)

    def vdim(self, y1, y2, x, label=None, ext_from=None):
        self.lw(0.5)
        self.line(x, y1 - 0.3, x, y2 + 0.3)
        for y in (y1, y2):
            if ext_from is not None:
                gap = 0.2 if ext_from < x else -0.2
                self.line(ext_from + gap, y, x + 0.25 if ext_from < x else x - 0.25, y)
            self.lw(1.2)
            self.line(x - 0.18, y - 0.18, x + 0.18, y + 0.18)
            self.lw(0.5)
        self.text(x - 0.15, (y1 + y2) / 2, label or f"{y2 - y1:.2f}", size=10, rot=90)

    def bubble(self, x, y, label):
        self.lw(0.6)
        px, py = P(x, y)
        self.c.circle(px, py, 0.45 * M, stroke=1, fill=0)
        self.text(x, y - 0.17, label, size=12, font=FONTB)

    def axis_line(self, x, y_from, y_to):
        self.lw(0.35, 0.35)
        self.c.setDash(8, 3, )
        self.c.setDash([10, 3, 2, 3])
        self.line(x, y_from, x, y_to)
        self.c.setDash()
        self.lw(0.5)

    def level(self, x, y, label, left=True):
        """Level marker triangle with label (e.g. +3.20)."""
        self.lw(0.5)
        px, py = P(x, y)
        s = 5
        p = self.c.beginPath()
        p.moveTo(px, py); p.lineTo(px - s, py + s * 1.4); p.lineTo(px + s, py + s * 1.4); p.close()
        self.c.setFillGray(0)
        self.c.drawPath(p, stroke=1, fill=1)
        self.line(x - 1.6, y, x + 0.5, y) if left else self.line(x - 0.5, y, x + 1.6, y)
        self.text(x - 0.3 if left else x + 0.3, y + 0.32, label, size=9, anchor="end" if left else "start")

    def window(self, x, y, w=1.5, h=1.4, split=True):
        """Aluminium window: frame, sash split, sill."""
        self.lw(0.9)
        self.rect(x, y, w, h, fill=0.88)
        self.lw(0.4)
        self.rect(x + 0.06, y + 0.06, w - 0.12, h - 0.12)
        if split:
            self.line(x + w / 2, y + 0.06, x + w / 2, y + h - 0.06)
            # opening sash indicator (dashed chevron)
            self.c.setDash([3, 2])
            self.lw(0.3)
            self.line(x + w / 2 - 0.06, y + 0.1, x + 0.1, y + h / 2)
            self.line(x + 0.1, y + h / 2, x + w / 2 - 0.06, y + h - 0.1)
            self.c.setDash()
        self.lw(0.9)
        self.line(x - 0.08, y - 0.05, x + w + 0.08, y - 0.05)  # sill

    def curtain_wall(self, x, y, w, h, cols, rows):
        self.lw(1.1)
        self.rect(x, y, w, h, fill=0.82)
        self.lw(0.6)
        for i in range(1, cols):
            xx = x + w * i / cols
            self.line(xx, y, xx, y + h)
        for j in range(1, rows):
            yy = y + h * j / rows
            self.line(x, yy, x + w, yy)
        # glass reflection hatches
        self.lw(0.25, 0.45)
        for i in range(cols):
            for j in range(rows):
                cx = x + w * (i + 0.3) / cols
                cy = y + h * (j + 0.3) / rows
                self.line(cx, cy, cx + 0.25, cy + 0.25)
                self.line(cx + 0.1, cy - 0.05, cx + 0.4, cy + 0.25)
        self.lw(0.5)

    def door(self, x, w, h, leaves=2):
        self.lw(1.1)
        self.rect(x, 0, w, h, fill=0.8)
        self.lw(0.5)
        for i in range(1, leaves):
            self.line(x + w * i / leaves, 0, x + w * i / leaves, h)
        self.rect(x + 0.08, 0, w - 0.16, h - 0.08)
        self.line(x, h - 0.5, x + w, h - 0.5)  # transom

    def ground(self, x1=-3, x2=W + 3):
        self.lw(2.0)
        self.line(x1, 0, x2, 0)
        self.lw(0.3)
        for i in range(int((x2 - x1) / 0.4)):
            xx = x1 + i * 0.4
            self.line(xx, 0, xx - 0.3, -0.3)
        self.lw(0.5)

    def frame_and_title(self, title_he, title_en, sheet_no, sheet_total, drawing_no):
        c = self.c
        m = 28.35  # 10 mm margin
        c.setLineWidth(1.6); c.setStrokeGray(0)
        c.rect(m, m, PW - 2 * m, PH - 2 * m)
        c.setLineWidth(0.4)
        c.rect(m + 6, m + 6, PW - 2 * m - 12, PH - 2 * m - 12)
        # title block bottom-right (180 x 110 mm)
        bw, bh = 180 * M / 10, 110 * M / 10
        bx, by = PW - m - 6 - bw, m + 6
        c.setLineWidth(1.2)
        c.rect(bx, by, bw, bh)
        rows = [0, 22, 44, 66, 88, 110, 140, 175, 210, bh]
        c.setLineWidth(0.5)
        for r in rows[1:-1]:
            c.line(bx, by + r, bx + bw, by + r)
        c.line(bx + bw / 2, by, bx + bw / 2, by + 110)

        def cell(col, row, label, value, vsize=11):
            x = bx + 6 + col * bw / 2
            y = by + rows[row]
            c.setFont(FONT, 6.5); c.setFillGray(0.35)
            c.drawString(x, y + 14, label)
            c.setFillGray(0); c.setFont(FONTB, vsize)
            c.drawString(x, y + 4, value)

        cell(0, 0, "SHEET", f"{sheet_no} / {sheet_total}")
        cell(1, 0, "DRAWING NO.", drawing_no)
        cell(0, 1, "SCALE", "1:100")
        cell(1, 1, "PAPER", "A2  594 x 420 mm")
        cell(0, 2, "DATE", "2026-10-15")
        cell(1, 2, "REVISION", "B - for tender")
        cell(0, 3, "DRAWN", "R. Levi")
        cell(1, 3, "CHECKED", "M. Cohen")
        cell(0, 4, "UNITS", "metres")
        cell(1, 4, "STATUS", "DEMO / NOT FOR CONSTRUCTION", vsize=8)
        # drawing title
        c.setFont(FONT, 6.5); c.setFillGray(0.35)
        c.drawString(bx + 6, by + 110 + 22, "DRAWING TITLE")
        c.setFillGray(0); c.setFont(FONTB, 15)
        c.drawString(bx + 6, by + 116, title_en)
        c.setFont(FONTB, 15)
        c.drawRightString(bx + bw - 8, by + 116, title_he)
        # project
        c.setFont(FONT, 6.5); c.setFillGray(0.35)
        c.drawString(bx + 6, by + 140 + 26, "PROJECT")
        c.setFillGray(0); c.setFont(FONTB, 13)
        c.drawString(bx + 6, by + 148, "HADAR RESIDENCE - BUILDING 3")
        c.setFont(FONT, 9)
        c.drawRightString(bx + bw - 8, by + 148, heb("פרויקט הדר", ""))
        # client / office
        c.setFont(FONT, 6.5); c.setFillGray(0.35)
        c.drawString(bx + 6, by + 175 + 26, "ARCHITECT / ALUMINIUM CONSULTANT")
        c.setFillGray(0); c.setFont(FONT, 10)
        c.drawString(bx + 6, by + 182, "Demo Architects Studio  |  Facade & Aluminium Works")
        c.setFont(FONTB, 18)
        c.drawString(bx + 6, by + rows[8] + 14, "DEMO")
        c.setFont(FONT, 7)
        c.drawRightString(bx + bw - 8, by + rows[8] + 14, "Sample sheet for aluminium takeoff app")
        # scale bar (0-10 m at 1:100) bottom-left
        sx, sy = m + 40, m + 40
        c.setLineWidth(0.6)
        for i in range(5):
            c.setFillGray(0 if i % 2 == 0 else 1)
            c.rect(sx + i * 2 * M, sy, 2 * M, 6, stroke=1, fill=1)
        c.setFillGray(0); c.setFont(FONT, 8)
        for i in range(6):
            c.drawCentredString(sx + i * 2 * M, sy + 10, f"{i * 2}")
        c.drawString(sx + 10 * M + 8, sy, "m   SCALE 1:100")
        # north arrow
        nx, ny = PW - m - 70, PH - m - 80
        c.setLineWidth(0.8)
        c.circle(nx, ny, 22)
        p = c.beginPath(); p.moveTo(nx, ny + 20); p.lineTo(nx - 7, ny - 12); p.lineTo(nx, ny - 5); p.close()
        c.drawPath(p, fill=1)
        c.setFont(FONTB, 11); c.drawCentredString(nx, ny + 27, "N")

    def heading(self, he, en, sub):
        c = self.c
        x, y = P(W / 2, H + 4.2)
        c.setFont(FONTB, 22)
        c.drawCentredString(x, y + 22, he)
        c.setFont(FONTB, 16)
        c.drawCentredString(x, y, en)
        c.setLineWidth(1.0)
        c.line(x - 150, y - 6, x + 150, y - 6)
        c.setFont(FONT, 10)
        c.drawCentredString(x, y - 22, sub)


def common_frame(s, x_dir_labels):
    """Outline, floors, levels, grid, vertical dims, overall dims."""
    c = s.c
    # grid axes
    for x, lab in zip(AXES, x_dir_labels):
        s.axis_line(x, -3.9, H + 1.2)
        s.bubble(x, -4.4, lab)
        s.bubble(x, H + 1.7, lab)
    # building outline
    s.lw(2.2)
    s.rect(0, 0, W, H)
    # floor slab lines (slab edge band)
    s.lw(0.6)
    for k in range(1, 5):
        y = k * FLOOR
        s.line(0, y, W, y)
        s.line(0, y - 0.25, W, y - 0.25)
    # parapet coping
    s.lw(1.0)
    s.line(-0.1, H, W + 0.1, H)
    s.line(-0.1, H - 0.1, W + 0.1, H - 0.1)
    s.ground()
    # levels left
    s.level(-1.0, 0, "+-0.00  (+48.50 abs.)")
    for k in range(1, 5):
        s.level(-1.0, k * FLOOR, f"+{k * FLOOR:.2f}")
    s.level(-1.0, H, f"+{H:.2f}  TOP OF PARAPET")
    # vertical chain dims right
    for k in range(4):
        s.vdim(k * FLOOR, (k + 1) * FLOOR, W + 1.4, ext_from=W)
    s.vdim(4 * FLOOR, H, W + 1.4, ext_from=W)
    s.vdim(0, H, W + 2.6, ext_from=W)
    # axis chain + overall bottom
    for a, b in zip(AXES, AXES[1:]):
        s.hdim(a, b, -2.2, ext_from=0)
    s.hdim(0, W, -3.2, label="24.00", ext_from=0)


def page_south(c):
    s = Sheet(c)
    common_frame(s, ["A", "B", "C", "D", "E"])
    # curtain wall (aluminium) floors 1-3 between x=10.0 and 14.0, + entrance below
    cw_x, cw_w = 10.0, 4.0
    s.curtain_wall(cw_x, FLOOR, cw_w, H - FLOOR - 0.6, cols=4, rows=6)
    # entrance: door 2.4 x 2.6 centred on axis C with glazed side lights
    s.lw(1.0)
    s.rect(cw_x, 0, cw_w, FLOOR - 0.25, fill=0.9)
    s.door(12.0 - 1.2, 2.4, 2.6)
    s.lw(0.6)
    s.line(cw_x, 2.6, cw_x + cw_w, 2.6)
    # canopy
    s.lw(1.2)
    s.rect(cw_x - 0.6, 2.75, cw_w + 1.2, 0.2, fill=0.6)
    # windows: per floor, bays without curtain wall
    xs = [1.0, 3.5, 6.75, 15.75, 19.0, 21.5]
    for k in range(4):
        base = k * FLOOR + 0.9
        for x in xs:
            if k == 0 and x in (6.75, 15.75):
                continue
            s.window(x, base)
    # ground floor shopfront windows next to entrance
    s.window(6.3, 0.6, w=2.4, h=2.0)
    s.window(15.3, 0.6, w=2.4, h=2.0)
    # balcony railings on floors 2-4 (bays A-B and D-E)
    s.lw(0.5)
    for k in range(1, 4):
        y = k * FLOOR
        for x0 in (0.6, 18.6):
            s.rect(x0, y, 4.8, 1.05)
            for i in range(1, 24):
                s.line(x0 + i * 0.2, y, x0 + i * 0.2, y + 1.05)
    # chain dim row 1: 10.00 calibration reference + curtain wall + remainder
    s.hdim(0, 10.0, -1.2, label="10.00", ext_from=0)
    s.hdim(10.0, 14.0, -1.2, ext_from=0)
    s.hdim(14.0, 18.0, -1.2, ext_from=0)
    s.hdim(18.0, W, -1.2, ext_from=0)
    # door/window dims and tags
    s.vdim(0, 2.6, 9.4, label="2.60")
    tag(s, 1.75, 2.75, "W1")
    tag(s, 12.0, 0.4, "D1")
    tag(s, 12.0, 8.0, "CW-1")
    # notes / legend
    notes(c, [
        "W1  Aluminium window 1.50 x 1.40, sill +0.90 above slab, thermal-break profile, RAL 7016",
        "D1  Entrance door, double leaf 2.40 x 2.60, aluminium + laminated glass 6.6.2",
        "CW-1  Stick curtain wall 4.00 x 9.40, mullions 50x150 @ 1.00, transoms @ 1.57",
        "Balcony railings: aluminium vertical balusters @ 0.20, h=1.05",
        "All dimensions in metres. Check on site before fabrication.",
    ])
    s.heading(heb("חזית דרומית", "SOUTH ELEVATION"), "SOUTH ELEVATION", "SCALE 1:100")
    s.frame_and_title(heb("חזית דרומית", ""), "SOUTH ELEVATION", 1, 3, "A-301")


def page_north(c):
    s = Sheet(c)
    common_frame(s, ["E", "D", "C", "B", "A"])
    # stair-core curtain wall full height at x 2.0-5.0
    s.curtain_wall(2.0, 0.0, 3.0, H - 0.6, cols=3, rows=9)
    # service door at ground
    s.door(16.5, 1.2, 2.2, leaves=1)
    s.door(20.0, 3.0, 3.0 - 0.25, leaves=2)  # refuse room / garage door
    # ribbon windows floors 1-3, 7.0 to 22.5
    for k in range(1, 4):
        y = k * FLOOR + 1.0
        x = 7.0
        while x + 1.5 <= 22.6:
            s.window(x, y, 1.5, 1.2)
            x += 1.55
    # ground floor small windows
    for x in (7.5, 10.5, 13.5):
        s.window(x, 1.4, 1.2, 0.8, split=False)
    # roof plant screen
    s.lw(0.6)
    s.rect(8.0, H, 8.0, 1.6)
    for i in range(1, 40):
        s.line(8.0 + i * 0.2, H, 8.0 + i * 0.2, H + 1.6)
    s.text(16.3, H + 0.6, "PLANT SCREEN (AL. LOUVRES)", size=8, anchor="start")
    s.hdim(0, 2.0, -1.2, ext_from=0)
    s.hdim(2.0, 5.0, -1.2, ext_from=0)
    s.hdim(5.0, 7.0, -1.2, ext_from=0)
    s.hdim(7.0, 22.5, -1.2, ext_from=0)
    s.hdim(22.5, W, -1.2, ext_from=0)
    tag(s, 3.5, 6.5, "CW-2")
    tag(s, 9.0, 6.6, "W2")
    tag(s, 17.1, 2.6, "D2")
    tag(s, 21.5, 3.15, "D3")
    notes(c, [
        "CW-2  Stair core curtain wall 3.00 x 13.40, full height, mullions @ 1.00",
        "W2  Ribbon window module 1.50 x 1.20, fixed + tilt/turn alternating",
        "D2  Service door 1.20 x 2.20, aluminium insulated panel",
        "D3  Refuse room double door 3.00 x 2.95, louvred aluminium",
        "All dimensions in metres. Check on site before fabrication.",
    ])
    s.heading(heb("חזית צפונית", "NORTH ELEVATION"), "NORTH ELEVATION", "SCALE 1:100")
    s.frame_and_title(heb("חזית צפונית", ""), "NORTH ELEVATION", 2, 3, "A-302")


def page_plan(c):
    s = Sheet(c)
    D = 14.0  # plan depth
    yb = 0.0
    for x, lab in zip(AXES, "ABCDE"):
        s.axis_line(x, -3.9, D + 1.2)
        s.bubble(x, -4.4, lab)
        s.bubble(x, D + 1.7, lab)
    for y, lab in zip([0, 7, 14], "123"):
        s.lw(0.35, 0.35); c.setDash([10, 3, 2, 3]); s.line(-1.5, y, W + 1.5, y); c.setDash()
        s.bubble(-2.1, y, lab)
    # exterior walls 0.3 thick
    s.lw(1.0)
    s.rect(0, 0, W, D, fill=0.35)
    s.rect(0.3, 0.3, W - 0.6, D - 0.6, fill=1)
    # interior walls
    s.lw(0.8)
    for (x1, y1, x2, y2) in [(10, 0.3, 10, 9), (14, 0.3, 14, 9), (0.3, 9, 23.7, 9),
                             (5, 9, 5, 13.7), (18, 9, 18, 13.7), (6, 0.3, 6, 9), (18, 0.3, 18, 9)]:
        if x1 == x2:
            s.rect(x1 - 0.1, y1, 0.2, y2 - y1, fill=0.5)
        else:
            s.rect(x1, y1 - 0.1, x2 - x1, 0.2, fill=0.5)
    # openings in south wall (windows / entrance), drawn as breaks
    for (x, w) in [(1.0, 1.5), (3.5, 1.5), (6.3, 2.4), (10.0, 4.0), (15.3, 2.4), (19.0, 1.5), (21.5, 1.5)]:
        s.lw(0.5)
        s.rect(x, 0, w, 0.3, fill=1)
        s.line(x, 0.15, x + w, 0.15)
    # stair
    s.lw(0.5)
    s.rect(2.0, 9.5, 2.6, 4.0)
    for i in range(1, 14):
        s.line(2.0, 9.5 + i * 0.3, 4.6, 9.5 + i * 0.3)
    labels = [(3.0, 4.5, "SHOP 1"), (8.0, 4.5, "SHOP 2"), (12.0, 5.0, "LOBBY"),
              (16.0, 4.5, "SHOP 3"), (21.0, 4.5, "SHOP 4"), (3.3, 8.2, "STAIR"),
              (11.5, 11.5, "CORRIDOR / SERVICES"), (21.0, 11.5, "REFUSE")]
    for x, y, t in labels:
        s.text(x, y, t, size=10, font=FONTB)
    for a, b in zip(AXES, AXES[1:]):
        s.hdim(a, b, -2.2, ext_from=0)
    s.hdim(0, W, -3.2, label="24.00", ext_from=0)
    s.vdim(0, 7, W + 1.4, ext_from=W)
    s.vdim(7, 14, W + 1.4, ext_from=W)
    s.vdim(0, 14, W + 2.6, ext_from=W)
    s.heading(heb("תוכנית קומת קרקע", "GROUND FLOOR PLAN"), "GROUND FLOOR PLAN", "SCALE 1:100")
    s.frame_and_title(heb("תוכנית קרקע", ""), "GROUND FLOOR PLAN", 3, 3, "A-101")


def tag(s, x, y, label):
    px, py = P(x, y)
    c = s.c
    c.setLineWidth(0.6)
    w = c.stringWidth(label, FONTB, 9) + 10
    c.setFillGray(1)
    c.roundRect(px - w / 2, py - 7, w, 14, 6, stroke=1, fill=1)
    c.setFillGray(0)
    c.setFont(FONTB, 9)
    c.drawCentredString(px, py - 3, label)


def notes(c, lines):
    x, y = 60, PH - 80
    c.setFont(FONTB, 11)
    c.drawString(x, y, "NOTES / LEGEND")
    c.setFont(FONT, 8.5)
    for i, ln in enumerate(lines):
        c.drawString(x, y - 16 - i * 13, ln)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    c = canvas.Canvas(OUT, pagesize=(PW, PH), pageCompression=1)
    c.setTitle("Demo facade drawings - Hadar Residence (1:100)")
    c.setAuthor("aluminum-app demo")
    for fn in (page_south, page_north, page_plan):
        fn(c)
        c.showPage()
    c.save()
    print("wrote", os.path.abspath(OUT), os.path.getsize(OUT), "bytes")
    # Coordinates for scripted tests (viewport top-left origin, PDF points)
    def tl(x, y):
        px, py = P(x, y)
        return round(px, 2), round(PH - py, 2)
    print("page size", round(PW, 2), round(PH, 2))
    print("calibration 10.00 line ends:", tl(0, -1.2), tl(10, -1.2), "len", round(10 * M, 2))
    print("outline TL,TR,BR,BL:", tl(0, H), tl(W, H), tl(W, 0), tl(0, 0))


if __name__ == "__main__":
    main()

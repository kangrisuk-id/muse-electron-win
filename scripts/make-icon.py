#!/usr/bin/env python3
"""Stage 8 — generate the app icon: gold-on-charcoal "M" monogram.

Deterministic vector-style drawing with PIL (no AI image, no external
assets): a rounded charcoal tile, a bold gold M drawn as strokes, and
a four-point spark at the upper right — the Muse spark. Outputs:
  build/icon.png  1024x1024 master (electron-builder + window icon)
  build/icon.ico  multi-size Windows icon (16..256)
Re-run any time: python3 scripts/make-icon.py
"""
from PIL import Image, ImageDraw

SIZE = 1024
CHARCOAL = (24, 24, 28, 255)
CHARCOAL_EDGE = (52, 50, 44, 255)
GOLD = (216, 178, 62, 255)
GOLD_DEEP = (172, 136, 38, 255)
CREAM = (246, 236, 205, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded tile with a subtle gold rim.
margin = 40
radius = 210
d.rounded_rectangle([margin, margin, SIZE - margin, SIZE - margin],
                    radius=radius, fill=CHARCOAL, outline=CHARCOAL_EDGE, width=6)
rim = 58
d.rounded_rectangle([rim, rim, SIZE - rim, SIZE - rim],
                    radius=radius - 18, outline=GOLD_DEEP, width=5)

# Bold M drawn as strokes (polylines with round joints).
# Baseline y=700, cap height y=330, outer x 268..700.
stroke = 92
left_x, right_x, top_y, base_y = 268, 700, 330, 700
mid_x, mid_y = (left_x + right_x) // 2, 545
d.line([(left_x, base_y), (left_x, top_y)], fill=GOLD, width=stroke)
d.line([(right_x, base_y), (right_x, top_y)], fill=GOLD, width=stroke)
d.line([(left_x, top_y), (mid_x, mid_y)], fill=GOLD, width=stroke)
d.line([(mid_x, mid_y), (right_x, top_y)], fill=GOLD, width=stroke)
for (x, y) in [(left_x, base_y), (left_x, top_y), (right_x, base_y),
               (right_x, top_y), (mid_x, mid_y)]:
    r = stroke // 2
    d.ellipse([x - r, y - r, x + r, y + r], fill=GOLD)

# Four-point spark (star) at upper right.
cx, cy, R, r2 = 790, 262, 118, 34
pts = []
import math
for i in range(8):
    ang = math.pi / 2 * (i // 2) + (math.pi / 4 if i % 2 else 0)
    rad = R if i % 2 == 0 else r2
    # Classic 4-point sparkle: alternate long/short on the axes/diagonals
    a = -math.pi / 2 + i * math.pi / 4
    rad = R if i % 2 == 0 else r2
    pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
d.polygon(pts, fill=CREAM)

img.save("build/icon.png")
img.save("build/icon.ico",
         sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                (64, 64), (128, 128), (256, 256)])
print("wrote build/icon.png and build/icon.ico")

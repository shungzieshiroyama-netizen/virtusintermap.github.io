#!/usr/bin/env python3
"""Split the Rosebridge master map into a 3x3 sector grid + moderate overview.

Reads   maps/rosebridge.jpg           (11776x11264 master, full detail)
Writes  maps/rosebridge_overview.jpg  (2944x2816, moderate quality whole map)
        maps/rosebridge_menu.jpg      (1100 px wide, used by the menu sector grid)
        maps/sectors/rosebridge_<a1..c3>.jpg   (native-resolution crops)
        maps/sectors/thumb_<a1..c3>.jpg        (480 px card thumbnails)

Sector boxes (integer master-pixel bounds; rows x cols = 3 x 3):
  cols x0: 0, 3925, 7851   (widths  3925, 3926, 3925)
  rows y0: 0, 3754, 7509   (heights 3754, 3755, 3755)
A point (x, y) on the old master maps to sector local coords (x - x0, y - y0).

Re-run after any re-render of the master.
"""
import os
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'maps', 'rosebridge.jpg')
OUTD = os.path.join(ROOT, 'maps', 'sectors')

COLS = [0, 3925, 7851]
ROWS = [0, 3754, 7509]
WS = [3925, 3926, 3925]
HS = [3754, 3755, 3755]
RNAME = 'abc'

im = Image.open(SRC)
W, H = im.size
assert (W, H) == (11776, 11264), f'unexpected master size {im.size}'

os.makedirs(OUTD, exist_ok=True)

# moderate-quality whole-map overview (quarter resolution)
im.resize((W // 4, H // 4), Image.LANCZOS).save(
    os.path.join(ROOT, 'maps', 'rosebridge_overview.jpg'), quality=80, progressive=True)

# menu grid image
im.resize((1100, round(H * 1100 / W)), Image.LANCZOS).save(
    os.path.join(ROOT, 'maps', 'rosebridge_menu.jpg'), quality=82, progressive=True)

# sector crops at native resolution + card thumbnails
for r, ry in enumerate(ROWS):
    for c, cx in enumerate(COLS):
        name = f'{RNAME[r]}{c + 1}'
        box = (cx, ry, cx + WS[c], ry + HS[r])
        crop = im.crop(box)
        crop.save(os.path.join(OUTD, f'rosebridge_{name}.jpg'), quality=84, progressive=True)
        crop.resize((480, round(HS[r] * 480 / WS[c])), Image.LANCZOS).save(
            os.path.join(OUTD, f'thumb_{name}.jpg'), quality=80, progressive=True)
        print('sector', name, box)
print('done')

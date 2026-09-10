#!/usr/bin/env python3
"""Build the slippy-map tile pyramid for the Rosebridge map.

Reads  maps/rosebridge.jpg   (11776x11264 — the full-resolution master)
Writes maps/rosebridge_tiles/l{L}/{x}_{y}.jpg for L in 0..4

Level L is the master image downscaled by 2^L, cut into 512 px tiles.
Level dims are exact halves: 11776x11264, 5888x5632, 2944x2816,
1472x1408, 736x704. Edge tiles are padded with deep-water colour
(the only padding strips fall outside the world's south/east bounds,
which are sea in this map).

Re-run after any re-render of maps/rosebridge.jpg, e.g.:
    python3 tools/build_tiles.py
"""
import math
import os
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'maps', 'rosebridge.jpg')
OUT = os.path.join(ROOT, 'maps', 'rosebridge_tiles')
TILE = 512
LEVELS = 5
PAD = (16, 24, 21)          # deep-water colour used by the map style

im = Image.open(SRC)
W, H = im.size
total = 0
for lv in range(LEVELS):
    cur = im if lv == 0 else im.resize((W >> lv, H >> lv), Image.LANCZOS)
    w, h = cur.size
    cols, rows = math.ceil(w / TILE), math.ceil(h / TILE)
    od = os.path.join(OUT, f'l{lv}')
    os.makedirs(od, exist_ok=True)
    n = 0
    for ty in range(rows):
        for tx in range(cols):
            t = Image.new('RGB', (TILE, TILE), PAD)
            box = (tx * TILE, ty * TILE, min((tx + 1) * TILE, w), min((ty + 1) * TILE, h))
            t.paste(cur.crop(box), (0, 0))
            t.save(os.path.join(od, f'{tx}_{ty}.jpg'), quality=82, progressive=True)
            n += 1
    print(f'level {lv}: {w}x{h} -> {cols}x{rows} = {n} tiles')
    total += n
print('total tiles:', total)

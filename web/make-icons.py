#!/usr/bin/env python3
"""Regenerate the app icons next to this script.

    python3 web/make-icons.py

The icons are the favicon at `web/index.html`'s <link rel="icon"> drawn large: a rounded square in
--bg with a --blue disc on it. Deliberately not `logo.svg` — that mark is a detailed sheep on a
light ground, and the place these icons are actually read is a Lock Screen notification at about
40 points, where the detail turns to mush and the light ground fights every wallpaper. A disc
survives that size, and it is already the app's identity in a browser tab.

Stdlib only, and it writes the PNGs by hand: the alternative is a rasterizer dependency for four
files that change roughly never. Drawing is supersampled 4x and box-filtered down, which is what
keeps the circle's edge and the corner radius smooth at 180px.
"""

import struct
import zlib
from pathlib import Path

BG = (0x1A, 0x1B, 0x26)
FG = (0x7A, 0xA2, 0xF7)
SS = 4  # supersampling factor


def coverage(size):
    """Alpha 0..1 per pixel for the disc, and for the rounded square, at `size` px."""
    n = size * SS
    radius = n * 0.5 * 0.56          # disc, matching the favicon's r=4.5 on a 16-box
    corner = n * (4 / 16)            # rounded-square radius, matching the favicon's rx=4
    cx = cy = (n - 1) / 2.0
    disc = [[0.0] * size for _ in range(size)]
    square = [[0.0] * size for _ in range(size)]
    for sy in range(n):
        y = sy + 0.5
        for sx in range(n):
            x = sx + 0.5
            if (x - cx - 0.5) ** 2 + (y - cy - 0.5) ** 2 <= radius * radius:
                disc[sy // SS][sx // SS] += 1
            # Inside the rounded square unless past a corner arc's centre in both axes.
            dx = corner - x if x < corner else (x - (n - corner) if x > n - corner else 0.0)
            dy = corner - y if y < corner else (y - (n - corner) if y > n - corner else 0.0)
            if dx * dx + dy * dy <= corner * corner:
                square[sy // SS][sx // SS] += 1
    per = float(SS * SS)
    return ([[v / per for v in row] for row in disc],
            [[v / per for v in row] for row in square])


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size, opaque):
    """RGBA PNG. `opaque` squares off the corners — iOS masks the icon itself and a transparent
    corner there shows as a dark notch inside Apple's own rounding."""
    disc, square = coverage(size)
    raw = bytearray()
    for y in range(size):
        raw.append(0)   # filter type 0, this is small enough that filtering buys nothing
        for x in range(size):
            t = disc[y][x]
            px = tuple(round(BG[i] * (1 - t) + FG[i] * t) for i in range(3))
            alpha = 255 if opaque else round(square[y][x] * 255)
            raw += bytes(px) + bytes([alpha])
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)
    print(f"{path.name}: {size}x{size}, {len(png)} bytes")


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    # iOS ignores the manifest for the Home Screen icon and takes apple-touch-icon, which it
    # renders on its own rounded rect — hence opaque. The manifest pair keeps its own corners.
    write_png(here / "apple-touch-icon.png", 180, opaque=True)
    write_png(here / "icon-192.png", 192, opaque=False)
    write_png(here / "icon-512.png", 512, opaque=False)

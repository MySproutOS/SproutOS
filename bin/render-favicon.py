"""Render the SproutOS mark to a 32x32 PNG, with no image library available.

macOS has no rasteriser this repository can rely on — no ImageMagick, no rsvg, no Pillow — and
`qlmanage` renders an SVG as a *document thumbnail*, which is why the first attempt produced a
blank white page and a favicon that looked like an empty box.

So the mark is drawn directly: supersampled 8x and box-filtered down, which is where the smooth
edges come from. It is a simplified `SproutMark` rather than a trace of its bezier paths — at 16
physical pixels the curves are three pixels wide and the difference is invisible, while the
difference between "a sprout" and "a white square" is the entire point.
"""
import math, struct, zlib

S = 8            # supersample factor
N = 32           # final size
W = N * S

SOIL = (0x11, 0x1f, 0x18)
LEAF = (0x5e, 0xe3, 0x9a)

buf = [[(0, 0, 0, 0)] * W for _ in range(W)]


def put(x, y, rgb, a):
    if 0 <= x < W and 0 <= y < W and a > 0:
        r, g, b, oa = buf[y][x]
        # Simple source-over in 8-bit; everything here is opaque or fully transparent at this scale.
        na = max(oa, a)
        buf[y][x] = (rgb[0], rgb[1], rgb[2], na) if a >= oa else (r, g, b, na)


def rounded_rect(x0, y0, x1, y1, radius, rgb):
    for y in range(int(y0), int(y1)):
        for x in range(int(x0), int(x1)):
            cx = min(max(x, x0 + radius), x1 - radius)
            cy = min(max(y, y0 + radius), y1 - radius)
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius:
                put(x, y, rgb, 255)


def capsule(ax, ay, bx, by, width, rgb):
    """A line segment with round caps — what `stroke-linecap="round"` draws."""
    half = width / 2
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    lo_x, hi_x = int(min(ax, bx) - width), int(max(ax, bx) + width)
    lo_y, hi_y = int(min(ay, by) - width), int(max(ay, by) + width)
    for y in range(lo_y, hi_y + 1):
        for x in range(lo_x, hi_x + 1):
            t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / length2))
            px, py = ax + t * dx, ay + t * dy
            if (x - px) ** 2 + (y - py) ** 2 <= half * half:
                put(x, y, rgb, 255)


def leaf(cx, cy, rx, ry, angle, rgb):
    """An ellipse rotated about its centre. Two of these are the sprout's leaves."""
    ca, sa = math.cos(angle), math.sin(angle)
    reach = int(max(rx, ry) + 2)
    for y in range(int(cy - reach), int(cy + reach) + 1):
        for x in range(int(cx - reach), int(cx + reach) + 1):
            dx, dy = x - cx, y - cy
            u = dx * ca + dy * sa
            v = -dx * sa + dy * ca
            if (u / rx) ** 2 + (v / ry) ** 2 <= 1.0:
                put(x, y, rgb, 255)


u = W / 24.0  # the mark's own 24-unit coordinate system

rounded_rect(0, 0, W, W, 5 * u, SOIL)
# Ground line, dimmer than the plant, as `stroke-opacity="0.45"` in the component.
capsule(4.5 * u, 20.6 * u, 19.5 * u, 20.6 * u, 1.9 * u, (0x2c, 0x6b, 0x4c))
# Stem.
capsule(12 * u, 20.6 * u, 12 * u, 12.4 * u, 1.9 * u, LEAF)
# Two leaves, left lower and right upper, as in `SproutMark`.
leaf(8.8 * u, 10.2 * u, 4.0 * u, 2.3 * u, math.radians(28), LEAF)
leaf(15.4 * u, 9.0 * u, 4.2 * u, 2.4 * u, math.radians(-30), LEAF)

# Box-filter down to 32x32. This is the anti-aliasing.
out = bytearray()
for y in range(N):
    out.append(0)  # PNG filter type 0 for the row
    for x in range(N):
        r = g = b = a = 0
        for sy in range(S):
            for sx in range(S):
                pr, pg, pb, pa = buf[y * S + sy][x * S + sx]
                r += pr * pa; g += pg * pa; b += pb * pa; a += pa
        if a == 0:
            out += bytes((0, 0, 0, 0))
        else:
            n = S * S
            out += bytes((r // a, g // a, b // a, a // n))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(bytes(out), 9))
    + chunk(b"IEND", b"")
)

open("/tmp/icon32.png", "wb").write(png)
# PNG embedded verbatim in an ICO — understood by every browser since IE11, and it avoids needing
# a BMP encoder for a single image at a single size.
ico = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", N, N, 0, 0, 1, 32, len(png), 22) + png
open("apps/website/src/app/favicon.ico", "wb").write(ico)
print("wrote", len(ico), "bytes")

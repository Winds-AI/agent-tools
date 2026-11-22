"""Draws the sky: the real summer Milky Way from Scorpius to Cygnus, as dithered pixels.

Star positions, magnitudes and colours, constellation figures and the Milky Way
outline come from the d3-celestial data set (BSD-3-Clause, github.com/ofrohn/d3-celestial).
"""
import base64
import io
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

DATA = Path(__file__).parent / "data"
RAD = math.pi / 180

W, H = 400, 200
SS = 2  # supersample for the glow

# Similarity transform is solved from two anchors (raster px): galactic centre and Deneb.
CENTRE = (286.0, 6.0)  # RA, Dec of the tangent point (Aquila)
ANCHOR_A = ((266.405, -28.936), (338, 165))  # galactic centre
ANCHOR_B = ((310.358, 45.280), (122, 65))  # Deneb

PALETTE_HEX = [
    "#000000",  # 0 space
    "#04060e",  # 1
    "#0a0f22",  # 2
    "#111a3a",  # 3
    "#1b2854",  # 4
    "#2a3b74",  # 5
    "#40569a",  # 6
    "#6f86c8",  # 7 haze
    "#a9bdf0",  # 8 bright haze
    "#2a1a16",  # 9 dust brown
    "#5a3420",  # 10 warm dark
    "#a0623a",  # 11 amber dark
    "#e0a060",  # 12 amber
    "#ffdca8",  # 13 cream
    "#f6f8ff",  # 14 white
    "#ff9a5a",  # 15 orange star
    "#b04a7a",  # 16 nebula rose
    "#ff86b4",  # 17 nebula pink
    "#aac6ff",  # 18 ice star
    "#55608c",  # 19 dim star
    "#27325c",  # 20 figure line
    "#33293c",  # 21 dusk mauve
    "#6c5a6c",  # 22 mauve
]
PALETTE = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in PALETTE_HEX], float)
GLOW_COLOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 21, 22]

BAYER_8 = np.array([
    [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
]) / 64 - 0.5


def unit(ra, dec):
    ra, dec = np.asarray(ra) * RAD, np.asarray(dec) * RAD
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], -1)


C = unit(*CENTRE)
EAST = np.cross([0, 0, 1.0], C)
EAST /= np.linalg.norm(EAST)
NORTH = np.cross(C, EAST)


def tangent(ra, dec):
    """Stereographic plane as seen from inside the sphere: east is left, north is up."""
    p = unit(ra, dec)
    z = p @ C
    k = 2 / (1 + z)
    return -k * (p @ EAST), -k * (p @ NORTH), z


def solve_view():
    (a_sky, a_px), (b_sky, b_px) = ANCHOR_A, ANCHOR_B
    ax, ay, _ = tangent(*a_sky)
    bx, by, _ = tangent(*b_sky)
    src = complex(bx - ax, by - ay)
    dst = complex(b_px[0] - a_px[0], b_px[1] - a_px[1])
    m = dst / src
    t = complex(*a_px) - m * complex(ax, ay)
    return m, t


M, T = solve_view()


def project(ra, dec):
    x, y, z = tangent(ra, dec)
    q = M * (np.asarray(x) + 1j * np.asarray(y)) + T
    return q.real, q.imag, z


def unproject(px, py):
    q = ((px + 1j * py) - T) / M
    x, y = -q.real, -q.imag
    rho = np.hypot(x, y) + 1e-12
    c = 2 * np.arctan(rho / 2)
    p = np.cos(c)[..., None] * C + (np.sin(c) / rho)[..., None] * (x[..., None] * EAST + y[..., None] * NORTH)
    return p


def milky_way_map():
    """Equirectangular RA/Dec brightness map (4 px per degree) from the isophote polygons."""
    scale = 4
    size = (360 * scale, 180 * scale)
    total = np.zeros((size[1], size[0]), float)
    weights = {"ol1": 0.16, "ol2": 0.2, "ol3": 0.22, "ol4": 0.22, "ol5": 0.2}
    for feature in json.loads((DATA / "mw.json").read_text())["features"]:
        layer = Image.new("L", size, 0)
        draw = ImageDraw.Draw(layer)
        for polygon in feature["geometry"]["coordinates"]:
            for ring in polygon:
                lon = np.unwrap(np.array([p[0] for p in ring]) * RAD) / RAD
                lat = np.array([p[1] for p in ring])
                for shift in (-360, 0, 360):
                    pts = [((x + shift + 180) * scale, (90 - y) * scale) for x, y in zip(lon, lat)]
                    draw.polygon(pts, fill=255)
        total += weights[feature["id"]] * np.asarray(layer, float) / 255
    return total, scale


def noise(shape, cells, rng):
    small = rng.random((max(2, int(shape[0] / cells) + 2), max(2, int(shape[1] / cells) + 2)))
    img = Image.fromarray((small * 255).astype(np.uint8)).resize((shape[1], shape[0]), Image.BICUBIC)
    return np.asarray(img, float) / 255


def fractal(shape, rng, base=90, octaves=5):
    out, amp, norm = np.zeros(shape), 1.0, 0.0
    for i in range(octaves):
        out += amp * noise(shape, base / 2 ** i, rng)
        norm += amp
        amp *= 0.55
    return out / norm


def blur(a, radius):
    img = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius))
    return np.asarray(img, float) / 255


NEBULAE = [  # RA, Dec, radius deg, strength
    (270.9, -24.0, 0.9, 0.9),   # Lagoon and Trifid
    (275.0, -15.2, 0.8, 0.7),   # Omega and Eagle
    (261.0, -35.0, 0.8, 0.6),   # Cat's Paw, NGC 6357
    (314.2, 44.2, 1.0, 0.8),    # North America
    (305.5, 40.3, 0.8, 0.6),    # Sadr region
]

NGP = unit(192.85948, 27.12825)
GC = unit(266.405, -28.936)
GY = np.cross(NGP, GC)


def paint_glow(seed):
    rng = np.random.default_rng(seed)
    hh, ww = H * SS, W * SS
    ys, xs = np.mgrid[0:hh, 0:ww]
    p = unproject((xs + 0.5) / SS, (ys + 0.5) / SS)
    ra = np.degrees(np.arctan2(p[..., 1], p[..., 0])) % 360
    dec = np.degrees(np.arcsin(np.clip(p[..., 2], -1, 1)))
    gb = np.degrees(np.arcsin(np.clip(p @ NGP, -1, 1)))
    gl = np.degrees(np.arctan2(p @ GY, p @ GC))

    mw, scale = milky_way_map()
    mw = blur(mw, 3)
    lon = np.where(ra > 180, ra - 360, ra)
    u = ((lon + 180) * scale).astype(int) % mw.shape[1]
    v = np.clip(((90 - dec) * scale).astype(int), 0, mw.shape[0] - 1)
    iso = blur(mw[v, u], 1.2 * SS)

    cloud = fractal((hh, ww), rng, base=60 * SS)
    fine = fractal((hh, ww), rng, base=14 * SS, octaves=3)
    ridge = np.abs(fractal((hh, ww), rng, base=34 * SS, octaves=4) - 0.5) * 2
    wiggle = (fractal((hh, ww), rng, base=50 * SS, octaves=3) - 0.5) * 9

    toward_core = np.exp(-(gl / 75.0) ** 2)
    disc = np.exp(-(np.abs(gb) / (5.5 + 5.0 * toward_core)) ** 1.6) * (0.3 + 0.7 * toward_core)
    bulge = np.exp(-((gl / 13.0) ** 2 + ((gb + 1.5) / 9.0) ** 2))

    light = 0.55 * disc + 0.75 * iso ** 1.2 + 0.42 * bulge
    light *= 0.5 + 1.0 * cloud
    light *= 0.8 + 0.4 * fine

    rift = np.exp(-((gb - 2.2 - wiggle) / (1.5 + 2.2 * cloud)) ** 2) * np.clip((gl + 12) / 20, 0, 1) * np.exp(-(gl / 95.0) ** 2)
    veins = np.clip(1 - ridge * 4.0, 0, 1) * np.clip(disc * 1.6, 0, 1)
    light *= (1 - 0.82 * rift) * (1 - 0.6 * veins)
    light = 1 - np.exp(-light * 1.5)  # soft knee

    warm = np.clip(np.exp(-((gl / np.where(gl < 0, 44.0, 30.0)) ** 2 + (gb / 20.0) ** 2)) * 1.1, 0, 1) ** 1.4

    cool = np.array([[0, 0, 0], [7, 11, 28], [20, 31, 72], [46, 66, 140], [104, 128, 204], [176, 194, 246]], float)
    hot = np.array([[0, 0, 0], [22, 15, 20], [64, 42, 38], [136, 96, 72], [208, 166, 124], [250, 230, 200]], float)

    def ramp(stops, t):
        f = np.clip(t, 0, 1) * (len(stops) - 1)
        i = np.clip(f.astype(int), 0, len(stops) - 2)
        return stops[i] + (stops[i + 1] - stops[i]) * (f - i)[..., None]

    img = ramp(cool, light) * (1 - warm[..., None]) + ramp(hot, light) * warm[..., None]

    floor = fractal((hh, ww), rng, base=110 * SS, octaves=2)
    img = np.maximum(img, np.array([4.0, 6.0, 14.0]) * (1 + 2.2 * np.clip(floor - 0.62, 0, 1))[..., None])

    nebula = np.zeros((hh, ww))
    for n_ra, n_dec, radius, strength in NEBULAE:
        d = np.degrees(np.arccos(np.clip(p @ unit(n_ra, n_dec), -1, 1)))
        nebula = np.maximum(nebula, np.exp(-(d / radius) ** 2) * strength * (0.6 + 0.8 * fine))

    for (n_ra, n_dec, radius, rgb, k) in [(246.4, -23.4, 1.3, (96, 140, 255), 0.5), (247.35, -26.43, 1.2, (255, 180, 90), 0.45)]:
        d = np.degrees(np.arccos(np.clip(p @ unit(n_ra, n_dec), -1, 1)))
        glow = np.exp(-(d / radius) ** 2) * k
        img = img * (1 - 0.6 * glow[..., None]) + np.array(rgb, float) * glow[..., None]

    return img.reshape(H, SS, W, SS, 3).mean(axis=(1, 3)), nebula.reshape(H, SS, W, SS).mean(axis=(1, 3))


def dither(img, strength=38):
    threshold = np.tile(BAYER_8, (H // 8 + 1, W // 8 + 1))[:H, :W]
    jittered = img + threshold[..., None] * strength
    sub = PALETTE[GLOW_COLOURS]
    nearest = ((jittered[:, :, None, :] - sub[None, None]) ** 2).sum(-1).argmin(-1)
    return np.array(GLOW_COLOURS, np.uint8)[nearest]


def star_colour(bv):
    if bv < 0.05:
        return 18
    if bv < 0.75:
        return 14
    if bv < 1.25:
        return 13
    return 15


def put(indices, x, y, value, only_dark=False):
    if 0 <= x < W and 0 <= y < H:
        if only_dark and indices[y, x] in (14, 13, 15, 18):
            return
        indices[y, x] = value


def draw_figures(indices, glow, skip=()):
    lines = json.loads((DATA / "constellations.lines.json").read_text())["features"]
    for feature in lines:
        if feature["id"] in skip:
            continue
        for path in feature["geometry"]["coordinates"]:
            for (ra0, dec0), (ra1, dec1) in zip(path, path[1:]):
                x0, y0, z0 = project(ra0, dec0)
                x1, y1, z1 = project(ra1, dec1)
                if min(z0, z1) < 0.2:
                    continue
                length = math.hypot(x1 - x0, y1 - y0)
                if length < 5:
                    continue
                steps = int(length)
                for i in range(steps + 1):
                    d = i  # distance from start in px
                    if d < 2.6 or length - d < 2.6:
                        continue
                    t = d / length
                    x, y = round(float(x0 + (x1 - x0) * t)), round(float(y0 + (y1 - y0) * t))
                    if (x + y) % 2:
                        continue
                    if 0 <= x < W and 0 <= y < H:
                        r, g, b = glow[y, x]
                        bright = r + g + b
                        indices[y, x] = 20 if bright < 130 else (7 if b > r else 12 if bright < 420 else 11)


def draw_stars(indices, seed):
    rng = np.random.default_rng(seed)
    stars = json.loads((DATA / "stars.6.json").read_text())["features"]
    rows = []
    for s in stars:
        ra, dec = s["geometry"]["coordinates"]
        x, y, z = project(ra, dec)
        if z < 0.2:
            continue
        try:
            bv = float(s["properties"]["bv"])
        except (TypeError, ValueError):
            bv = 0.5
        rows.append((s["properties"]["mag"], int(math.floor(x)), int(math.floor(y)), bv))
    rows.sort(reverse=True)  # faint first, bright on top
    for mag, x, y, bv in rows:
        if not (-4 <= x < W + 4 and -4 <= y < H + 4):
            continue
        colour = star_colour(bv)
        if mag > 5.2:
            if rng.random() < 0.5:
                put(indices, x, y, 5, only_dark=True)
        elif mag > 4.3:
            put(indices, x, y, 19, only_dark=True)
        elif mag > 3.3:
            put(indices, x, y, 7 if colour in (14, 18) else 11)
        elif mag > 2.4:
            put(indices, x, y, colour)
        elif mag > 1.5:
            put(indices, x, y, 14)
            arm = {18: 7, 14: 7, 13: 11, 15: 11}[colour]
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                put(indices, x + dx, y + dy, arm)
        else:
            arm = {18: 18, 14: 8, 13: 13, 15: 15}[colour]
            far = {18: 6, 14: 6, 13: 11, 15: 11}[colour]
            put(indices, x, y, 14)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                put(indices, x + dx, y + dy, arm)
                put(indices, x + 2 * dx, y + 2 * dy, far)
                if mag < 0.5:
                    put(indices, x + 3 * dx, y + 3 * dy, 4)
            for dx, dy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
                put(indices, x + dx, y + dy, 4)


def build(seed=11, figures=True, skip=()):
    glow, nebula = paint_glow(seed)
    indices = dither(glow)
    threshold = np.tile(BAYER_8, (H // 8 + 1, W // 8 + 1))[:H, :W]
    indices[nebula + threshold * 0.5 > 0.5] = 16
    indices[nebula + threshold * 0.4 > 0.78] = 17
    if figures:
        draw_figures(indices, glow, skip)
    draw_stars(indices, seed)
    return indices


def to_image(indices):
    image = Image.fromarray(indices, "P")
    flat = [int(c) for rgb in PALETTE for c in rgb]
    image.putpalette(flat + [0] * (768 - len(flat)))
    return image


def encode_webp(indices):
    buffer = io.BytesIO()
    to_image(indices).convert("RGB").save(buffer, "WEBP", lossless=True, quality=100, method=6, exact=True)
    return buffer.getvalue()


def data_url(indices):
    return "data:image/webp;base64," + base64.b64encode(encode_webp(indices)).decode()


NAMED = {"Vega": (279.23, 38.78), "Altair": (297.70, 8.87), "Deneb": (310.358, 45.28), "Antares": (247.35, -26.43),
         "Shaula": (263.40, -37.10), "Arcturus": (213.92, 19.18), "KausAus": (276.04, -34.38), "Nunki": (283.82, -26.30),
         "Rasalhague": (263.73, 12.56), "Albireo": (292.68, 27.96), "GC": (266.405, -28.936), "Spica": (201.3, -11.16),
         "Fomalhaut": (344.41, -29.62), "Enif": (326.05, 9.88), "Alphecca": (233.67, 26.71)}

if __name__ == "__main__":
    for name, (ra, dec) in NAMED.items():
        x, y, z = project(ra, dec)
        print(f"{name:11s} {float(x):6.1f} {float(y):6.1f}")
    out = Path(__file__).parent / "shots"
    idx = build()
    webp = encode_webp(idx)
    print("webp bytes", len(webp), "base64 chars", len(base64.b64encode(webp)))
    to_image(idx).convert("RGB").resize((W * 4, H * 4), Image.NEAREST).save(out / "art.png")

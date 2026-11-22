"""Terminator: the painted lunar horizon, re-screened live as a crisp halftone.

The painting's own dot screen does not survive AVIF at ~10 KB, so it is removed (descreened) and
rebuilt in the browser: a still 6x6 tile of a 45-degree dot cone sits over the picture with
mix-blend-mode: color-burn. Burn lights a pixel only where the cone exceeds 1 - brightness, so dot
size follows the tone and black stays black; a still color-dodge layer then multiplies by GAIN so the
dots are flat and crisp, a multiply layer inks them bone, and a lighten layer holds the page black.
The dots stay sharp at device resolution while the picture drifts beneath them. The picture is pre-distorted with the inverse of that screen's tone
curve (in linear light), so the re-screened Moon has the painting's tones.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "kit"))
import kit  # noqa: E402

THEME_ID = "terminator"
PAINTING = ROOT.parent / "art" / "terminator-art.png"
CROP_TOP = 0.52   # rows above this are empty sky; the page colour fills them
TILE = 5          # dot screen tile in device px (tuned for a 112.5% display scale): dot pitch 3.5 device px
GAIN = 4          # a still color-dodge layer after the burn: crisp, flat-topped dots
BG = np.array([8, 9, 10]) / 255
HIGHLIGHT = 0.74  # keeps gaps between the dots on the brightest plains, as in the painting

BLACK, CHARCOAL, BONE, GREY = "#08090a", "#151719", "#eae8e1", "#6e7378"

COLORS = {
    "canvas": BLACK,
    "chrome": BLACK,
    "toolbar": BLACK,
    "toolbarForeground": BONE,
    "toolbarBorder": CHARCOAL,
    "sidebar": BLACK,
    "sidebarForeground": BONE,
    "sidebarBorder": CHARCOAL,
    "sidebarMutedForeground": GREY,
    "sidebarControlSurface": BLACK,
    "sidebarRowHover": "#101214",
    "sidebarRowActive": CHARCOAL,
    "sidebarRowSelected": CHARCOAL,
    "border": "#232629",
    "accent": BONE,
    "accentForeground": BLACK,
    "focus": BONE,
    "text": BONE,
    "textMuted": GREY,
    "surface": BLACK,
    "surfaceRaised": "#0e0f11",
    "surfaceOverlay": BLACK,
    "input": "#2a2d31",
    "messageSurface": CHARCOAL,
    "messageForeground": BONE,
    "messageAction": BONE,
    "messageActionForeground": BLACK,
    "messageActionHover": "#ffffff",
    "update": BONE,
    "updateForeground": BONE,
    "updateSurface": CHARCOAL,
    "accentSurface": CHARCOAL,
    "accentSurfaceForeground": BONE,
    "muted": CHARCOAL,
    "mutedForeground": "#8d9296",
    "secondary": CHARCOAL,
    "secondaryForeground": BONE,
    "secondaryLabel": "#8d9296",
    "placeholder": GREY,
    "iconMuted": GREY,
    "codeBackground": "#0e0f11",
    "codeForeground": BONE,
    "searchMatchBackground": GREY,
    "searchMatchForeground": BLACK,
    "searchMatchActiveBackground": BONE,
    "searchMatchActiveForeground": BLACK,
    "terminalBackground": BLACK,
    "terminalForeground": BONE,
    "terminalCursor": BONE,
    "terminalSelection": "#33363a",
    "terminalScrollbar": CHARCOAL,
    "terminalScrollbarHover": GREY,
}

SHORT = {"--tm-w": "--w", "--tm-st": "--t", "tm-drift": "d", "tm-breathe": "b"}


def to_linear(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def blur(a, sigma):
    r = int(3 * sigma + 1)
    k = np.exp(-np.arange(-r, r + 1) ** 2 / (2 * sigma * sigma))
    k /= k.sum()
    p = np.pad(a, ((r, r), (r, r), (0, 0)), mode="edge")
    p = sum(k[i] * p[i: i + a.shape[0]] for i in range(2 * r + 1))
    return sum(k[i] * p[:, i: i + a.shape[1]] for i in range(2 * r + 1))


def cone():
    ys, xs = np.mgrid[0:TILE, 0:TILE] + 0.5
    c = (np.cos(2 * np.pi * (xs + ys) / TILE) + np.cos(2 * np.pi * (xs - ys) / TILE)) / 4 + 0.5
    return np.clip(c, 0.02, 1)


def screen_tile() -> str:
    c = (cone() * 255).round().astype(np.uint8)
    return kit.webp_url(Image.fromarray(np.stack([c] * 3, -1)))


def picture() -> str:
    """Neutral grey: AVIF then carries no chroma, which the burn would amplify into colour noise.
    A still multiply layer of bone above the screen restores the colour."""
    src = Image.open(PAINTING).convert("RGB")
    w, h = src.size
    rgb = np.asarray(src.crop((0, round(CROP_TOP * h), w, h)), float) / 255
    luma = (to_linear(rgb) @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    bone = to_linear(np.array([234, 232, 225]) / 255) @ np.array([0.2126, 0.7152, 0.0722])
    # tone curve of the burn screen: linear light out for each input level
    c = cone()
    levels = np.linspace(0, 1, 1001)
    out = np.array([to_linear(np.clip(GAIN * (1 - (1 - b) / c), 0, 1)).mean() for b in levels])
    base = np.interp(np.clip(HIGHLIGHT * blur(luma, 1.0) / bone, 0, out.max()), out, levels)
    base = np.clip(base + 0.4 * (base - blur(base, 2.0)), 0, 1)
    # empty sky and night become the page colour, so no seam shows where the picture ends
    night = np.clip((blur(rgb, 2.0).mean(-1, keepdims=True) - 0.035) / 0.05, 0, 1)
    sky = 9 / 255
    base = sky + (np.maximum(base, sky) - sky) * night
    grey = Image.fromarray((base[..., 0] * 255).round().astype(np.uint8), "L")
    url, info = kit.fit_avif(grey, max_bytes=10_100, widths=(1280, 1120, 960))
    print("  picture", info)
    return url


if __name__ == "__main__":
    kit.build(ROOT, THEME_ID, "Terminator", COLORS, {"__MOON__": picture(), "__SCREEN__": screen_tile(), "__STAIR__": kit.stair_ease()}, SHORT)

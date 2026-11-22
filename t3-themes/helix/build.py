"""Helix: a planetary nebula printed as a two-ink silkscreen poster, verdigris and bone on near black.

The artwork is the approved painting itself (art/helix-art.png), graded toward the concept's
quieter verdigris and the theme's canvas, then compressed to AVIF. It is shown as a still
background pinned on the eye; the motion layers above it only scale and fade. A still dot screen brings back the halftone that
compression softens.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "kit"))
import kit  # noqa: E402

THEME_ID = "helix"
ART = ROOT.parent / "art" / "helix-art.png"

INK = "#050C0A"
SURFACE = "#0F1D19"
BONE = "#EAF4EE"
VERDIGRIS = "#47A87D"
DEEP = "#1B4235"

COLORS = {
    "canvas": INK,
    "chrome": INK,
    "toolbar": INK,
    "sidebar": INK,
    "sidebarBorder": "#14261F",
    "border": "#1E3830",
    "accent": VERDIGRIS,
    "accentForeground": INK,
    "focus": VERDIGRIS,
    "text": BONE,
    "surface": SURFACE,
    "surfaceRaised": "#12231E",
    "surfaceOverlay": INK,
    "input": "#24443A",
    "messageSurface": SURFACE,
    "messageForeground": BONE,
    "messageAction": BONE,
    "messageActionForeground": INK,
    "messageActionHover": "#FFFFFF",
    "update": VERDIGRIS,
    "updateForeground": "#8CCBAD",
    "updateSurface": "#0F1D19",
    "accentSurface": DEEP,
    "accentSurfaceForeground": BONE,
    "muted": "#10201B",
    "secondary": SURFACE,
    "secondaryForeground": BONE,
    "mutedForeground": "#97ABA1",
    "secondaryLabel": "#97ABA1",
    "placeholder": "#7A8F85",
    "iconMuted": "#7A8F85",
    "sidebarForeground": BONE,
    "sidebarMutedForeground": "#90A49A",
    "sidebarControlSurface": INK,
    "codeBackground": "#08120F",
    "codeForeground": BONE,
    "searchMatchBackground": DEEP,
    "searchMatchForeground": BONE,
    "searchMatchActiveBackground": VERDIGRIS,
    "searchMatchActiveForeground": INK,
    "terminalBackground": INK,
    "terminalForeground": BONE,
    "terminalCursor": VERDIGRIS,
    "terminalSelection": DEEP,
}

SHORT = {
    "--hx-line": "--l",
    "--hx-x": "--x",
    "--hx-st": "--s",
    "hx-breathe": "b",
    "hx-twinkle": "t",
    "hx-glow": "g",
}


def graded():
    """Pulls the painting's emerald back to the concept's verdigris and lifts its black to the canvas."""
    rgb = np.asarray(Image.open(ART).convert("RGB")).astype(float)
    luma = rgb @ [0.2126, 0.7152, 0.0722]
    dim = GAIN
    out = (luma[..., None] + SATURATION * (rgb - luma[..., None])) * dim
    out += np.array([4, 2, 4]) * (1 - out / 255)
    image = Image.fromarray(np.clip(out, 0, 255).round().astype("uint8"))
    # The painting's own coarse dots turn into blocky steps when compressed and scaled up. Smooth them
    # away here; the still dot screen in the theme prints the halftone again, crisp, at screen resolution.
    return image.filter(ImageFilter.GaussianBlur(DESCREEN))


DESCREEN = 3.2
SATURATION = 0.8
GAIN = 1.12  # the dot screen and compression darken the inks; this wins it back


def screen(opacity=0.6, hole=3.5):
    """One still halftone screen over the picture: a near-black field with clear dots on a 45-degree
    lattice. The tile is 10 units drawn at 8.889 CSS px, which is exactly 10 device pixels at a
    112.5% display scale, so the lattice lands on whole pixels and does not beat."""
    holes = "".join(f"<circle cx='{x}' cy='{y}' r='{hole}'/>" for x, y in ((0, 0), (10, 0), (0, 10), (10, 10), (5, 5)))
    return kit.svg_url(f"""
<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'>
<mask id='m'><rect width='10' height='10' fill='#fff'/>{holes}</mask>
<rect width='10' height='10' fill='#050c0a' fill-opacity='{opacity}' mask='url(#m)'/>
</svg>""")


def art_url(max_bytes=10_900, widths=(1280, 1120, 960)):
    """The encoded painting, cached beside this file so CSS-only rebuilds stay fast."""
    import hashlib

    image = graded()
    key = hashlib.sha1(image.tobytes() + f"{max_bytes}{widths}".encode()).hexdigest()[:12]
    cache = ROOT / f".art-{key}.txt"
    if not cache.exists():
        for old in ROOT.glob(".art-*.txt"):
            old.unlink()
        url, info = kit.fit_avif(image, max_bytes=max_bytes, widths=widths, min_quality=20)
        print("  art", info)
        cache.write_text(url)
    return cache.read_text()


def parts():
    url = art_url()
    return {"__ART__": url, "__SCREEN__": screen()}


if __name__ == "__main__":
    kit.build(ROOT, THEME_ID, "Helix", COLORS, {**parts(), "__STAIR__": kit.stair_ease()}, SHORT)

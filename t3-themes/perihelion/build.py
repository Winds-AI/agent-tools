"""Perihelion: one great comet, painted, on ink navy.

The artwork is the painting itself, a small AVIF shown as a cover background with the comet's
head pinned to the same point of the window as in the concept. Motion is two small layers on
top: a soft band of light that travels along the dust tail (colour-dodge, so the sky stays
dark), and a glow on the head while an agent works.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "kit"))
import kit  # noqa: E402
from PIL import Image  # noqa: E402

THEME_ID = "perihelion"

INK = "#070B14"
SURFACE = "#101828"
ICE = "#EDF3FA"
BLUE = "#5CA4E6"
BONE = "#B8AB93"

COLORS = {
    "canvas": INK,
    "chrome": INK,
    "toolbar": INK,
    "toolbarForeground": ICE,
    "toolbarBorder": "#1c2638",
    "sidebar": INK,
    "sidebarForeground": ICE,
    "sidebarBorder": "#1a2333",
    "sidebarMutedForeground": "#8d97a8",
    "sidebarControlSurface": INK,
    "sidebarRowHover": "#121b2b",
    "sidebarRowActive": "#152033",
    "sidebarRowSelected": SURFACE,
    "border": "#1f2a3d",
    "accent": ICE,
    "accentForeground": INK,
    "focus": BLUE,
    "text": ICE,
    "textMuted": "#98a3b5",
    "surface": SURFACE,
    "surfaceRaised": "#131d30",
    "surfaceOverlay": SURFACE,
    "input": "#26324a",
    "placeholder": "#7d889b",
    "messageSurface": SURFACE,
    "messageForeground": ICE,
    "messageAction": ICE,
    "messageActionForeground": INK,
    "messageActionHover": "#ffffff",
    "update": BLUE,
    "updateForeground": "#9fc8f0",
    "updateSurface": "#0f1d33",
    "accentSurface": "#0f1d33",
    "accentSurfaceForeground": "#9fc8f0",
    "muted": SURFACE,
    "mutedForeground": "#98a3b5",
    "secondary": SURFACE,
    "secondaryForeground": ICE,
    "secondaryLabel": "#98a3b5",
    "iconMuted": "#7d889b",
    "codeBackground": "#0b111d",
    "codeForeground": "#dfe6ef",
    "searchMatchBackground": "#5ca4e64d",
    "searchMatchForeground": ICE,
    "searchMatchActiveBackground": BONE,
    "searchMatchActiveForeground": INK,
    "terminalBackground": INK,
    "terminalForeground": "#dfe6ef",
    "terminalCursor": ICE,
    "terminalSelection": "#22334f",
}

SHORT = {
    "--ph-k": "--k",
    "--ph-st": "--t",
    "ph-sweep": "s",
    "ph-coma": "c",
}

ART = ROOT.parent / "art" / "perihelion-art.png"


def grain():
    """One still tile of very light print grain, to keep the upscaled painting crisp."""
    return kit.svg_url("""
<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'>
<filter id='g' x='0' y='0' width='1' height='1'>
<feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' seed='4' stitchTiles='stitch'/>
<feColorMatrix values='0 0 0 0 .93 0 0 0 0 .95 0 0 0 0 .98 0 0 0 .3 -.12'/>
</filter>
<rect width='200' height='200' filter='url(#g)'/>
</svg>""")


def graded():
    """The painting, with its warm tones eased toward the palette's bone; the blues stay vivid."""
    import numpy as np

    rgb = np.asarray(Image.open(ART).convert("RGB")).astype(float)
    grey = rgb @ [0.3, 0.59, 0.11]
    warmth = np.clip((rgb[..., 0] - rgb[..., 2]) / 60, 0, 1)[..., None] * 0.3
    rgb = rgb * (1 - warmth) + grey[..., None] * warmth
    return Image.fromarray(np.clip(rgb, 0, 255).astype("uint8"))


if __name__ == "__main__":
    art, info = kit.fit_avif(graded(), max_bytes=10_700, widths=(1280,), min_quality=1)
    print("  art", info)
    kit.build(ROOT, THEME_ID, "Perihelion", COLORS, {"__ART__": art, "__GRAIN__": grain(), "__STAIR__": kit.stair_ease()}, SHORT)

"""First Magnitude: one blinding star on an old glass-plate photograph.

Everything is drawn with gradients and two tiny SVGs (faint field stars, silver grain),
so the theme is small and each moving layer is a thin strip or a small square.
"""
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "kit"))
import kit  # noqa: E402

THEME_ID = "first-magnitude"

COLORS = {
    "canvas": "#030712",
    "chrome": "#040914",
    "toolbar": "#040914",
    "sidebar": "#040914",
    "sidebarBorder": "#101a2e",
    "border": "#16233c",
    "accent": "#9cc2ff",
    "accentForeground": "#040914",
    "focus": "#9cc2ff",
    "text": "#f2f7ff",
    "surface": "#081020",
    "surfaceRaised": "#0c1526",
    "surfaceOverlay": "#070e1c",
    "input": "#1d2c4a",
    "messageSurface": "#0f1b33",
    "messageAction": "#f2f7ff",
    "messageActionForeground": "#040914",
    "messageActionHover": "#ffffff",
    "update": "#9cc2ff",
    "updateForeground": "#c4dbff",
    "updateSurface": "#0e1a31",
    "muted": "#0e1830",
    "secondary": "#0c1526",
    "secondaryForeground": "#f2f7ff",
    "mutedForeground": "#9aa9c6",
    "secondaryLabel": "#9aa9c6",
    "sidebarMutedForeground": "#8f9fbd",
    "sidebarControlSurface": "#040914",
    "codeBackground": "#050b18",
    "terminalBackground": "#040914",
    "terminalCursor": "#f2f7ff",
    "terminalSelection": "#1c3157",
}

SHORT = {
    "--fm-x": "--x",
    "--fm-y": "--y",
    "fm-breathe": "b",
    "--fm-st": "--t",
    "fm-shimmer": "h",
}


def field_stars(count=46, seed=4):
    rng = random.Random(seed)
    dots = []
    for _ in range(count):
        x, y = rng.uniform(0, 1600), rng.uniform(0, 900)
        size = rng.choice([0.6, 0.6, 0.7, 0.8, 1.0, 1.3])
        opacity = rng.choice([0.25, 0.35, 0.45, 0.6, 0.8])
        dots.append(f"<circle cx='{x:.0f}' cy='{y:.0f}' r='{size:g}' opacity='{opacity:g}'/>")
    return kit.svg_url(
        f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice' fill='#dce8ff'>{''.join(dots)}</svg>"
    )


def silver_grain():
    return kit.svg_url("""
<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'>
<filter id='g' x='0' y='0' width='1' height='1'>
<feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' seed='9' stitchTiles='stitch'/>
<feColorMatrix values='0 0 0 0 .8 0 0 0 0 .87 0 0 0 0 1 0 0 0 .42 -.18'/>
</filter>
<rect width='220' height='220' filter='url(#g)'/>
</svg>""")


if __name__ == "__main__":
    kit.build(ROOT, THEME_ID, "First Magnitude", COLORS, {"__STARS__": field_stars(), "__GRAIN__": silver_grain(), "__STAIR__": kit.stair_ease()}, SHORT)

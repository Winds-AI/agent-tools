"""Event Horizon: a black hole in stipple grain whose particles orbit slowly.

The grain is procedural: SVG turbulence thresholded against a density gradient, so it
costs almost nothing in size and stays crisp at any window size. Each layer is a flat
picture that the compositor spins; nothing is redrawn while it moves.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "kit"))
import kit  # noqa: E402

THEME_ID = "event-horizon"

COLORS = {
    "canvas": "#000000",
    "chrome": "#000000",
    "toolbar": "#000000",
    "sidebar": "#000000",
    "sidebarBorder": "#1c1c1c",
    "border": "#222222",
    "accent": "#ecebe6",
    "accentForeground": "#000000",
    "focus": "#9cc2ff",
    "text": "#ecebe6",
    "surface": "#0a0a0a",
    "surfaceRaised": "#0e0e0e",
    "surfaceOverlay": "#090909",
    "input": "#2c2c2c",
    "messageSurface": "#161616",
    "messageAction": "#ecebe6",
    "messageActionForeground": "#000000",
    "messageActionHover": "#ffffff",
    "update": "#ecebe6",
    "updateForeground": "#ecebe6",
    "updateSurface": "#141414",
    "muted": "#141414",
    "secondary": "#111111",
    "secondaryForeground": "#ecebe6",
    "mutedForeground": "#9c9b96",
    "secondaryLabel": "#9c9b96",
    "sidebarMutedForeground": "#94938e",
    "sidebarControlSurface": "#000000",
    "codeBackground": "#070707",
    "terminalBackground": "#000000",
    "terminalCursor": "#ecebe6",
    "terminalSelection": "#333333",
}

SHORT = {
    "--eh-x": "--x",
    "--eh-y": "--y",
    "--eh-r": "--r",
    "eh-spin": "s",
    "--eh-st": "--t",
    "eh-feed": "f",
}


def grain(stops, seed, size=800, fine=0.8, clump=0.007, clump_gain=1.8, hard=28):
    """A disc of stipple. `stops` are (radius 0..1, density 0..1) pairs; density near 0.5 is half covered."""
    gradient = "".join(f"<stop offset='{r:g}' stop-opacity='{d:g}'/>" for r, d in stops)
    half = size / 2
    return kit.svg_url(f"""
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {size} {size}'>
<radialGradient id='g' stop-color='#fff'>{gradient}</radialGradient>
<filter id='f' x='0' y='0' width='1' height='1'>
<feTurbulence type='fractalNoise' baseFrequency='{fine:g}' seed='{seed}' result='n'/>
<feTurbulence type='fractalNoise' baseFrequency='{clump:g}' numOctaves='2' seed='{seed + 7}' result='m'/>
<feComposite in='SourceGraphic' in2='m' operator='arithmetic' k1='{clump_gain:g}' k2='{1 - clump_gain / 2:g}' result='d'/>
<feComposite in='d' in2='n' operator='arithmetic' k2='1' k3='-1'/>
<feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 {hard} 0'/>
</filter>
<circle cx='{half:g}' cy='{half:g}' r='{half:g}' fill='url(#g)' filter='url(#f)'/>
</svg>""")


def layers():
    # Radii are fractions of each layer's own radius. Density: 0.2 is empty, 0.4 scattered, 0.6 dense.
    # The disc layers are ribbons with empty lanes between them, so the flow reads as swept arcs.
    ring = grain([(0, 0), (0.795, 0), (0.8, 0.76), (0.83, 0.56), (0.88, 0.43), (0.94, 0.32), (1, 0.2)], seed=3, size=560, fine=0.65, clump_gain=0.8)
    halo = grain([(0, 0), (0.56, 0.3), (0.6, 0.42), (0.68, 0.35), (0.8, 0.28), (0.92, 0.22), (1, 0.2)], seed=5, size=700, fine=0.65, clump_gain=0.9)
    inner = grain([(0, 0), (0.33, 0.2), (0.37, 0.56), (0.44, 0.4), (0.47, 0.2), (0.52, 0.2), (0.55, 0.47), (0.63, 0.36), (0.66, 0.2), (0.74, 0.2), (0.77, 0.42), (0.87, 0.32), (0.91, 0.2), (1, 0.2)], seed=11, size=800, fine=0.65, clump_gain=0.5)
    mid = grain([(0, 0), (0.36, 0.2), (0.4, 0.42), (0.47, 0.33), (0.5, 0.2), (0.58, 0.2), (0.61, 0.4), (0.69, 0.31), (0.72, 0.2), (0.8, 0.2), (0.83, 0.37), (0.92, 0.28), (0.96, 0.2), (1, 0.2)], seed=17, size=800, fine=0.65, clump_gain=0.5)
    outer = grain([(0, 0), (0.46, 0.2), (0.5, 0.38), (0.56, 0.3), (0.59, 0.2), (0.66, 0.2), (0.69, 0.36), (0.76, 0.28), (0.79, 0.2), (0.86, 0.2), (0.89, 0.33), (0.95, 0.26), (1, 0.2)], seed=23, size=900, fine=0.65, clump_gain=0.5)
    return {"__RING__": ring, "__HALO__": halo, "__INNER__": inner, "__MID__": mid, "__OUTER__": outer}


if __name__ == "__main__":
    kit.build(ROOT, THEME_ID, "Event Horizon", COLORS, {**layers(), "__STAIR__": kit.stair_ease()}, SHORT)

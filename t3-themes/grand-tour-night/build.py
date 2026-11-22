"""Grand Tour Night: a risograph space-travel poster. A ringed planet rises from the lower right.

The artwork is the approved painting, compressed to AVIF and shown as a cover background
anchored to the bottom right. On top of it sit only small moving layers of our own:
a tin rocket that rides the top of the ring and slips behind the planet, a few stop-motion
stars, and, while an agent works, a long flame with a dashed trail.

Everything that sits on the picture is placed in the picture's own pixels (unit --u, one
painting pixel in CSS px), so it stays pinned to the art at any window size.
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "kit"))
import kit  # noqa: E402

THEME_ID = "grand-tour-night"
ART = ROOT.parent / "art" / "grand-tour-night-art.png"
IW, IH = 1672, 941  # the painting's pixels; all art coordinates below are in these

# Inks sampled from the painting.
SKY = "#00171d"
ORANGE = "#e84a1c"
CREAM = "#f6d8a8"
TEAL = "#1f6e6e"
TEXT = "#f3e2c3"
PANEL = "#03222a"

COLORS = {
    "canvas": SKY,
    "chrome": SKY,
    "toolbar": SKY,
    "toolbarForeground": TEXT,
    "toolbarBorder": "#16343a",
    "sidebar": "#001218",
    "sidebarForeground": "#ecdcbf",
    "sidebarMutedForeground": "#91a3a0",
    "sidebarControlSurface": "#001218",
    "sidebarBorder": "#16343a",
    "border": "#1d3a40",
    "accent": ORANGE,
    "accentForeground": "#fff3e0",
    "focus": "#f0a070",
    "text": TEXT,
    "textMuted": "#a4b0aa",
    "surface": PANEL,
    "surfaceRaised": "#062a32",
    "surfaceOverlay": PANEL,
    "input": "#29454b",
    "messageSurface": "#062a32",
    "messageForeground": TEXT,
    "messageAction": ORANGE,
    "messageActionForeground": "#fff3e0",
    "messageActionHover": "#f2643a",
    "update": "#f0a070",
    "updateForeground": "#f5c39c",
    "updateSurface": "#2a140c",
    "muted": "#08262d",
    "mutedForeground": "#a4b0aa",
    "secondary": "#062229",
    "secondaryForeground": TEXT,
    "secondaryLabel": "#a4b0aa",
    "placeholder": "#7e908d",
    "iconMuted": "#8d9e9a",
    "codeBackground": "#001217",
    "codeForeground": "#eedcbb",
    "terminalBackground": "#00121a",
    "terminalForeground": "#e8d6b6",
    "terminalCursor": ORANGE,
    "terminalSelection": "#1f4a50",
}

SHORT = {
    "--gt-u": "--u",
    "--gt-x": "--x",
    "--gt-y": "--y",
    "--gt-band": "--b",
    "--gt-rocket": "--k",
    "gt-ride": "o",
    "gt-flick": "f",
    "gt-twinkle-a": "a",
    "gt-twinkle-b": "b",
}


def svg(body, view, defs=""):
    return kit.svg_url(f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='{view}'><defs>{defs}</defs>{body}</svg>")


# --- The picture ------------------------------------------------------------------------

def picture(max_bytes):
    url, info = kit.fit_avif(Image.open(ART), max_bytes=max_bytes)
    print("  picture", info)
    return url


def grain_tile():
    """A still, light grain to give the compressed flats back their paper tooth."""
    return kit.svg_url("""
<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'>
<filter id='g' x='0' y='0' width='1' height='1' color-interpolation-filters='sRGB'>
<feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' seed='4' stitchTiles='stitch'/>
<feColorMatrix values='2.2 0 0 0 -.6 2.2 0 0 0 -.6 2.2 0 0 0 -.6 0 0 0 0 1'/>
</filter>
<rect width='200' height='200' filter='url(#g)'/>
</svg>""")


# --- The rocket -------------------------------------------------------------------------

UNIT = 13  # painting pixels per rocket-sprite unit
BOX = (60 * UNIT, 6 * UNIT)  # the rocket's box in painting pixels; translate % is relative to it
TILT = 12  # the nose points a little up off the ring, climbing, as in the concept
LIFT = 15  # how far above the ring's outer edge the orbit point rides, in painting pixels


def rocket_art():
    """A tin rocket in profile, nose to the right, centred in a 14 x 6 sprite. The body's axis
    sits a little above centre so the lower fin just touches the ring it rides on."""
    defs = (
        "<filter id='r' x='-5%' y='-5%' width='110%' height='110%'>"
        "<feTurbulence type='fractalNoise' baseFrequency='7' seed='7'/>"
        "<feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -9 6.9'/>"
        "<feComposite in='SourceGraphic' operator='in'/></filter>"
    )
    body = (
        "<g filter='url(#r)'>"
        f"<path d='M4.7 2.15Q2.4 2.25 0 3Q2.3 3.05 4.7 3.25Z' fill='{ORANGE}'/>"
        f"<path d='M4.7 2.42Q3.3 2.55 1.9 2.8Q3.3 2.9 4.7 2.98Z' fill='{CREAM}'/>"
        f"<g stroke='{SKY}' stroke-width='.13'>"
        f"<path d='M6.7 1.75Q5.6 1.2 4.2.65Q4.9 1.5 4.7 2ZM6.7 3.65Q5.6 4.2 4.2 4.75Q4.9 3.9 4.7 3.4Z' fill='{CREAM}'/>"
        f"<path d='M4.6 1.95C7.4 1.35 10.6 1.6 12.5 2.7C10.6 3.8 7.4 4.05 4.6 3.45Z' fill='{CREAM}'/>"
        f"<path d='M10.8 1.85C11.5 2.1 12.1 2.4 12.5 2.7C12.1 3 11.5 3.3 10.8 3.55C11.05 3 11.05 2.4 10.8 1.85Z' fill='{ORANGE}'/>"
        f"<circle cx='9.3' cy='2.55' r='.44' fill='{SKY}'/></g>"
        f"<path d='M5.3 3H10' stroke='#c9a77a' stroke-width='.1'/>"
        "</g>"
    )
    return svg(body, "0 0 14 6", defs)


def trail_art():
    """Long flame and dashed trail, in a 60 x 6 sprite sharing the rocket's centre (30, 3).
    The rocket's tail sits at x = 27.6, its nose at 35.5."""
    body = (
        f"<path d='M27.6 2.2Q21 2.4 14.5 2.75Q21 3.05 27.6 3.2Z' fill='{ORANGE}'/>"
        f"<path d='M27.6 2.45Q23 2.6 19 2.75Q23 2.85 27.6 2.95Z' fill='{CREAM}'/>"
        f"<path d='M13.4 2.75H.8' stroke='{CREAM}' stroke-width='.36' stroke-dasharray='2.2 1.5' stroke-linecap='round'/>"
    )
    return svg(body, "0 0 60 6")


def ride_path():
    """The measured outer edge of the painted ring (lower arc, tip, top arc up to the planet),
    smoothed with a polynomial in arc length. Measured once from the painting."""
    contour = np.load(ROOT / "ring-contour.npy")
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(contour, axis=0).T))]
    s = seg / seg[-1]
    return np.polyfit(s, contour[:, 0], 7), np.polyfit(s, contour[:, 1], 7)


def pose(s):
    """Position (pushed outward off the ring's edge) and heading at path fraction s."""
    fx, fy = ride_path()
    x, y = np.polyval(fx, s), np.polyval(fy, s)
    tx, ty = np.polyval(np.polyder(fx), s), np.polyval(np.polyder(fy), s)
    n = math.hypot(tx, ty)
    x, y = x + ty / n * LIFT, y - tx / n * LIFT
    return f"translate:{x / BOX[0] * 100:.1f}% {y / BOX[1] * 100:.1f}%;rotate:{math.degrees(math.atan2(ty, tx)) - TILT:.0f}deg"


def ride_keyframes(frames=22, travel=0.74):
    """One cycle: fade in at the ring's far tip, ride the top of the ring, slip out of sight at
    the planet's edge, then wait unseen for the rest of the cycle."""
    out = []
    for i in range(frames + 1):
        opacity = max(0, min(1, i / 2, (frames - i) / 2))
        fade = f";opacity:{opacity:.2g}".replace("0.", ".") if i < 3 or i > frames - 3 else ""
        out.append(f"{travel * 100 * i / frames:.3g}%{{{pose(0.08 + 0.905 * i / frames)}{fade}}}")
    out.append("to{opacity:0}")
    return "@keyframes " + SHORT["gt-ride"] + "{" + "".join(out) + "}"


# --- Stars ------------------------------------------------------------------------------

STAR = "M0-1C.09-.26.26-.09 1 0C.26.09.09.26 0 1C-.09.26-.26.09-1 0C-.26-.09-.09-.26 0-1Z"


def stars(points, box):
    """A group of four-point stars, given in painting pixels (x, y, radius), drawn in a box."""
    x0, y0, w, h = box
    defs = f"<path id='s' fill='{CREAM}' d='{STAR}'/>"
    body = "".join(f"<use href='#s' transform='translate({x - x0:g} {y - y0:g}) scale({r:g})'/>" for x, y, r in points)
    return svg(body, f"0 0 {w} {h}", defs)


# Group A: upper sky, plus a longer flare over the painted star at the upper right.
STARS_A = ([(700, 214, 5), (968, 292, 7), (1108, 372, 4), (1237, 239, 19)], (680, 200, 580, 190))
# Group B: left sky, plus a flare over the painted star at the lower left.
STARS_B = ([(330, 548, 6), (396, 392, 4), (640, 676, 4), (487, 662, 18)], (310, 370, 350, 330))


def box_css(box):
    x, y, w, h = box
    return (
        f"left:calc(var(--gt-x) + {x} * var(--gt-u));top:calc(var(--gt-y) + {y} * var(--gt-u));"
        f"width:calc({w} * var(--gt-u));height:calc({h} * var(--gt-u))"
    )


def short(text):
    for long_name in sorted(SHORT, key=len, reverse=True):
        text = text.replace(long_name, SHORT[long_name])
    return text


def parts(max_bytes=9_600):
    return {
        "__PICTURE__": picture(max_bytes),
        "__GRAIN__": grain_tile(),
        "__ROCKET__": rocket_art(),
        "__TRAIL__": trail_art(),
        "__STARS_A__": stars(*STARS_A),
        "__STARS_B__": stars(*STARS_B),
        "__BOX_A__:0": short(box_css(STARS_A[1])),
        "__BOX_B__:0": short(box_css(STARS_B[1])),
        "__PARK__:0": pose(0.42),
        "@keyframes __RIDE__{}": ride_keyframes(),
    }


if __name__ == "__main__":
    kit.build(ROOT, THEME_ID, "Grand Tour Night", COLORS, parts(), SHORT)

"""Builds sidereal.json (the T3 Code theme) and preview.css (for trying it in a live tab).

The CSS structure and the minifier follow Deepusleepy's Nyx theme (MIT, github.com/Deepusleepy/t3-nyx-theme).
"""
import json
import re
import sys
from pathlib import Path

import art

ROOT = Path(__file__).parent
CSS_LIMIT = 20_000
THEME_ID = "sidereal"
THEME_NAME = "Sidereal"

COLORS = {
    "canvas": "#04060e",
    "chrome": "#04060e",
    "toolbar": "#04060e",
    "sidebar": "#04060e",
    "sidebarBorder": "#141a2e",
    "border": "#1c2238",
    "accent": "#f3b56a",
    "accentForeground": "#170d03",
    "focus": "#f3b56a",
    "text": "#eef1fb",
    "surface": "#0a0f20",
    "surfaceRaised": "#0e1428",
    "surfaceOverlay": "#090d1c",
    "input": "#232b4c",
    "messageSurface": "#161d3c",
    "messageAction": "#f3b56a",
    "messageActionForeground": "#1c0f03",
    "messageActionHover": "#ffcf94",
    "update": "#8fb0ff",
    "updateForeground": "#b7ccff",
    "updateSurface": "#111a36",
    "muted": "#131a34",
    "secondary": "#10162e",
    "secondaryForeground": "#f4f6ff",
    "mutedForeground": "#a3abc8",
    "secondaryLabel": "#a3abc8",
    "sidebarMutedForeground": "#99a2c0",
    "sidebarControlSurface": "#04060e",
    "codeBackground": "#060916",
    "terminalBackground": "#050814",
    "terminalCursor": "#ffdca8",
    "terminalSelection": "#26315c",
}

SHORT_VARIABLES = {
    "--sky-w": "--w",
    "--sky-st": "--t",
    "--sky-o": "--o",
    "--sky": "--b",
    "--lit": "--l",
    "--edge": "--e",
    "--sun": "--u",
    "--rim": "--r",
    "sky-glint": "g",
    "sky-turn": "t",
    "sky-orbit": "o",
    "sky-fall": "f",
}

ROLE_VARIABLE = lambda role: "--app-theme-" + re.sub(r"([A-Z])", lambda m: "-" + m.group(1).lower(), role)


def svg(body: str, view: str) -> str:
    text = f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='{view}'{body}</svg>"
    return "data:image/svg+xml," + text.replace("#", "%23").replace("<", "%3C").replace(">", "%3E")


def ticks(radius: float, count: int, length: float, width: float, opacity: float) -> str:
    period = 2 * 3.141592653589793 * radius / count
    return f"<circle r='{radius:g}' stroke-width='{length:g}' stroke-dasharray='{width:g} {period - width:.3f}' stroke-opacity='{opacity:g}'/>"


def dial() -> str:
    body = " fill='none' stroke='#c3d0f7'>" + "".join([
        "<circle r='331' stroke-opacity='.28'/>",
        ticks(325, 360, 6, 0.8, 0.5),
        ticks(322, 72, 12, 1, 0.6),
        ticks(318, 24, 20, 1.4, 0.9),
        "<g fill='#c3d0f7' fill-opacity='.7' stroke='none' font-size='11' text-anchor='middle' font-family='monospace'>",
        "".join(f"<text y='-342' transform='rotate({h * 15})'>{h}h</text>" for h in (0, 6, 12, 18)),
        "</g>",
    ])
    return svg(body, "-500 -500 1000 1000")


def orbit() -> str:
    body = " fill='none' stroke='#c3d0f7'>" + "".join([
        "<circle r='452' stroke-opacity='.2' stroke-dasharray='1.5 9'/>",
        "<circle cx='452' r='4.5' fill='#ffdca8' stroke='#f3b56a' stroke-opacity='.4' stroke-width='7'/>",
        "<circle r='392' stroke-opacity='.12'/>",
        "<circle cy='-392' r='2.5' fill='#a9c3ff' stroke='none'/>",
    ])
    return svg(body, "-500 -500 1000 1000")


SPIKE_STARS = {
    "a": [("Vega", 5.5), ("Antares", 4.5), ("Nunki", 3)],
    "b": [("Altair", 5), ("Deneb", 4.5), ("Shaula", 3.5), ("Rasalhague", 3)],
}
SPIKE_COLOUR = {"Antares": "#ffb27a"}


def spikes(group: str) -> str:
    parts = []
    for name, size in SPIKE_STARS[group]:
        x, y, _ = art.project(*art.NAMED[name])
        x, y = float(x) + 0.5, float(y) + 0.5
        colour = SPIKE_COLOUR.get(name)
        stroke = f" stroke='{colour}'" if colour else ""
        parts.append(f"<path{stroke} d='M{x - size:.1f} {y:.1f}h{size * 2:g}M{x:.1f} {y - size:.1f}v{size * 2:g}'/>")
    body = " stroke='#e6ecff' stroke-width='.22' stroke-linecap='round'>" + "".join(parts)
    return svg(body, f"0 0 {art.W} {art.H}")


def minify(css: str) -> str:
    strings: list[str] = []

    def stash(match: re.Match) -> str:
        strings.append(match.group(0))
        return f"\x00{len(strings) - 1}\x00"

    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    css = re.sub(r'="([A-Za-z_][\w-]*)"\]', r"=\1]", css)
    css = re.sub(r'"[^"]*"|url\(data:[^)]*\)', stash, css)
    css = re.sub(r"\s+", " ", css)
    css = re.sub(r"\s*([{};,>])\s*", r"\1", css)
    css = re.sub(r":\s+", ":", css)
    css = re.sub(r"\s*!important", "!important", css)
    css = re.sub(r" ([*/]) ", r"\1", css)
    css = css.replace(";}", "}")
    css = re.sub(r"\btransparent\b", "#0000", css)
    css = re.sub(r"#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3(([0-9a-f])\5)?\b", lambda m: "#" + m.group(1) + m.group(2) + m.group(3) + (m.group(5) or ""), css, flags=re.I)
    css = re.sub(r"(?<![\w.])0\.(\d)", r".\1", css)
    for long_name in sorted(SHORT_VARIABLES, key=len, reverse=True):
        css = css.replace(long_name, SHORT_VARIABLES[long_name])
    css = re.sub(r"(?<=[{};,])&(?: |(?=>))", "", css)
    css = re.sub(r"\x00(\d+)\x00", lambda m: strings[int(m.group(1))], css)
    return css.strip()


def build() -> dict:
    css = minify((ROOT / "theme.css").read_text())
    image = art.data_url(art.build())
    import sys as _sys
    _sys.path.insert(0, str(ROOT.parent / "kit"))
    import kit
    parts = {"__STAIR__": kit.stair_ease(), "__DIAL__": dial(), "__ORBIT__": orbit(), "__SPIKES_A__": spikes("a"), "__SPIKES_B__": spikes("b"), "__ART__": image}
    rest = len(css)
    for key, value in parts.items():
        css = css.replace(key, value)
        print(f"  {key:13s} {len(value):6d}")
    print(f"  rules         {rest - sum(len(k) for k in parts):6d}")
    print(f"css {len(css)} of {CSS_LIMIT}")
    return {"version": 1, "name": THEME_NAME, "appearance": "dark", "colors": COLORS, "css": css}


if __name__ == "__main__":
    theme = build()
    (ROOT / f"{THEME_ID}.json").write_text(json.dumps(theme, indent=2) + "\n")
    roles = "".join(f"{ROLE_VARIABLE(role)}:{value}!important;" for role, value in COLORS.items())
    (ROOT / "preview.css").write_text("html[data-theme-id]{" + roles + "}" + theme["css"])
    if len(theme["css"]) > CSS_LIMIT:
        sys.exit(f"css is {len(theme['css'])} characters; T3 accepts at most {CSS_LIMIT}")

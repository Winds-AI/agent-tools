"""Shared build helpers for T3 Code themes. Import from a theme folder's build.py:

    import sys; sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit"))
    import kit

The minifier follows Deepusleepy's Nyx theme (MIT, github.com/Deepusleepy/t3-nyx-theme).
"""
import base64
import io
import json
import re
import sys
from pathlib import Path

CSS_LIMIT = 20_000
PREVIEW_ROOT = Path("/tmp/t3-themes")  # the browser tool can only read real paths under /tmp


def role_variable(role: str) -> str:
    return "--app-theme-" + re.sub(r"([A-Z])", lambda m: "-" + m.group(1).lower(), role)


def svg_url(svg: str) -> str:
    """A data: address for an SVG, safe inside url("...") in theme CSS.

    Write internal references the normal way, fill='url(#g)' or filter='url(#f)'.
    They are rewritten so T3's fetch check and the data: parser both accept them.
    Use single quotes for attributes.
    """
    svg = re.sub(r">\s+<", "><", svg.strip())
    svg = re.sub(r"url\(#([\w-]+)\)", r"url%28%23\1%29", svg)
    return "data:image/svg+xml," + svg.replace("#", "%23").replace("<", "%3C").replace(">", "%3E").replace('"', "'")


def webp_url(image, lossless: bool = True, quality: int = 100) -> str:
    """A data: address for a PIL image. Lossless suits palette and dithered art; lossy suits soft glows."""
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", lossless=lossless, quality=quality, method=6, exact=True)
    return "data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode()


def font_url(path: str, text: str, axes: dict | None = None, features=("kern",)) -> str:
    """A data: address for a WOFF2 subset holding only the characters in `text`.

    `axes` pins a variable font, such as {"wght": 500}. Capitals and digits of a
    display face cost about 4 KB; a full alphabet about twice that.
    """
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer

    font = TTFont(path)
    if axes and "fvar" in font:
        font = instancer.instantiateVariableFont(font, axes)
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = list(features)
    options.name_IDs = []
    options.notdef_outline = False
    options.hinting = False
    options.desubroutinize = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    buffer = io.BytesIO()
    font.flavor = "woff2"
    font.save(buffer)
    return "data:font/woff2;base64," + base64.b64encode(buffer.getvalue()).decode()


def minify(css: str, short_names: dict[str, str] | None = None) -> str:
    """Shrinks CSS. `short_names` maps long custom property or keyframe names to short ones."""
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
    css = re.sub(
        r"#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3(([0-9a-f])\5)?\b",
        lambda m: "#" + m.group(1) + m.group(2) + m.group(3) + (m.group(5) or ""),
        css,
        flags=re.I,
    )
    css = re.sub(r"(?<![\w.])0\.(\d)", r".\1", css)
    for long_name in sorted(short_names or {}, key=len, reverse=True):
        css = css.replace(long_name, short_names[long_name])
    css = re.sub(r"(?<=[{};,])&(?: |(?=>))", "", css)
    css = re.sub(r"\x00(\d+)\x00", lambda m: strings[int(m.group(1))], css)
    return css.strip()


def build(
    folder: Path,
    theme_id: str,
    name: str,
    colors: dict[str, str],
    parts: dict[str, str] | None = None,
    short_names: dict[str, str] | None = None,
    appearance: str = "dark",
    source: str = "theme.css",
) -> dict:
    """Minifies `source`, fills the __PLACEHOLDER__ parts, and writes the theme and a preview sheet.

    Writes <folder>/<theme_id>.json and /tmp/t3-themes/<theme_id>/preview.css.
    The preview sheet also sets the colour roles, which the app sets itself once a theme is installed.
    Exits with an error when the CSS is over T3's limit, after writing the preview so it can still be viewed.
    """
    css = minify((folder / source).read_text(), short_names)
    rules = len(css)
    for key, value in (parts or {}).items():
        if key not in css:
            print(f"  {key:16s} not used in {source}")
            continue
        css = css.replace(key, value)
        rules -= len(key)
        print(f"  {key:16s} {len(value):6d}")
    print(f"  {'rules':16s} {rules:6d}")
    print(f"css {len(css)} of {CSS_LIMIT} ({CSS_LIMIT - len(css)} spare)")
    theme = {"version": 1, "name": name, "appearance": appearance, "colors": colors, "css": css}
    (folder / f"{theme_id}.json").write_text(json.dumps(theme, indent=2) + "\n")
    preview = PREVIEW_ROOT / theme_id
    preview.mkdir(parents=True, exist_ok=True)
    roles = "".join(f"{role_variable(role)}:{value}!important;" for role, value in colors.items())
    (preview / "preview.css").write_text("html[data-theme-id]{" + roles + "}" + css)
    if len(css) > CSS_LIMIT:
        sys.exit(f"css is {len(css)} characters; T3 accepts at most {CSS_LIMIT}")
    return theme


def fit_avif(image, max_bytes: int = 10_500, widths=(1280, 1120, 960, 800, 640), min_quality: int = 30) -> tuple[str, dict]:
    """Encodes a PIL image as AVIF under `max_bytes`, preferring the largest width that keeps quality at or above `min_quality`.

    Returns (data address, {"width", "height", "quality", "bytes"}). Painted or photographic art
    survives this far better than anything drawn from maths: a 16:9 picture with large calm
    areas keeps its fine detail at about 10 KB.
    """
    image = image.convert("RGB")
    best = None
    for width in widths:
        if width > image.width:
            continue
        height = round(width * image.height / image.width)
        scaled = image.resize((width, height), Image_LANCZOS())
        low, high, found = 1, 90, None
        while low <= high:
            quality = (low + high) // 2
            buffer = io.BytesIO()
            scaled.save(buffer, "AVIF", quality=quality, speed=0)
            if len(buffer.getvalue()) <= max_bytes:
                found = (quality, buffer.getvalue())
                low = quality + 1
            else:
                high = quality - 1
        if found and (best is None or found[0] >= min_quality):
            best = (width, height, *found)
            if found[0] >= min_quality:
                break
    if best is None:
        raise ValueError("image does not fit the byte budget at any width")
    width, height, quality, data = best
    info = {"width": width, "height": height, "quality": quality, "bytes": len(data)}
    return "data:image/avif;base64," + base64.b64encode(data).decode(), info


def Image_LANCZOS():
    from PIL import Image

    return Image.LANCZOS


def stair_ease(plateaus: int = 25) -> str:
    """An ease-in-out timing function that advances in `plateaus` small jumps instead of every frame.

    Use it for slow breathing and pulsing loops: `animation: name 9s __STAIR__ infinite alternate`.
    Between jumps nothing changes, so the compositor has nothing to redraw; with 25 jumps each one
    moves a slow loop by a fraction of a pixel or a couple of percent of opacity, which reads as smooth.
    """
    import math

    stops = []
    for i in range(plateaus):
        value = (1 - math.cos(math.pi * (i + 0.5) / plateaus)) / 2
        text = f"{value:.3f}".rstrip("0").rstrip(".").replace("0.", ".") or "0"
        stops.append(f"{text} {100 * i / plateaus:g}% {100 * (i + 1) / plateaus:g}%")
    return "linear(" + ",".join(stops) + ")"

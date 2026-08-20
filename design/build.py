#!/usr/bin/env -S uv run --no-project python
"""Compose the design-canvas artboards from shared parts.

Every `.dc.html` artboard must be self-contained — the canvas runtime resolves
images out of the document but not stylesheets — so the design tokens would
otherwise be copy-pasted into every file and drift. This script injects
`_tokens.css` into each artboard's `<helmet>` at build time, keeping one source
of truth that is itself a verbatim copy of
`lib/typescript/ui/base/src/theme.css`.

Layout per artboard, in `parts/`:

    <Name>.html        the markup that goes inside <x-dc>          (required)
    <Name>.vals.js     the body of renderVals(), returning an object (optional)
    <Name>.props.json  the data-props attribute value               (optional)

Run: ./design/build.py
"""

from pathlib import Path

ROOT = Path(__file__).parent
PARTS = ROOT / "parts"
TOKENS = (ROOT / "_tokens.css").read_text()

FONTS = (
    "https://fonts.googleapis.com/css2"
    "?family=Bricolage+Grotesque:opsz,wght@12..96,400..800"
    "&family=Geist:wght@300..700"
    "&family=Geist+Mono:wght@400..600"
    "&display=swap"
)

SHELL = """<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="{fonts}">
  <style>
{tokens}
  </style>
</helmet>
{body}
</x-dc>
<script data-dc-script data-props='{props}'>
class Component extends DCLogic {{
  renderVals() {{
{vals}
  }}
}}
</script>
</body>
</html>
"""


def indent(text: str, spaces: int) -> str:
    pad = " " * spaces
    return "\n".join(pad + line if line.strip() else "" for line in text.rstrip().splitlines())


def build(name: str) -> None:
    body = (PARTS / f"{name}.html").read_text().rstrip()

    vals_file = PARTS / f"{name}.vals.js"
    vals = vals_file.read_text() if vals_file.exists() else "return {}"

    props_file = PARTS / f"{name}.props.json"
    props = props_file.read_text().strip() if props_file.exists() else "{}"
    # data-props is a normal HTML attribute read with getAttribute, so entities
    # decode before the JSON parse. Single quotes must be escaped.
    props = props.replace("&", "&amp;").replace("'", "&#39;")

    out = SHELL.format(
        fonts=FONTS,
        tokens=indent(TOKENS, 4),
        body=body,
        props=props,
        vals=indent(vals, 4),
    )
    (ROOT / f"{name}.dc.html").write_text(out)
    print(f"built {name}.dc.html  ({len(out):,} bytes)")


for artboard in sorted(p.stem for p in PARTS.glob("*.html")):
    build(artboard)

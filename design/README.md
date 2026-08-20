# Design canvas

The SproutOS dashboard design system, published at
<https://claude.ai/code/artifact/03846c23-1d43-41c5-a863-7768aaef7827>.

## Editing

Never edit the `.dc.html` files or `sproutos-dashboard-design-system.html` directly — both are
generated. Edit the sources in `parts/`, then:

```bash
./build.py
```

Each artboard is up to three files in `parts/`:

| File                | Holds                                       |
| ------------------- | ------------------------------------------- |
| `<Name>.html`       | markup that goes inside `<x-dc>` (required) |
| `<Name>.vals.js`    | the body of `renderVals()` (optional)       |
| `<Name>.props.json` | the `data-props` attribute (optional)       |

`canvas.json` positions the artboards, names the pages, and carries the sticky notes.

## Why there is a build step

A `.dc.html` artboard must be self-contained — the canvas runtime resolves images out of the
document but not stylesheets. Without a build step the design tokens would be copy-pasted into
every artboard and drift silently from the code. `build.py` injects `_tokens.css` into each
artboard's `<helmet>` instead, and `_tokens.css` is a verbatim copy of
`lib/typescript/ui/base/src/theme.css`.

**If you change a token in `theme.css`, change it here and rebuild.** A design that disagrees with
the code is worse than no design.

## The rules the system encodes

- **Amber marks money and nothing else.** Not warnings, not highlighted rows, not chart series. The
  chart ramp steps through leaf, teal, blue, lime, and magenta specifically so a series can never be
  mistaken for a cost.
- **Dashboard density**: 32px controls, 28px table rows. The marketing site's 44px hero button
  exists as `size="xl"` and is not used here — a project list has to fit on a laptop screen.
- **Same tokens as marketing, different atmosphere.** The radial haze, the 4.5rem `soil-grid`, and
  the scroll reveals stay on the marketing side. Someone reading a bill is working, not browsing.
- **Ids and money are mono and tabular** so columns line up to the digit.
- **Every list screen owes an empty, a loading, and an error state.** All three are on the component
  sheet; a screen that ships with only the happy path is unfinished.
- **Icons are inline stroke SVG** on a 16/20/24 grid. Never emoji.

## Publishing an update

```bash
./build.py
node "<design skill base>/seed-canvas.mjs" \
  --template "<design skill base>/payload.template.html" \
  --out sproutos-dashboard-design-system.html \
  --title "SproutOS Dashboard" \
  --artboard Main.dc.html --artboard AgentChat.dc.html \
  --artboard Tokens.dc.html --artboard Components.dc.html \
  --canvas canvas.json
```

Then republish the same file path to keep the URL. If someone has edited the canvas in the browser
and saved, read it back first with `--extract` rather than overwriting their work.

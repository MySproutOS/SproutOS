# `@ui/base`

The component library shared by the marketing site and both SPAs. Tokens live in
`src/theme.css`, utilities in `src/utilities.css`, components in `src/ui/`, and everything is
re-exported from `src/index.ts`.

```tsx
import { Button } from "@ui/base/ui/button" // per-module, or
import { Card, Money, Table } from "@ui/base/index" // the barrel
```

Both paths work in the SPAs and in Next.js. There is no bundled build step — consumers alias
`@ui/base` straight at `src/`.

## Base UI only, and what that costs you

Every interactive primitive is [`@base-ui/react`](https://base-ui.com). No `@radix-ui/*`, ever,
including transitively — see [ADR 0008](../../../docs/adr/0008-base-ui-only.md). Two consequences
show up constantly:

**There is no `asChild`.** Base UI takes a `render` prop instead:

```tsx
<Button render={<Link to="/store" />}>Go to store</Button>
```

`Button` infers `nativeButton` from that element (`src/lib/render.ts`), so rendering an `<a>` does
not trip Base UI's "expected a native `<button>`" console error. Pass `nativeButton` yourself to
override the inference.

**Composite parts have required parents.** `DropdownMenuGroupLabel` must sit inside
`DropdownMenuGroup`, and `SelectGroupLabel` inside `SelectGroup`. Base UI reads the group's context
to wire `aria-labelledby` and _throws_ when it is missing — the symptom is a blank screen with
`MenuGroupContext is missing`, not a warning.

## No `dark:` utilities. Not one.

[ADR 0010](../../../docs/adr/0010-dark-only-theme.md) assumed a `dark:` class in a dark-only theme
would resolve to nothing. It does not. Tailwind v4 ships `dark` as a **built-in
`prefers-color-scheme` variant**, so with no `@custom-variant dark` defined, every `dark:` utility
is live for readers whose OS is in dark mode and dead for everyone else. That is worse than the
failure the ADR was guarding against: it makes one product render two ways.

They have all been removed from `button.tsx` and `checkbox.tsx`, and `:root` now carries
`color-scheme: dark` so native scrollbars and form controls match the page. If you paste a component
in from anywhere, strip its `dark:` classes and fold the dark value into the base class.

> `design/_tokens.css` is a verbatim copy of `theme.css` and has not been re-synced with the
> `color-scheme` line — that file is owned by whoever runs `design/build.py`.

## Amber is money

`--husk` marks costs, balances, prices, and usage totals. Nothing else — not a warning, not a
highlighted row, not a chart series. `warning` has its own token, and the chart ramp deliberately
steps through leaf, teal, blue, lime, and magenta so a series can never be mistaken for a price.

The rule is enforceable by grep because amber has exactly two homes:

- `<Money>` — every figure that costs the reader something goes through it.
- `<TableCell money>` — the same, right-aligned, for table columns.

`text-husk` appearing anywhere else is a review failure. The one deliberate exception is the
sidebar's credit meter, which passes `indicatorClassName="bg-husk"` to `Progress` — that prop exists
precisely so the amber fill is opt-in rather than the default for every progress bar in the product.

Money and ids are always mono and tabular (`tnum`) so columns line up to the digit.

Both are presentational and take an already-formatted string. Amounts are `bigint` micro-USD
everywhere upstream, and `@lib/billing`'s `formatMicroUsd` turns them into text — `@ui/base` stays
out of that so the library never has to know how a currency is rendered.

## Density

Dashboard density, from `design/parts/`:

| Element                | Size                             |
| ---------------------- | -------------------------------- |
| Controls               | 32px (`h-8`)                     |
| Small controls         | 28px (`h-7`)                     |
| Table rows             | 28px (`h-7`), 30px header        |
| Sidebar / control text | 13px                             |
| Content text           | 14px (`text-sm`)                 |
| Badges, meta           | 11px                             |
| Eyebrows               | 10-11px mono, uppercase, tracked |

The marketing site's 44px hero button lives on as `size="xl"` and is not used here: a project list
has to fit on a laptop screen.

> The component sheet's own caption says "28px rows" while its rendered markup draws 34px. `TableRow`
> follows the caption, which is also what `design/README.md` and the phase brief state.

## Every list screen owes three states

Empty, loading, and error — a screen that ships with only the happy path is unfinished.

- **Empty** — `EmptyState`, dashed border. The dashed edge is what distinguishes "you have nothing"
  from "something failed to load" at a glance.
- **Loading** — `Skeleton` / `SkeletonText`, never `Spinner`. On a list the shape of the answer is
  known before it arrives, so the placeholder should be that shape. `Spinner` is for indeterminate
  work with no known shape: a pending mutation, a button mid-submit.
- **Error** — `Alert variant="destructive"` with a retry action.

## `SproutMark`

The one hand-drawn glyph. Icons are `lucide-react`, imported individually, never emoji — but the
sprout is the brand mark, and its paths are lifted verbatim from `design/parts/Components.html` so
the empty state matches the artboard stroke for stroke. lucide's own `Sprout` is a near-miss that
reads as a different plant beside the logo.

## Components

`alert` · `avatar` · `badge` · `button` · `card` · `checkbox` · `dialog` · `dropdown-menu` ·
`empty-state` · `input` · `label` · `money` · `progress` · `scroll-area` · `select` · `separator` ·
`sheet` · `skeleton` · `spinner` · `sprout-mark` · `switch` · `table` · `tabs` · `textarea` ·
`tooltip`

`Sheet` is a `Dialog` anchored to an edge rather than a second overlay stack — one portal, one focus
trap, which is the whole reason ADR 0008 rules out mixing component libraries.

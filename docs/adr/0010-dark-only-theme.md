# 0010. The theme is dark-only, with tokens on bare `:root`

- Status: Accepted
- Date: 2026-08-20

## Context

The soil-and-receipt palette ported from the waiting-list landing page is a dark theme with no light
variant. Three positions appear in the research.

The bootstrap notes leave it open — open question 4: "the soil theme is dark-only and has no `.dark`
variant, but the scaffold's `theme.css` defines both — do the SPAs ship dark-only too, or do we owe a
light palette?" — while Decision 13 puts the OKLCH tokens on bare `:root` with no `.dark` selector.

The dashboard-shell notes, Decision 7, already decided: "**The theme is dark-only**: port the
soil/receipt tokens into `@ui/base/src/theme.css`, keep `@custom-variant dark (&:is(.dark *))`, and
hardcode `class="dark"` on `<html>` in both `index.html` files and the Next layout so every shadcn
`dark:` utility still resolves."

Those two are not the same design. Tokens on bare `:root` plus a hardcoded `.dark` class is a
contradiction: the class exists to select an override that is never defined.

## Decision

Dark-only. The OKLCH token block lives on bare `:root` in
`lib/typescript/ui/base/src/theme.css`. There is **no** `.dark` selector, no
`@custom-variant dark`, and no `class="dark"` on `<html>`.

Any component copied from shadcn that carries `dark:` utilities has them removed at install time,
because with no dark variant defined they resolve to nothing and silently drop styling.

## Consequences

- One palette to maintain, one set of contrast decisions to verify, one visual review per screen.
- `prefers-color-scheme` is ignored. A user on a light-mode OS gets the dark product. That is a
  deliberate brand choice, matching the marketing site.
- Add `color-scheme: dark` on `:root` so native form controls, scrollbars, and the browser's own UI
  match rather than rendering light chrome against a dark page.
- Adding light mode later is a real project, not a flag flip: every token gets a second value, every
  `dark:`-stripped component gets audited, and the marketing site's radial haze and receipt
  treatments need light equivalents. It is not on the roadmap.
- `sonner`'s `next-themes` dependency has nothing to switch. Pass a fixed theme rather than wiring
  a provider.
- The amber `--husk` token stays reserved for money — costs, balances, statements, and nothing else.
  A single-theme palette is what makes that rule enforceable by eye during review.

## Alternatives considered

**Ship both palettes now.** Rejected: doubles the design surface of seventeen screens before a single
one exists, and the soil palette has no designed light counterpart to port.

**Dark-only but keep the `.dark` class scaffolding** (the dashboard-shell design). Rejected: it
preserves the appearance of theme support without the substance, and the first person to add a
`dark:` utility will believe it works.

## Amendment, 2026-08-20

The original decision assumed `dark:` utilities would be inert in a dark-only theme. **They are not.**
Tailwind v4 ships `dark` as a built-in `prefers-color-scheme` variant, so a `dark:` class resolves
against the _reader's operating system_ rather than against our theme — `button.tsx` and
`checkbox.tsx` were measurably rendering two different ways depending on who opened them.

Two consequences, both applied:

- `:root` declares `color-scheme: dark`, so the browser's own form controls and scrollbars match.
- `dark:` utilities are banned outright. There is no light palette for them to switch to, and their
  presence means a component's appearance depends on something we do not control.

Found by loading the dashboard in a browser, not by reading the CSS.

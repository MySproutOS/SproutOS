# 0009. Fonts ship as `@fontsource-variable/*` in all three apps

- Status: Accepted
- Date: 2026-08-20

## Context

Two areas designed two delivery paths for the same three CSS variables.

The bootstrap notes, Decision 14: "Next.js keeps `next/font/google` (`Bricolage_Grotesque`,
`Geist`, `Geist_Mono` → `--font-bricolage/--font-geist/--font-geist-mono`); the SPAs add
`@fontsource-variable/bricolage-grotesque` next to the existing geist imports and declare the same
three vars in `app.css`."

The dashboard-shell notes, Decision 8: "**Fonts come from `@fontsource-variable/*`, not
`next/font`**, on all three apps — `next/font/google` cannot run in Vite, and the scaffold already
ships the `viteStaticCopy` plumbing."

Both are correct that `next/font` cannot reach a Vite build. They differ on whether the Next.js app
keeps its own path. The bootstrap design would leave the marketing site and the two SPAs rendering
the same typeface from two different font files, subsetted differently, with two sets of
`@font-face` declarations and two failure modes.

## Decision

`@fontsource-variable/bricolage-grotesque`, `@fontsource-variable/geist`, and
`@fontsource-variable/geist-mono` in all three applications. `next/font` is not used. The three CSS
variables (`--font-bricolage`, `--font-geist`, `--font-geist-mono`) are declared once in
`lib/typescript/ui/base/src/theme.css`, which the Next.js app and both SPAs already import.

## Consequences

- One delivery path, one subset, one set of `@font-face` rules. The marketing site and the dashboard
  are visually identical in typography, which is the entire point of the phase-1.5 design direction
  ("same tokens, dashboard density").
- Both `vite.config.ts` files extend their existing `fontsourceFiles()` list in `viteStaticCopy`.
  The Next.js app serves the same files from `node_modules` through its own asset pipeline.
- We lose `next/font`'s automatic self-hosting and its layout-shift mitigation via `size-adjust`
  fallback metrics. Compensate with explicit `font-display: swap` and a real fallback stack on each
  variable.
- Font files are now a workspace dependency pinned in the single `pnpm-workspace.yaml` catalog,
  which is where the version drift in the research notes gets reconciled anyway.
- Removing `next/font/google` also removes a build-time network fetch from the Next.js build, which
  matters once the site builds inside a container on EKS rather than on Vercel.

## Alternatives considered

**Keep `next/font` on the website, Fontsource in the SPAs** (the bootstrap design). Rejected: two
subsets of the same typeface shipped to the same user across two origins, and a visual divergence
that only shows up when someone compares the nav on `/` with the nav in `/dashboard`.

**Self-host hand-subsetted WOFF2 in `@ui/base`.** Smallest possible payload. Rejected as premature
optimization with a real maintenance cost; revisit if font weight becomes a measured LCP problem.

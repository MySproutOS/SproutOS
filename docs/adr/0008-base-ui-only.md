# 0008. Base UI is the only component library; no Radix

- Status: Accepted
- Date: 2026-08-20

## Context

Radix is simultaneously banned and required across the notes.

The bootstrap notes: "`@ui/base`'s `Button` is **Base UI (`@base-ui/react@1.7.0`)**, not Radix…
**Do not bring `@radix-ui/*` into the repo**."

The store, projects, agent, billing, workflows, and data-plane notes each say "Missing shadcn
**new-york** primitives to add: …" — and the new-york style is Radix-based. Six areas therefore
prescribe adding Radix by another name.

The dashboard-shell notes pick a third path, shadcn's `base-nova` style (Base UI under the hood),
and concede one leaf dependency: "`@radix-ui/react-use-controllable-state` (the one unavoidable
Radix leaf, pulled by `reasoning`)". That same area states the cost of mixing plainly: "**Mixing
Base UI and Radix** silently doubles the popover/portal stack and produces two incompatible `Slot`
implementations."

The scaffold's `@ui/base` today exports exactly three components — `Button`, `Checkbox`, `Label` —
against a `frontend-components` skill that documents roughly thirty-five. That drift is a separate
phase-1 fix, but it means the library choice is being made now, before the components exist, which
is the cheapest possible moment.

## Decision

Base UI (`@base-ui/react`) only, installed into `@ui/base` from shadcn's `base-nova` style. No
`@radix-ui/*` package enters the repo, including transitively; `pnpm why @radix-ui/react-slot` is a
CI check.

## Consequences

- Every "add these new-york primitives" list in the research notes is translated to its `base-nova`
  equivalent before use. The component set itself is unchanged; the registry URL is
  `https://ui.shadcn.com/r/styles/base-nova/<name>.json`.
- **Base UI's `Button` has no `asChild`** — it takes a `render` prop. Copy-pasted shadcn
  `<Button asChild><a/></Button>` will type-error. The GitHub login button in particular must use
  `render`.
- `form` is an empty stub in `base-nova` — there is no react-hook-form wrapper. Forms are built with
  `Field` + `@tanstack/react-form`, and the `frontend-components` skill's `Form`/`FormField` rows are
  wrong and must be corrected.
- Deleting the waitlist removes nearly all the Radix surface we inherited; the landing page needs
  only `Button`.
- The AI-chat primitives, whose registry pulls the Radix `use-controllable-state` leaf, must be
  vendored or re-pointed rather than installed blind.
- Base UI's size scale differs from new-york's (`default: h-8`, `lg: h-9` vs `lg: h-10`). Restoring
  the hero CTA's visual weight is one `cva` edit in `@ui/base`, not a new dependency.

## Alternatives considered

**shadcn new-york / Radix**, as six areas assumed. Rejected: it means replacing the scaffold's
existing `@ui/base` components, and the dashboard design system in phase 1.5 is being built against
Base UI's primitives.

**Both, with a boundary.** Rejected on the doubled portal stack and the two incompatible `Slot`
implementations — a class of bug that surfaces as focus traps and z-index fights, months later.

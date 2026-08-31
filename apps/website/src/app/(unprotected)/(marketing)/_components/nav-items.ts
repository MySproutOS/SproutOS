/**
 * The marketing navigation tree, in one place.
 *
 * The desktop dropdowns, the mobile sheet and the footer columns all read this, because three
 * hand-maintained copies of the same tree is how a site ends up with a footer that links to a page
 * the nav has already renamed.
 *
 * Every top-level item is a menu, not a link — including Docs. Nothing in `NAV` is clickable at the
 * top level, so there is no `href` on `NavGroup` to tempt one back in.
 */

export type NavItem = {
  href: string
  label: string
  /** One line shown under the label in the dropdown. Keep it to a clause. */
  description: string
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

export const NAV: NavGroup[] = [
  {
    label: "Personalization",
    items: [
      {
        href: "/personalize",
        label: "Personalize apps and websites",
        description: "Change an app that already works, in a sentence",
      },
      {
        href: "/store",
        label: "Web store",
        description: "Open source apps ready to fork into your account",
      },
      {
        href: "/download",
        label: "Android",
        description: "Your apps and websites on your phone",
      },
    ],
  },
  {
    label: "Data ownership",
    items: [
      {
        href: "/data-ownership",
        label: "Owning your data",
        description: "One database you can query, and leave with",
      },
      {
        href: "/data-ownership/developers",
        label: "For developers",
        description: "Sign in with SproutOS and give users their own database",
      },
    ],
  },
  {
    label: "Platform",
    items: [
      {
        href: "/platform/databases",
        label: "Databases",
        description: "Postgres, Valkey and OpenSearch that sleep when idle",
      },
      {
        href: "/platform/workflows",
        label: "Workflows",
        description: "Automations billed by the run, not by the month",
      },
      {
        href: "/platform/websites",
        label: "Websites",
        description: "Sites that run code, for cents a month",
      },
      {
        href: "/platform/ai-agent",
        label: "AI agent",
        description: "Builds the change, then keeps your fork current",
      },
    ],
  },
  {
    label: "Business",
    items: [
      {
        href: "/business/employees",
        label: "For employees",
        description: "Automate your own work without asking anyone",
      },
      {
        href: "/business/it",
        label: "For IT",
        description: "Under every approval threshold, with nothing to run",
      },
    ],
  },
  {
    label: "Docs",
    items: [
      {
        href: "/docs/users",
        label: "Docs for users",
        description: "Running apps, billing, and what the limits are",
      },
      {
        href: "/docs/developers",
        label: "Docs for developers",
        description: "Deploying, background workers, and the OAuth API",
      },
    ],
  },
]

/** Footer-only columns: real pages that are not part of the product argument. */
export const FOOTER_EXTRA: NavGroup[] = [
  {
    label: "Resources",
    items: [
      { href: "/docs", label: "Documentation", description: "" },
      { href: "/blog", label: "Blog", description: "" },
      { href: "/store", label: "App store", description: "" },
      { href: "/download", label: "Android & CLI", description: "" },
    ],
  },
  {
    label: "Legal",
    items: [
      { href: "/legal/terms", label: "Terms of Service", description: "" },
      { href: "/legal/privacy", label: "Privacy", description: "" },
      { href: "/legal/conduct", label: "Code of Conduct", description: "" },
    ],
  },
]

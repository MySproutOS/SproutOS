import { SproutMark } from "@website/components/icons"
import Link from "next/link"
import { FOOTER_EXTRA, NAV } from "./nav-items"

const RESOURCES = FOOTER_EXTRA[0]
const LEGAL = FOOTER_EXTRA[1]

/**
 * The footer carries the same tree as the nav plus the pages that are not part of the product
 * argument. It used to be a wordmark and a copyright line, which meant `/legal/*` — pages a visitor
 * is entitled to find — were linked from nowhere on the site.
 *
 * Legal sits in the bottom bar rather than in a column of its own: it is the one group people look
 * for at the very bottom, and a seventh column makes the others too narrow to read.
 */
export function SiteFooter() {
  const columns = RESOURCES === undefined ? NAV : [...NAV, RESOURCES]

  return (
    <footer className="border-t rule-soft py-14">
      <div className="container-page">
        <Link href="/" className="inline-flex items-center gap-2.5">
          <SproutMark className="size-5 text-primary" />
          <span className="font-display text-sm font-semibold tracking-tight">SproutOS</span>
        </Link>
        <p className="mt-3 max-w-md text-sm text-muted-foreground text-pretty">
          Personalize an app that already works, and keep the database it runs on.
        </p>

        <div className="mt-12 grid gap-10 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
          {columns.map((group) => (
            <div key={group.label}>
              <p className="eyebrow mb-3">{group.label}</p>
              <ul className="flex flex-col gap-2">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-3 border-t rule-soft pt-6 sm:flex-row sm:items-center">
          <p className="font-mono text-xs text-muted-foreground">
            © {new Date().getFullYear()} SproutOS · Open source infrastructure
          </p>
          <ul className="flex flex-wrap gap-4">
            {LEGAL?.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  )
}

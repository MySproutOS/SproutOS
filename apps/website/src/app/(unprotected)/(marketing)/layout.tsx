import type { ReactNode } from "react"
import { Nav } from "./_components/nav"
import { SiteFooter } from "./_components/site-footer"

/**
 * Chrome for every public page a visitor can browse to.
 *
 * `/login`, `/oauth`, `/github` and `/skills` are deliberately outside this group: a consent screen
 * with a marketing header inviting you elsewhere is a worse consent screen.
 *
 * The header is `fixed`, so the content needs to start below it. Pages with their own full-bleed
 * hero (the landing page) opt out by pulling themselves back up — everything else gets the padding
 * and does not have to think about it.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      <main className="pt-16">{children}</main>
      <SiteFooter />
    </>
  )
}

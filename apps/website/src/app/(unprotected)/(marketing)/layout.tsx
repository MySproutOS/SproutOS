import { repositoryStars } from "@website/lib/github-stars"
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
export default async function MarketingLayout({ children }: { children: ReactNode }) {
  // Fetched here rather than in `Nav`, which is a client component: the count is one number, the
  // layout already runs on the server, and this keeps the request off every visitor's browser.
  const stars = await repositoryStars()

  return (
    <>
      <Nav stars={stars} />
      <main className="pt-16">{children}</main>
      <SiteFooter />
    </>
  )
}

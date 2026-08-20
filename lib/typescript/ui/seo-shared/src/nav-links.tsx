import { SeoLink } from "@ui/seo-shared/_internal/seo-link"

export type NavLinkItem = { href: string; label: string }

/**
 * Shared nav links rendered with SeoLink, so each frontend gets its native Link
 * component (next/link on the website, TanStack Router Link in the SPAs) while
 * still emitting crawlable anchors.
 */
export function NavLinks({ links, className }: { links: NavLinkItem[]; className?: string }) {
  return (
    <nav className={className}>
      <ul className="flex items-center gap-4">
        {links.map((link) => (
          <li key={link.href}>
            <SeoLink
              href={link.href}
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {link.label}
            </SeoLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

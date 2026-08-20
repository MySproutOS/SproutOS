import { Link } from "@tanstack/react-router"
import type { SeoLinkProps } from "@ui/seo-shared/_internal/seo-link"

// oxlint-disable-next-line no-unused-vars
export function SeoLink({ href, children, ...rest }: SeoLinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  )
}

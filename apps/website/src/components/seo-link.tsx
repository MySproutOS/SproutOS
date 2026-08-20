import NextLink from "next/link"
import type { SeoLinkProps } from "@ui/seo-shared/_internal/seo-link"

// oxlint-disable-next-line no-unused-vars
export function SeoLink({ href, children, ...rest }: SeoLinkProps) {
  return (
    <NextLink href={href} {...rest}>
      {children}
    </NextLink>
  )
}

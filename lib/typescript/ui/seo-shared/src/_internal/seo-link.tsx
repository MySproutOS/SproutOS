import { ComponentProps } from "react"

export type SeoLinkProps = ComponentProps<"a"> & { href: string }

/**
 * There are other SeoLinks from NextJS and Tanstack Router based frontends that replace this
 * component. This is essentially a template to be used for build purposes; NextJS and Tanstack
 * Router based frontends will then replace this with their frontend-specific Link component.
 */
export function SeoLink({ children, ...props }: SeoLinkProps) {
  return <a {...props}>{children}</a>
}

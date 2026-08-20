import { cn } from "@ui/base/lib/utils"
import { Button } from "@ui/base/ui/button"
import { GitHubMark } from "@website/components/icons"
import { ArrowRight } from "lucide-react"

type Props = {
  children?: React.ReactNode
  className?: string
  /** A path on this site to return to after signing in. Validated server-side before it is used. */
  next?: string
  size?: React.ComponentProps<typeof Button>["size"]
  variant?: React.ComponentProps<typeof Button>["variant"]
  withArrow?: boolean
}

/**
 * Every call to action on the marketing site.
 *
 * A real navigation rather than a dialog, so it works without JavaScript. The
 * target is a Route Handler that 302s to GitHub, not a Next.js page, so next/link
 * would prefetch an RSC payload that does not exist — hence the plain anchor.
 */
export function LoginWithGitHubButton({
  children = "Login with GitHub",
  className,
  next,
  size = "default",
  variant = "default",
  withArrow = true,
}: Props) {
  return (
    <Button
      size={size}
      variant={variant}
      className={cn("group gap-2", className)}
      // oxlint-disable-next-line next/no-html-link-for-pages, jsx-a11y/anchor-has-content, jsx-a11y/control-has-associated-label -- Route Handler, not a page; Base UI merges children into the rendered anchor
      render={
        <a
          href={
            next === undefined ? "/login/github" : `/login/github?next=${encodeURIComponent(next)}`
          }
          aria-label="Login with GitHub"
        />
      }
    >
      <GitHubMark className="size-4" />
      {children}
      {withArrow ? (
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      ) : null}
    </Button>
  )
}

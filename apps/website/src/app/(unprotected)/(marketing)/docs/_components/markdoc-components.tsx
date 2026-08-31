import Link from "next/link"
import type { ReactNode } from "react"

/*
  The components Markdoc renders into.

  All server components — none of this is interactive, and the whole point of rendering the docs
  through React on the server is that a crawler and a reader with JavaScript disabled both get the
  prose in the initial HTML with no hydration cost.
*/

/**
 * A heading with its anchor.
 *
 * Clearing the fixed header is `scroll-padding-top` on `html`, set once in `globals.css` for the
 * whole site — not a `scroll-mt` here as well. Both apply, and having both put a heading 176px down
 * the viewport when the header is 64px tall. The anchor link is `aria-hidden` and appears on hover: it is
 * a convenience for copying a deep link, and announcing "link" before every heading to a screen
 * reader makes the document harder to navigate, not easier.
 */
export function Heading({
  id,
  level,
  children,
}: {
  id: string
  level: number
  children: ReactNode
}) {
  const Tag = `h${Math.min(Math.max(level, 2), 6)}` as "h2" | "h3" | "h4" | "h5" | "h6"

  return (
    <Tag id={id} className="group">
      {children}
      <a
        href={`#${id}`}
        aria-hidden="true"
        tabIndex={-1}
        className="ml-2 text-primary opacity-0 no-underline transition-opacity group-hover:opacity-100"
      >
        #
      </a>
    </Tag>
  )
}

/**
 * Links out of a doc.
 *
 * Internal links go through `next/link` — it still renders a plain crawlable `<a href>`, and adds
 * prefetching and client-side navigation. External links open in a new tab with `noreferrer
 * noopener`, which is both the security posture and the one the rest of the site already uses.
 */
export function DocLink({ href, children }: { href?: string; children: ReactNode }) {
  const target = href ?? "#"
  const external = /^https?:\/\//.test(target)

  if (external) {
    return (
      <a href={target} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    )
  }

  return <Link href={target}>{children}</Link>
}

/**
 * A fenced code block.
 *
 * `data-language` rather than a printed label, so the language is available to CSS and to anyone
 * reading the markup without occupying a corner of every sample.
 */
export function CodeBlock({ language, children }: { language?: string; children: ReactNode }) {
  return (
    <pre data-language={language} className="overflow-x-auto">
      <code>{children}</code>
    </pre>
  )
}

export const MARKDOC_COMPONENTS = { Heading, DocLink, CodeBlock }

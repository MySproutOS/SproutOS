import type { ReactNode } from "react"
import { HashScroll } from "./_components/hash-scroll"
import { DocsSidebar, DocsSidebarSheet } from "./_components/sidebar"

/**
 * The docs shell: a persistent tree on the left, content on the right.
 *
 * Before this, `/docs` was seven pages with no nav, no footer and no way to get from one to the
 * next — the content existed and was effectively unreachable. The tree is the fix, and it is in a
 * layout rather than on each page so a new markdown file joins it by existing.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="container-page grid gap-10 py-12 lg:grid-cols-[16rem_1fr] lg:gap-14 lg:py-16">
      <HashScroll />
      <DocsSidebar />
      <div className="min-w-0">
        <DocsSidebarSheet />
        {children}
      </div>
    </div>
  )
}

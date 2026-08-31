"use client"

import { DOC_AUDIENCES } from "@website/lib/docs"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@ui/base/ui/sheet"
import { ListIcon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"

/**
 * One sidebar carrying both audiences.
 *
 * The Docs menu in the header offers "for users" and "for developers" as two doors, but they open
 * onto the same site — a user who follows a link into `oauth-applications` should be able to see
 * where they are and walk back out, not find themselves in a second documentation site with no
 * bridge. So both trees are always rendered, and only the highlight moves.
 */
function Tree({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-8">
      {DOC_AUDIENCES.map((group) => {
        const audienceHref = `/docs/${group.slug}`
        const active = pathname === audienceHref

        return (
          <div key={group.audience}>
            <Link
              href={audienceHref}
              onClick={onNavigate}
              className={`block text-sm font-semibold tracking-tight transition-colors ${
                active ? "text-primary" : "text-foreground hover:text-primary"
              }`}
            >
              {group.label}
            </Link>

            <div className="mt-4 flex flex-col gap-5">
              {group.categories.map((category) => (
                <div key={category.name}>
                  <p className="eyebrow mb-2">{category.name}</p>
                  <ul className="flex flex-col border-l rule-soft">
                    {category.docs.map((doc) => {
                      const href = `/docs/${doc.slug}`
                      const current = pathname === href
                      return (
                        <li key={doc.slug}>
                          <Link
                            href={href}
                            onClick={onNavigate}
                            aria-current={current ? "page" : undefined}
                            className={`-ml-px block border-l py-1.5 pl-4 text-sm transition-colors ${
                              current
                                ? "border-primary font-medium text-primary"
                                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                            }`}
                          >
                            {doc.title}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </nav>
  )
}

export function DocsSidebar() {
  return (
    <div className="hidden lg:block">
      {/* `top` clears the fixed header; the sidebar scrolls independently once the tree outgrows it. */}
      <div className="sticky top-24 max-h-[calc(100dvh-8rem)] overflow-y-auto pr-4 pb-8">
        <Tree />
      </div>
    </div>
  )
}

export function DocsSidebarSheet() {
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className="mb-8 inline-flex items-center gap-2 rounded-lg border rule-soft px-3 py-2 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:hidden">
        <ListIcon className="size-4" />
        All documentation
      </SheetTrigger>
      <SheetContent side="left" className="w-80">
        <SheetHeader>
          <SheetTitle>Documentation</SheetTitle>
        </SheetHeader>
        <SheetBody className="px-4 py-5">
          <Tree
            onNavigate={() => {
              setOpen(false)
            }}
          />
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

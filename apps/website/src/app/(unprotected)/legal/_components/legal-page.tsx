import Link from "next/link"
import type { ReactNode } from "react"
import { Nav } from "../../_components/landing/nav"
import { SiteFooter } from "../../_components/landing/site-footer"

/**
 * The frame every legal document sits in.
 *
 * Shared so the three cannot drift apart in their navigation or in the date they claim to have been
 * updated. A Terms page and a Privacy page disagreeing about the same company is the kind of
 * inconsistency readers notice and lawyers charge to fix.
 */
export const LEGAL_UPDATED = "24 August 2026"

export const COMPANY = {
  name: "Ur LLC",
  address: "1617 Washtenaw Ave, Ann Arbor, Michigan 48104, United States",
  contact: "legal@sproutos.me",
} as const

const DOCUMENTS = [
  { href: "/legal/terms", label: "Terms of Service" },
  { href: "/legal/privacy", label: "Privacy Policy" },
  { href: "/legal/conduct", label: "Code of Conduct" },
] as const

export function LegalPage({
  title,
  summary,
  children,
}: {
  title: string
  summary: string
  children: ReactNode
}) {
  return (
    <>
      <Nav />
      <main className="container-page py-16 sm:py-24">
        <div className="mx-auto max-w-3xl">
          <p className="eyebrow">Legal</p>
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            {title}
          </h1>
          <p className="mt-4 text-pretty text-muted-foreground">{summary}</p>
          <p className="mt-6 font-mono text-xs text-muted-foreground">
            Last updated {LEGAL_UPDATED} · {COMPANY.name}, {COMPANY.address}
          </p>

          <nav className="rule-soft mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t pt-6">
            {DOCUMENTS.map((document) => (
              <Link
                key={document.href}
                href={document.href}
                className="font-mono text-xs text-muted-foreground hover:text-primary"
              >
                {document.label}
              </Link>
            ))}
          </nav>

          <div className="mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground">
            {children}
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-lg font-semibold text-foreground">{heading}</h2>
      {children}
    </section>
  )
}

import Link from "next/link"
import { COMPANY, LegalPage } from "./_components/legal-page"

export const metadata = { title: "Legal · SproutOS" }

const DOCUMENTS = [
  {
    href: "/legal/terms",
    title: "Terms of Service",
    blurb:
      "Credits and how they are drawn down, what happens when they run out, and what we do and do not promise about uptime.",
  },
  {
    href: "/legal/privacy",
    title: "Privacy Policy",
    blurb:
      "What we collect, which country each piece of it sits in, who else sees it, and how long we keep it.",
  },
  {
    href: "/legal/conduct",
    title: "Community Code of Conduct",
    blurb:
      "The rules for the shared catalogue and for apps we sign and publish under our own name.",
  },
] as const

export default function LegalIndexPage() {
  return (
    <LegalPage
      title="Legal"
      summary={`The agreements between you and ${COMPANY.name}, written to describe what the platform actually does.`}
    >
      <div className="grid gap-4">
        {DOCUMENTS.map((document) => (
          <Link
            key={document.href}
            href={document.href}
            className="rule-soft group rounded-lg border p-5 transition-colors hover:border-primary/50"
          >
            <h2 className="font-display text-base font-semibold text-foreground group-hover:text-primary">
              {document.title}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground text-pretty">{document.blurb}</p>
          </Link>
        ))}
      </div>
    </LegalPage>
  )
}

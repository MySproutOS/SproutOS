import { DOC_AUDIENCES } from "@website/lib/docs"
import type { Metadata } from "next"
import Link from "next/link"
import { DocSearch } from "./_components/search"

export const metadata: Metadata = {
  title: "Documentation · SproutOS",
  description:
    "How your application runs here, what it costs, and the handful of things that are different " +
    "from a server you rent by the month.",
  alternates: { canonical: "/docs" },
}

/**
 * The docs index.
 *
 * Statically rendered: the content is a TypeScript module, so there is nothing to fetch and no
 * reason for a visitor to wait on a server. The search below is the only client component.
 */
export default function DocsPage() {
  return (
    <>
      <h1 className="font-display text-3xl font-semibold tracking-tight">Documentation</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground text-pretty">
        How your application runs here, what it costs, and the handful of things that are different
        from a server you rent by the month.
      </p>

      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        {DOC_AUDIENCES.map((group) => (
          <div
            key={group.audience}
            className="relative rounded-2xl border rule-soft bg-card/60 p-6 transition-colors hover:border-primary/40"
          >
            <h2 className="font-display text-lg font-semibold tracking-tight">
              <Link href={`/docs/${group.slug}`} className="before:absolute before:inset-0">
                {group.label}
              </Link>
            </h2>
            <p className="mt-2 text-sm text-muted-foreground text-pretty">{group.summary}</p>
            <p className="mt-4 font-mono text-xs text-muted-foreground">
              {group.categories.map((category) => category.name).join(" · ")}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-14 max-w-2xl">
        <h2 className="eyebrow mb-4">Search everything</h2>
        <DocSearch />
      </div>
    </>
  )
}

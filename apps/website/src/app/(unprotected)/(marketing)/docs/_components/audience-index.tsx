import { audienceGroup, type DocAudience } from "@website/lib/docs"
import Link from "next/link"

/**
 * An audience landing page: the same tree the sidebar shows, laid out as cards.
 *
 * Both `/docs/users` and `/docs/developers` are this component with one argument, because the two
 * pages differ only in which half of the corpus they list — and two hand-written copies of a list
 * derived from front matter is how one of them ends up missing a page.
 */
export function AudienceIndex({ audience }: { audience: DocAudience }) {
  const group = audienceGroup(audience)

  return (
    <>
      <Link href="/docs" className="font-mono text-xs text-muted-foreground hover:text-primary">
        ← Documentation
      </Link>

      <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight">{group.label}</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground text-pretty">{group.summary}</p>

      <div className="mt-12 flex flex-col gap-12">
        {group.categories.map((category) => (
          <section key={category.name}>
            <h2 className="eyebrow mb-4">{category.name}</h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {category.docs.map((doc) => (
                <li
                  key={doc.slug}
                  className="relative rounded-2xl border rule-soft bg-card/60 p-5 transition-colors hover:border-primary/40"
                >
                  <h3 className="font-medium">
                    <Link href={`/docs/${doc.slug}`} className="before:absolute before:inset-0">
                      {doc.title}
                    </Link>
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground text-pretty">{doc.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}

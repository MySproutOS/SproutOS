import Link from "next/link"
import { notFound } from "next/navigation"
import { DOCS, docBySlug } from "@website/lib/docs"

/** Statically rendered, one file per page: there is nothing here a server needs to decide. */
export function generateStaticParams() {
  return DOCS.map((doc) => ({ slug: doc.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const doc = docBySlug(slug)
  return {
    title: doc === undefined ? "Documentation · SproutOS" : `${doc.title} · SproutOS`,
    description: doc?.summary,
  }
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const doc = docBySlug(slug)
  if (doc === undefined) notFound()

  return (
    <main className="container-page py-16">
      <Link href="/docs" className="font-mono text-xs text-muted-foreground hover:text-primary">
        ← Documentation
      </Link>

      <h1 className="mt-6 text-3xl font-semibold">{doc.title}</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">{doc.summary}</p>

      <div className="mt-10 max-w-2xl space-y-10">
        {doc.sections.map((section) => (
          <section key={section.heading}>
            <h2 className="text-lg font-medium">{section.heading}</h2>
            <div className="mt-3 space-y-4">
              {section.body.map((entry, index) =>
                Array.isArray(entry) ? (
                  // eslint-disable-next-line react/no-array-index-key
                  <ul key={index} className="list-disc space-y-2 pl-5 text-muted-foreground">
                    {entry.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  // eslint-disable-next-line react/no-array-index-key
                  <p key={index} className="text-muted-foreground">
                    {entry}
                  </p>
                ),
              )}
            </div>
          </section>
        ))}
      </div>
    </main>
  )
}

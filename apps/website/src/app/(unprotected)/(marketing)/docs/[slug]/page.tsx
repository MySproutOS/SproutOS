import Markdoc from "@markdoc/markdoc"
import { siteOrigin } from "@website/app/layout"
import {
  AUDIENCE_LABEL,
  AUDIENCE_SLUG,
  DOCS,
  type Doc,
  docBySlug,
  docNeighbours,
} from "@website/lib/docs"
import { docContent } from "@website/lib/docs-content"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import React from "react"
import { MARKDOC_COMPONENTS } from "../_components/markdoc-components"

/** Statically rendered, one file per page: there is nothing here a server needs to decide. */
export function generateStaticParams() {
  return DOCS.map((doc) => ({ slug: doc.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const doc = docBySlug(slug)
  if (doc === undefined) return { title: "Documentation · SproutOS" }

  const url = `/docs/${doc.slug}`
  return {
    title: `${doc.title} · SproutOS`,
    description: doc.summary,
    alternates: { canonical: url },
    openGraph: { type: "article", title: doc.title, description: doc.summary, url },
  }
}

/**
 * `TechArticle` plus a breadcrumb, which is what a documentation page actually is.
 *
 * This is the part of a docs page a search engine cannot infer from the prose: that it belongs to a
 * documentation set, sits under an audience, and is about one named thing. The breadcrumb is what
 * produces a `Documentation › For developers › Connect to services` line under a result rather than
 * a bare URL.
 */
function structuredData(doc: Doc) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        "@id": `${siteOrigin}/docs/${doc.slug}`,
        headline: doc.title,
        description: doc.summary,
        articleSection: doc.category,
        inLanguage: "en",
        isPartOf: {
          "@type": "WebSite",
          "@id": `${siteOrigin}/#website`,
          name: "SproutOS",
          url: siteOrigin,
        },
        publisher: { "@type": "Organization", name: "SproutOS", url: siteOrigin },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Documentation", item: `${siteOrigin}/docs` },
          {
            "@type": "ListItem",
            position: 2,
            name: AUDIENCE_LABEL[doc.audience],
            item: `${siteOrigin}/docs/${AUDIENCE_SLUG[doc.audience]}`,
          },
          { "@type": "ListItem", position: 3, name: doc.title },
        ],
      },
    ],
  }
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const doc = docBySlug(slug)
  if (doc === undefined) notFound()

  const content = docContent(doc.slug)
  if (content === undefined) notFound()

  const { previous, next } = docNeighbours(doc)

  /*
    Rendered on the server, into React elements rather than an HTML string.

    Two things follow, and both are the reason for doing it this way. There is no
    `dangerouslySetInnerHTML` around document content, so nothing in a doc can inject markup we did
    not write; and the prose is in the statically generated HTML, so a crawler reads the page
    without executing anything while the browser ships no Markdoc, no parser and no document source.
  */
  const body = Markdoc.renderers.react(content, React, { components: MARKDOC_COMPONENTS })

  return (
    <article>
      <script
        type="application/ld+json"
        // The argument is a JSON.stringify of the object literal built above from front matter, so
        // there is no path for document body content to reach this as markup.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData(doc)) }}
      />

      <nav aria-label="Breadcrumb" className="flex flex-wrap items-baseline gap-3">
        <Link
          href={`/docs/${AUDIENCE_SLUG[doc.audience]}`}
          className="font-mono text-xs text-muted-foreground hover:text-primary"
        >
          ← {AUDIENCE_LABEL[doc.audience]}
        </Link>
        <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
          /
        </span>
        <span className="eyebrow">{doc.category}</span>
      </nav>

      <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight">{doc.title}</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground text-pretty">{doc.summary}</p>

      <div className="mt-10 grid gap-12 xl:grid-cols-[minmax(0,42rem)_13rem]">
        <div className="prose prose-neutral max-w-2xl dark:prose-invert prose-headings:font-display prose-a:text-primary prose-code:before:content-none prose-code:after:content-none">
          {body}
        </div>

        {doc.headings.length > 1 && (
          <nav aria-label="On this page" className="hidden xl:block">
            <div className="sticky top-24">
              <p className="eyebrow mb-3">On this page</p>
              <ul className="flex flex-col gap-2 border-l rule-soft">
                {doc.headings.map((heading) => (
                  <li key={heading.id}>
                    <a
                      href={`#${heading.id}`}
                      className={`-ml-px block border-l border-transparent text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground ${
                        heading.level >= 3 ? "pl-8" : "pl-4"
                      }`}
                    >
                      {heading.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        )}
      </div>

      {(previous !== undefined || next !== undefined) && (
        <nav
          aria-label="Documentation"
          className="mt-16 grid gap-4 border-t rule-soft pt-8 sm:grid-cols-2"
        >
          {previous === undefined ? (
            <span />
          ) : (
            <Link
              href={`/docs/${previous.slug}`}
              className="rounded-xl border rule-soft p-4 transition-colors hover:border-primary/40"
            >
              <span className="eyebrow">Previous</span>
              <span className="mt-1.5 block text-sm font-medium">{previous.title}</span>
            </Link>
          )}
          {next === undefined ? null : (
            <Link
              href={`/docs/${next.slug}`}
              className="rounded-xl border rule-soft p-4 text-right transition-colors hover:border-primary/40 sm:col-start-2"
            >
              <span className="eyebrow">Next</span>
              <span className="mt-1.5 block text-sm font-medium">{next.title}</span>
            </Link>
          )}
        </nav>
      )}
    </article>
  )
}

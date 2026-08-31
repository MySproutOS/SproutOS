"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { AUDIENCE_LABEL, DOCS, searchDocs } from "@website/lib/docs"

/**
 * Client-side search over the docs.
 *
 * The whole corpus is a few pages of prose, so it ships with the page and is filtered in the
 * browser. A search endpoint would be a round trip, a rate limit and an index to keep in step, for
 * a body of text smaller than the JavaScript that would fetch it.
 *
 * Results span both audiences, and each one says which it belongs to: a user searching "database"
 * should be able to see that the first hit is developer reference before they open it.
 */
export function DocSearch() {
  const [query, setQuery] = useState("")
  const results = useMemo(() => searchDocs(query), [query])

  return (
    <div>
      <label className="block">
        <span className="sr-only">Search the documentation</span>
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          placeholder="Search the docs"
          className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
        />
      </label>

      <ul className="mt-6 space-y-4">
        {results.map(({ doc, heading }) => (
          <li key={doc.slug}>
            <Link href={`/docs/${doc.slug}`} className="group block">
              <span className="flex items-baseline gap-2">
                <span className="font-medium group-hover:text-primary">{doc.title}</span>
                <span className="eyebrow">{AUDIENCE_LABEL[doc.audience]}</span>
              </span>
              <p className="mt-1 text-sm text-muted-foreground">{doc.summary}</p>
              {heading === undefined ? null : (
                <p className="mt-1 font-mono text-xs text-muted-foreground">matches “{heading}”</p>
              )}
            </Link>
          </li>
        ))}
      </ul>

      {results.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Nothing matches “{query}”. There are {DOCS.length} pages; try a single word.
        </p>
      ) : null}
    </div>
  )
}

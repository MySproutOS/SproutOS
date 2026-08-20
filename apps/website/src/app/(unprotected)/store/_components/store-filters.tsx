import Link from "next/link"
import { storeHref, type StoreQuery } from "../query"

export type FilterCategory = { slug: string; name: string }

/**
 * A plain GET form and a row of links — no client component, no state, no JavaScript.
 *
 * This surface exists because `/store` renders server-side for someone who has never signed in,
 * and half the point of that is that a crawler can follow it. A filter built out of `onChange`
 * handlers would render an empty catalogue to exactly the visitor this page is for.
 */
export function StoreFilters({
  categories,
  tags,
  query,
}: {
  categories: FilterCategory[]
  tags: string[]
  query: StoreQuery
}) {
  return (
    <div className="mt-8 flex flex-col gap-5">
      <search>
        <form method="get" action="/store" className="flex gap-2">
          {/* Submitting the form starts a new result set, so the cursor is deliberately not
              carried forward — but the other filters are, or searching would silently clear them. */}
          {query.category !== null && (
            <input type="hidden" name="category" value={query.category} />
          )}
          {query.tag !== null && <input type="hidden" name="tag" value={query.tag} />}

          <label className="sr-only" htmlFor="store-search">
            Search the store
          </label>
          <input
            id="store-search"
            type="search"
            name="q"
            defaultValue={query.q ?? ""}
            placeholder="Search apps — bookmarks, notes, invoicing…"
            className="h-10 w-full rounded-lg border rule-soft bg-background/60 px-3.5 text-sm placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          />
          <button
            type="submit"
            className="h-10 shrink-0 rounded-lg border border-primary/45 bg-primary/10 px-4 text-sm font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Search
          </button>
        </form>
      </search>

      <nav aria-label="Categories" className="flex flex-wrap gap-1.5">
        <CategoryChip
          href={storeHref({ ...query, category: null, cursor: null })}
          active={query.category === null}
        >
          All
        </CategoryChip>
        {categories.map((category) => (
          <CategoryChip
            key={category.slug}
            href={storeHref({ ...query, category: category.slug, cursor: null })}
            active={query.category === category.slug}
          >
            {category.name}
          </CategoryChip>
        ))}
      </nav>

      {tags.length > 0 && (
        <nav aria-label="Tags" className="flex flex-wrap gap-1.5">
          {query.tag !== null && (
            <Link
              href={storeHref({ ...query, tag: null, cursor: null })}
              className="rounded-full border border-primary/45 bg-primary/10 px-2.5 py-1 font-mono text-[11px] text-primary"
            >
              {query.tag} ✕
            </Link>
          )}
          {tags
            .filter((tag) => tag !== query.tag)
            .map((tag) => (
              <Link
                key={tag}
                href={storeHref({ ...query, tag, cursor: null })}
                className="rounded-full border rule-soft px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {tag}
              </Link>
            ))}
        </nav>
      )}
    </div>
  )
}

function CategoryChip({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-full border border-primary/45 bg-primary/10 px-3 py-1 text-[13px] text-primary"
          : "rounded-full border rule-soft px-3 py-1 text-[13px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
      }
    >
      {children}
    </Link>
  )
}

import { formatMicroUsd } from "@lib/billing/money"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Card, CardContent, CardHeader, CardTitle } from "@ui/base/ui/card"
import { Money } from "@ui/base/ui/money"
import { Skeleton } from "@ui/base/ui/skeleton"
import { ListError } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import { useStoreCategories, useStoreListings } from "@frontends/dashboard/data/store"
import { Badge } from "@ui/base/ui/badge"
import { Input } from "@ui/base/ui/input"
import { SearchIcon } from "lucide-react"
import { useState } from "react"

export const Route = createFileRoute("/store/")({
  component: StoreList,
})

function StoreList() {
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState<string | undefined>(undefined)

  const categories = useStoreCategories()
  const { data, isPending, isError, refetch } = useStoreListings({ q: search, category })

  return (
    <>
      <PageHeader title="Store" count={data?.length}>
        <div className="relative hidden w-55 sm:block">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
            }}
            placeholder="Search the store"
            aria-label="Search the store"
            className="pl-8"
          />
        </div>
      </PageHeader>
      <PageBody>
        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Every template here is public and already runs. Forking one copies it into your
          organization. Your deployed apps appear in your personal catalogue; store publication is a
          separate reviewed release.
        </p>

        {/*
          Pills rather than a select, and "All" is one of them rather than an empty option.

          A category filter is a small, fixed set that a person scans; a select hides every option
          but the chosen one behind a click. `aria-pressed` is what makes them buttons a screen
          reader can report as on or off, which a styled `div` would not be.
        */}
        <div className="flex flex-wrap gap-1.5">
          <CategoryPill
            label="All"
            active={category === undefined}
            onSelect={() => {
              setCategory(undefined)
            }}
          />
          {categories.data?.map((item) => (
            <CategoryPill
              key={item.slug}
              label={item.name}
              active={category === item.slug}
              onSelect={() => {
                setCategory(item.slug)
              }}
            />
          ))}
        </div>

        {isError && (
          <ListError
            title="Could not load the store"
            onRetry={() => {
              void refetch()
            }}
          />
        )}

        {!isPending && !isError && data?.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            Nothing here matches{search === "" ? " that category" : ` “${search}”`}.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {isPending &&
            Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-36 w-full rounded-lg" />
            ))}

          {data?.map((listing) => (
            <Card key={listing.slug} className="transition-colors hover:border-soil-600">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span aria-hidden="true" className="text-[15px]">
                    {listing.glyph}
                  </span>
                  <Link
                    to="/store/$slug"
                    params={{ slug: listing.slug }}
                    className="text-foreground hover:text-leaf"
                  >
                    {listing.name}
                  </Link>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3 pt-0">
                <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
                  {listing.tagline}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">Public template</Badge>
                  {listing.tags.map((tag) => (
                    <Badge key={tag} variant="muted">
                      {tag}
                    </Badge>
                  ))}
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="tnum font-mono text-[11px] text-muted-foreground">
                    {listing.installs} installs
                  </span>
                  <span className="flex items-baseline gap-1">
                    {/*
                      An em dash, not `$0.00`. Nobody has estimated what this costs to run, and a
                      zero would read as "free".
                    */}
                    {listing.estimatedMonthlyCostMicros === null ? (
                      <span className="font-mono text-xs text-muted-foreground">{"\u2014"}</span>
                    ) : (
                      <Money size="sm">{formatMicroUsd(listing.estimatedMonthlyCostMicros)}</Money>
                    )}
                    <span className="text-[11px] text-muted-foreground">/mo est.</span>
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </PageBody>
    </>
  )
}

function CategoryPill({
  label,
  active,
  onSelect,
}: {
  label: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:border-soil-600 hover:text-foreground"
      }`}
    >
      {label}
    </button>
  )
}

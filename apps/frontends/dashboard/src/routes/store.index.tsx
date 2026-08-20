import { formatMicroUsd } from "@lib/billing/money"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Badge } from "@ui/base/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@ui/base/ui/card"
import { Money } from "@ui/base/ui/money"
import { Skeleton } from "@ui/base/ui/skeleton"
import { ListError } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import { useStoreListings } from "@frontends/dashboard/data/store"

export const Route = createFileRoute("/store/")({
  component: StoreList,
})

function StoreList() {
  const { data, isPending, isError, refetch } = useStoreListings()

  return (
    <>
      <PageHeader title="Store" count={data?.length} />
      <PageBody>
        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          Every app here already runs. Forking one copies it into your organization, provisions what
          it declares, and deploys it.
        </p>

        {isError && (
          <ListError
            title="Could not load the store"
            onRetry={() => {
              void refetch()
            }}
          />
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
                    <Money size="sm">{formatMicroUsd(listing.estimatedMonthlyCostMicros)}</Money>
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

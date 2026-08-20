import { formatMicroUsd } from "@lib/billing/money"
import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowLeftIcon } from "lucide-react"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@ui/base/ui/card"
import { Money } from "@ui/base/ui/money"
import { Separator } from "@ui/base/ui/separator"
import { SkeletonText } from "@ui/base/ui/skeleton"
import { ListError } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import { useStoreListing } from "@frontends/dashboard/data/store"

export const Route = createFileRoute("/store/$slug")({
  component: StoreListingDetail,
})

function StoreListingDetail() {
  const { slug } = Route.useParams()
  const { data, isPending, isError, refetch } = useStoreListing(slug)

  return (
    <>
      <PageHeader title={data?.name ?? "Listing"}>
        <Button variant="ghost" size="sm" render={<Link to="/store" />}>
          <ArrowLeftIcon />
          Store
        </Button>
        <Button size="sm">Fork this app</Button>
      </PageHeader>

      <PageBody>
        {isError && (
          <ListError
            title="Could not load this listing"
            onRetry={() => {
              void refetch()
            }}
          />
        )}

        {isPending && (
          <Card className="max-w-3xl">
            <CardContent>
              <SkeletonText />
            </CardContent>
          </Card>
        )}

        {data !== undefined && (
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <span aria-hidden="true">{data.glyph}</span>
                {data.name}
                <Badge variant="muted">{data.version}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {data.description}
              </p>
              <Separator />
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                <div className="flex flex-col gap-1">
                  <dt className="eyebrow text-[10px]">Repository</dt>
                  <dd className="tnum truncate font-mono text-xs">{data.repo}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="eyebrow text-[10px]">Author</dt>
                  <dd className="tnum truncate font-mono text-xs">{data.author}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="eyebrow text-[10px]">Installs</dt>
                  <dd className="tnum font-mono text-xs">{data.installs}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="eyebrow text-[10px]">Estimated cost</dt>
                  <dd>
                    {/*
                      An em dash, not `$0.00`. Nobody has estimated what this costs to run, and a
                      zero would read as "free".
                    */}
                    {data.estimatedMonthlyCostMicros === null ? (
                      <span className="font-mono text-xs text-muted-foreground">{"\u2014"}</span>
                    ) : (
                      <Money size="sm">{formatMicroUsd(data.estimatedMonthlyCostMicros)}</Money>
                    )}
                    <span className="ml-1 text-[11px] text-muted-foreground">/mo</span>
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap items-center gap-1.5">
                {data.requires.map((requirement) => (
                  <Badge key={requirement} variant="muted">
                    {requirement}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </>
  )
}

import { formatMicroUsd } from "@lib/billing/money"
import { Link, createFileRoute } from "@tanstack/react-router"
import {
  ArrowLeftIcon,
  BotIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@ui/base/ui/card"
import { Money } from "@ui/base/ui/money"
import { Skeleton, SkeletonText } from "@ui/base/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
import { ListError } from "@frontends/dashboard/components/list-states"
import { PageBody, PageHeader } from "@frontends/dashboard/components/shell/page-header"
import { PROJECT_STATUS_LABELS, useProject } from "@frontends/dashboard/data/projects"
import { useRecentJobs } from "@frontends/dashboard/data/workflows"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/")({
  component: ProjectDetail,
})

function ProjectDetail() {
  const { orgSlug, projectId } = Route.useParams()
  const { data, isPending, isError, refetch } = useProject(orgSlug, projectId)
  const jobs = useRecentJobs(orgSlug)

  return (
    <>
      <PageHeader title={data?.name ?? "Project"}>
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/orgs/$orgSlug/projects" params={{ orgSlug }} />}
        >
          <ArrowLeftIcon />
          All projects
        </Button>
        <Button
          variant="ghost"
          size="sm"
          render={
            <Link to="/orgs/$orgSlug/projects/$projectId/agent" params={{ orgSlug, projectId }} />
          }
        >
          <BotIcon />
          Agent
        </Button>
        <Button
          variant="ghost"
          size="sm"
          render={
            <Link to="/orgs/$orgSlug/projects/$projectId/env" params={{ orgSlug, projectId }} />
          }
        >
          <KeyRoundIcon />
          Variables
        </Button>
        <Button
          size="sm"
          render={
            <Link to="/orgs/$orgSlug/projects/$projectId/modify" params={{ orgSlug, projectId }} />
          }
        >
          <SlidersHorizontalIcon />
          Modify
        </Button>
      </PageHeader>

      <PageBody>
        {isError && (
          <ListError
            title="Could not load this project"
            onRetry={() => {
              void refetch()
            }}
          />
        )}

        {isPending && (
          <Card>
            <CardContent>
              <SkeletonText />
            </CardContent>
          </Card>
        )}

        {data !== undefined && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span aria-hidden="true">{data.glyph}</span>
                  {data.name}
                  <Badge variant={data.status === "ready" ? "success" : "outline"}>
                    {PROJECT_STATUS_LABELS[data.status]}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
                  {data.description}
                </p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  <Fact label="Repository" value={data.repo} mono />
                  <Fact label="Region" value={data.region} mono />
                  <Fact label="Runtime" value={data.runtime} mono />
                  <div className="flex flex-col gap-1">
                    <dt className="eyebrow text-[10px]">Cost this month</dt>
                    <dd>
                      <Money>{formatMicroUsd(data.costMicros)}</Money>
                    </dd>
                  </div>
                </dl>
                <div>
                  <Button variant="outline" size="sm" render={<a href={data.url}>{data.url}</a>}>
                    <ExternalLinkIcon />
                  </Button>
                </div>
              </CardContent>
            </Card>

            <section className="flex flex-col gap-2.5">
              <h2 className="eyebrow">Recent jobs</h2>
              {jobs.isPending && <Skeleton className="h-32 w-full rounded-lg" />}
              {jobs.isError && (
                <ListError
                  title="Could not load jobs"
                  onRetry={() => {
                    void jobs.refetch()
                  }}
                />
              )}
              {jobs.data !== undefined && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-50">Job</TableHead>
                      <TableHead>Workflow</TableHead>
                      <TableHead className="w-30">Duration</TableHead>
                      <TableHead className="w-28 text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.data.map((job) => (
                      <TableRow key={job.id}>
                        <TableCell numeric>{job.id}</TableCell>
                        <TableCell>{job.workflow}</TableCell>
                        <TableCell numeric>{job.duration}</TableCell>
                        <TableCell money>{formatMicroUsd(job.costMicros)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </>
        )}
      </PageBody>
    </>
  )
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="eyebrow text-[10px]">{label}</dt>
      <dd className={mono ? "tnum truncate font-mono text-xs" : "truncate text-[13px]"}>{value}</dd>
    </div>
  )
}

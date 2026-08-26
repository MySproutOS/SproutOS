import { formatMicroUsd } from "@lib/billing/money"
import { Link, createFileRoute } from "@tanstack/react-router"
import {
  ArrowLeftIcon,
  BotIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  ScrollTextIcon,
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
import { ProductionDeployment } from "@frontends/dashboard/components/projects/production-deployment"
import { GroupChildren } from "@frontends/dashboard/components/projects/group-children"
import { PROJECT_STATUS_LABELS, useProject } from "@frontends/dashboard/data/projects"
import { useRecentJobs } from "@frontends/dashboard/data/workflows"

export const Route = createFileRoute("/orgs/$orgSlug/projects/$projectId/")({
  component: ProjectDetail,
})

function ProjectDetail() {
  const { orgSlug, projectId } = Route.useParams()
  const { data, isPending, isError, refetch } = useProject(orgSlug, projectId)
  /*
    The organization's recent runs, narrowed to this project.

    The feed is organization-wide because that is the one query the Workflows screen needs, and
    filtering here beats a second endpoint that differs only by a `where`. It does mean a project
    whose runs have all scrolled past the feed's limit shows an empty table — which is honest, and
    the fix is a project-scoped endpoint when a project page needs deeper history than the feed
    carries.
  */
  const jobs = useRecentJobs(orgSlug)
  const projectJobs = jobs.data?.filter((job) => job.projectId === projectId)

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
          variant="ghost"
          size="sm"
          render={
            <Link to="/orgs/$orgSlug/projects/$projectId/logs" params={{ orgSlug, projectId }} />
          }
        >
          <ScrollTextIcon />
          Logs
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
                  <div className="flex flex-col gap-1">
                    <dt className="eyebrow text-[10px]">Repository</dt>
                    <dd>
                      <a
                        href={data.repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="tnum inline-flex items-center gap-1 font-mono text-[13px] hover:text-leaf hover:underline"
                      >
                        {data.repo}
                        <ExternalLinkIcon className="size-3" aria-hidden="true" />
                      </a>
                    </dd>
                  </div>
                  <Fact label="Region" value={data.region} mono />
                  <Fact label="Runtime" value={data.runtime} mono />
                  <div className="flex flex-col gap-1">
                    <dt className="eyebrow text-[10px]">Cost this month</dt>
                    <dd>
                      <Money>{formatMicroUsd(data.costMicros)}</Money>
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            {/*
              What is actually serving, or how to make something serve.

              This replaces a `data.url === null ? "Not deployed yet" : <link>` branch whose
              condition was hardcoded to null in the data layer — so it read "Not deployed yet" for
              every project forever, including ones that were serving.
            */}
            <ProductionDeployment
              orgSlug={orgSlug}
              project={data}
              liveDeploymentId={data.liveDeploymentId}
            />

            {data.isGroup ? <GroupChildren orgSlug={orgSlug} group={data} /> : null}

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
              {projectJobs !== undefined && projectJobs.length === 0 && (
                <p className="rule-soft rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">
                  No runs yet.
                </p>
              )}
              {projectJobs !== undefined && projectJobs.length > 0 && (
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
                    {projectJobs.map((job) => (
                      <TableRow key={job.id}>
                        {/*
                          The last twelve characters of a UUIDv7, which are the random tail.
                          The leading digits are a timestamp shared by everything created in the
                          same millisecond, so a prefix would show a column of near-identical
                          strings.
                        */}
                        <TableCell numeric>{job.id.slice(-12)}</TableCell>
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

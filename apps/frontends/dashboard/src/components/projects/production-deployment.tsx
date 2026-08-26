import { Link } from "@tanstack/react-router"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import { Card, CardContent } from "@ui/base/ui/card"
import { Skeleton } from "@ui/base/ui/skeleton"
import {
  ExternalLinkIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  RotateCcwIcon,
} from "lucide-react"
import {
  canRollBackTo,
  type Deployment,
  useDeployments,
} from "@frontends/dashboard/data/deployments"
import type { ProjectDetail } from "@frontends/dashboard/data/projects"
import { DeployCta } from "./deploy-cta"

/**
 * The production deployment, as the reference dashboard shows it.
 *
 * Deployment host, domains, status, when and by whom, and the source it was built from. The
 * screenshot's firewall, analytics and deployment-settings panels are deliberately absent: we do
 * not have those, and a panel that renders an empty state forever is worse than no panel.
 *
 * The preview thumbnail is absent for the same honesty reason and a different cause — it needs
 * headless capture, storage and per-deploy invalidation, which is a feature rather than a field.
 * The layout leaves room for it.
 */
export function ProductionDeployment({
  orgSlug,
  project,
  liveDeploymentId,
}: {
  orgSlug: string
  project: ProjectDetail
  liveDeploymentId: string | null
}) {
  const deployments = useDeployments(orgSlug, project.id)

  const rows = deployments.data ?? []
  const live =
    rows.find((row) => row.id === liveDeploymentId) ??
    rows.find((row) => row.kind === "production" && row.status === "ready")

  /*
    A group has no production deployment and never will.

    Rendering "not deployed yet" for one would invite somebody to go looking for the deploy button
    that deliberately does not exist.
  */
  if (project.isGroup) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2 py-6">
          <h2 className="text-sm font-medium">Project group</h2>
          <p className="max-w-prose text-[13px] text-muted-foreground">
            This is a grouping. It holds the projects built from this repository and does not deploy
            on its own — each project inside it deploys, and is billed, separately.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (deployments.isPending) return <Skeleton className="h-56 w-full rounded-lg" />

  if (live === undefined) {
    return (
      <Card>
        <CardContent className="py-6">
          <DeployCta orgSlug={orgSlug} project={project} failed={rows[0]} />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-5">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-sm font-medium">Production Deployment</h2>
          <div className="flex shrink-0 items-center gap-2">
            <RollbackControl orgSlug={orgSlug} project={project} rows={rows} liveId={live.id} />
            {live.url === null ? null : (
              <Button
                size="sm"
                render={
                  <a
                    href={live.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Visit the production deployment"
                  />
                }
              >
                <span>Visit</span>
                <ExternalLinkIcon />
              </Button>
            )}
          </div>
        </div>

        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Field label="Deployment">
            <span className="tnum font-mono text-[13px] break-all">{live.hostname ?? "—"}</span>
          </Field>

          <Field label="Domains">
            {/*
              The project's own hostname is not a "domain" in the sense this panel means. Custom
              domains live on their own screen; this shows what is currently serving.
            */}
            {live.url === null ? (
              <span className="text-[13px] text-muted-foreground">—</span>
            ) : (
              <a
                href={live.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[13px] hover:text-leaf hover:underline"
              >
                {new URL(live.url).host}
                <ExternalLinkIcon className="size-3" aria-hidden="true" />
              </a>
            )}
          </Field>

          <Field label="Status">
            <Badge variant={live.status === "ready" ? "success" : "outline"}>
              {live.status === "ready" ? "Ready" : live.status}
            </Badge>
          </Field>

          <Field label="Created">
            <span className="text-[13px]">
              {live.createdLabel}
              {/*
                No author for a CI deploy, and that is correct rather than missing.

                The Action authenticates as the repository over OIDC — there is no user in the
                exchange — so attributing it to a person would be a fabrication on the one field
                that exists to say who shipped it.
              */}
              <span className="text-muted-foreground">
                {live.createdByUserId === null ? " by CI" : ""}
              </span>
            </span>
          </Field>

          <Field label="Source">
            <div className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1.5 font-mono text-[12.5px]">
                <GitBranchIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                {live.gitRef ?? "—"}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[12.5px]">
                <GitCommitHorizontalIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="tnum font-mono">{live.shortSha}</span>
                <span className="truncate text-muted-foreground">{live.gitMessage ?? ""}</span>
              </span>
            </div>
          </Field>

          {live.migrationStatus === null || live.migrationStatus === "skipped" ? null : (
            <Field label="Migrations">
              <Badge variant={live.migrationStatus === "succeeded" ? "success" : "outline"}>
                {live.migrationStatus}
              </Badge>
            </Field>
          )}
        </dl>

        <p className="rule-soft border-t pt-4 text-[12.5px] text-muted-foreground">
          To update your production deployment, push to the{" "}
          <span className="tnum font-mono">{live.gitRef ?? "production"}</span> branch.{" "}
          <Link
            to="/orgs/$orgSlug/projects/$projectId/deployments"
            params={{ orgSlug, projectId: project.id }}
            className="hover:text-leaf hover:underline"
          >
            All deployments
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="eyebrow text-[10px]">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * Instant rollback, offered only where it would work.
 *
 * The previous *ready production* deployment, which is not the same as the previous row — the
 * previous row is very often a failure, and offering to roll back to something that never served
 * would be offering to break the site.
 */
function RollbackControl({
  orgSlug,
  project,
  rows,
  liveId,
}: {
  orgSlug: string
  project: ProjectDetail
  rows: Deployment[]
  liveId: string
}) {
  const target = rows.find((row) => canRollBackTo(row, liveId))
  if (target === undefined) return null

  return (
    <Button
      variant="outline"
      size="sm"
      render={
        <Link
          to="/orgs/$orgSlug/projects/$projectId/deployments"
          params={{ orgSlug, projectId: project.id }}
        />
      }
    >
      <RotateCcwIcon />
      Instant Rollback
    </Button>
  )
}

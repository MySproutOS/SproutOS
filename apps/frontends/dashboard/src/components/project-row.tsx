import { formatMicroUsd } from "@lib/billing/money"
import { Link } from "@tanstack/react-router"
import { ExternalLinkIcon, EllipsisVerticalIcon, RefreshCcwIcon } from "lucide-react"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import { Money } from "@ui/base/ui/money"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/base/ui/dropdown-menu"
import {
  PROJECT_STATUS_LABELS,
  type Project,
  type ProjectStatus,
} from "@frontends/dashboard/data/projects"

const STATUS_VARIANTS: Record<ProjectStatus, "success" | "warning" | "destructive" | "outline"> = {
  ready: "success",
  building: "warning",
  failed: "destructive",
  sleeping: "outline",
}

export function ProjectRow({ orgSlug, project }: { orgSlug: string; project: Project }) {
  return (
    <div className="flex items-center gap-3.5 rounded-lg border border-border bg-card px-4 py-3.5 transition-colors hover:border-soil-600">
      <span
        aria-hidden="true"
        className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-soil-700 text-[15px]"
      >
        {project.glyph}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex items-center gap-2">
          <Link
            to="/orgs/$orgSlug/projects/$projectId"
            params={{ orgSlug, projectId: project.id }}
            className="truncate text-sm font-medium text-foreground hover:text-leaf"
          >
            {project.name}
          </Link>
          {/*
            A group has no deploy state to report.

            Showing "Ready" beside a group would answer a question nobody asked and imply it is
            serving something. What matters about a group is that it is one.
          */}
          {project.isGroup ? (
            <Badge variant="outline">Group</Badge>
          ) : (
            <Badge variant={STATUS_VARIANTS[project.status]}>
              {PROJECT_STATUS_LABELS[project.status]}
            </Badge>
          )}
        </div>
        {/*
          A link, not a label.

          This was a bare `<span>`, so the one piece of text on the card that names somewhere you
          would actually want to go was the one thing you could not click. `stopPropagation` keeps
          it from also following the card's own link to the project.
        */}
        <a
          href={project.repoUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            event.stopPropagation()
          }}
          className="tnum inline-flex w-fit max-w-full items-center gap-1 truncate font-mono text-[11.5px] text-muted-foreground hover:text-leaf hover:underline"
        >
          <span className="truncate">{project.repo}</span>
          <ExternalLinkIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="sr-only">Open on GitHub</span>
        </a>
      </div>

      <div className="hidden w-[108px] shrink-0 flex-col items-end gap-[3px] sm:flex">
        <Money>{formatMicroUsd(project.costMicros)}</Money>
        <span className="text-[11px] text-muted-foreground">this month</span>
      </div>

      <div className="hidden w-25 shrink-0 flex-col items-end gap-[3px] lg:flex">
        <span className="text-xs text-muted-foreground">{project.updatedLabel}</span>
        <span className="tnum font-mono text-[11px] text-muted-foreground">{project.region}</span>
      </div>

      {project.hasUpstreamUpdate && (
        <Button
          variant="outline"
          size="sm"
          className="hidden shrink-0 border-leaf text-leaf hover:bg-leaf/10 hover:text-leaf md:inline-flex"
          render={
            <Link
              to="/orgs/$orgSlug/projects/$projectId/modify"
              params={{ orgSlug, projectId: project.id }}
            />
          }
        >
          <RefreshCcwIcon />
          Upstream
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${project.name}`}>
              <EllipsisVerticalIcon />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            render={
              <Link
                to="/orgs/$orgSlug/projects/$projectId"
                params={{ orgSlug, projectId: project.id }}
              />
            }
          >
            Open
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link
                to="/orgs/$orgSlug/projects/$projectId/modify"
                params={{ orgSlug, projectId: project.id }}
              />
            }
          >
            Modify
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">Delete project</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

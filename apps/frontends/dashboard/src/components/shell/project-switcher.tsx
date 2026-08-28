import { Link, useParams } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { Badge } from "@ui/base/ui/badge"
import { Input } from "@ui/base/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/base/ui/dropdown-menu"
import { cn } from "@ui/base/lib/utils"
import { CheckIcon, ChevronsUpDownIcon, FolderIcon, PlusIcon, SearchIcon } from "lucide-react"
import { type Project, useProjects } from "@frontends/dashboard/data/projects"
import { groupProjects } from "@frontends/dashboard/components/projects/project-hierarchy"

/**
 * Find-and-switch across an organization's projects, with groups as headers.
 *
 * The reference dashboard has no hierarchy, so a monorepo's web app and its API sit in its list as
 * unrelated siblings — the relationship lives in the naming convention and in the reader's head.
 * That is the thing worth not copying.
 */
export function ProjectSwitcher({ orgSlug }: { orgSlug: string }) {
  const { data } = useProjects(orgSlug)
  const params = useParams({ strict: false })
  const [query, setQuery] = useState("")

  const current = data?.find((project) => project.id === params.projectId)

  /*
    Keyed on `data`, not on a `?? []` fallback.

    `data ?? []` allocates a new array on every render, so a memo depending on it never hits — which
    would make the grouping run on every keystroke *and* every unrelated re-render.
  */
  const sections = useMemo(() => groupProjects(data ?? [], query), [data, query])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-8 max-w-56 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors outline-none hover:bg-secondary/60 focus-visible:ring-3 focus-visible:ring-ring/20 data-popup-open:bg-secondary/60"
        aria-label="Switch project"
      >
        <span className="truncate font-medium">{current?.name ?? "Projects"}</span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-72 p-0">
        <div className="flex items-center gap-2 border-b px-2.5 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            /*
              Focused when the menu opens, because this control exists to be typed into — but via a
              ref rather than `autoFocus`, which moves focus on mount regardless of how the element
              arrived and is disorienting for a screen-reader user who did not open it.
            */
            ref={(node) => {
              node?.focus()
            }}
            value={query}
            placeholder="Find project…"
            aria-label="Find project"
            onChange={(event) => {
              setQuery(event.target.value)
            }}
            className="h-6 border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0"
          />
        </div>

        <div className="max-h-80 overflow-y-auto py-1">
          {sections.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
              Nothing matches “{query}”.
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.key}>
                {section.header === null ? null : (
                  <ProjectHeader
                    orgSlug={orgSlug}
                    group={section.header}
                    /*
                      A header that only survived because one of its children matched is context,
                      not a destination. Showing it as clickable invites somebody to select the
                      group when they were looking for the thing underneath it.
                    */
                    contextOnly={section.headerIsContext}
                  />
                )}
                {section.children.map((project) => (
                  <ProjectItem
                    key={project.id}
                    orgSlug={orgSlug}
                    project={project}
                    indented={section.header !== null}
                    current={project.id === params.projectId}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        <DropdownMenuSeparator className="my-0" />
        <DropdownMenuItem
          render={<Link to="/orgs/$orgSlug/projects" params={{ orgSlug }} />}
          className="gap-2"
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
          All projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ProjectHeader({
  orgSlug,
  group: header,
  contextOnly,
}: {
  orgSlug: string
  group: Project
  contextOnly: boolean
}) {
  if (contextOnly) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-muted-foreground/70">
        <FolderIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{header.name}</span>
      </div>
    )
  }

  return (
    <DropdownMenuItem
      render={
        <Link to="/orgs/$orgSlug/projects/$projectId" params={{ orgSlug, projectId: header.id }} />
      }
      className="gap-2 text-[12.5px] text-muted-foreground"
    >
      <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{header.name}</span>
      <Badge variant="outline" className="ml-auto text-[10px]">
        Group
      </Badge>
    </DropdownMenuItem>
  )
}

function ProjectItem({
  orgSlug,
  project,
  indented,
  current,
}: {
  orgSlug: string
  project: Project
  indented: boolean
  current: boolean
}) {
  return (
    <DropdownMenuItem
      render={
        <Link to="/orgs/$orgSlug/projects/$projectId" params={{ orgSlug, projectId: project.id }} />
      }
      className={cn("gap-2", indented && "pl-7")}
    >
      <span className="truncate">{project.name}</span>
      {current ? <CheckIcon className="ml-auto size-3.5 shrink-0" aria-hidden="true" /> : null}
    </DropdownMenuItem>
  )
}

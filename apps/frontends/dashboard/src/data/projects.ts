import { useQuery } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugProjectsByProjectIdOptions,
  getV1OrgsByOrgSlugProjectsOptions,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export type ProjectStatus = "ready" | "building" | "failed" | "sleeping"

export type Project = {
  id: string
  name: string
  /** The owner's chosen emoji. Project data, not chrome — UI icons are lucide. */
  glyph: string
  repo: string
  status: ProjectStatus
  /** Micro-USD. Never a float: see `@lib/billing`. */
  costMicros: bigint
  updatedLabel: string
  region: string
  hasUpstreamUpdate: boolean
}

export type ProjectDetail = Project & {
  description: string
  /** Null until the project has deployed. A project with no deployment has no URL. */
  url: string | null
  runtime: string
  autoUpdateForks: boolean
  createdLabel: string
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  ready: "Ready",
  building: "Building",
  failed: "Failed",
  sleeping: "Sleeping",
}

/**
 * `project.state` is the database's word; `ProjectStatus` is the screen's.
 *
 * They are not the same vocabulary and should not be conflated: the table's CHECK allows states
 * this list has no cell for, and a `Record` lookup on an unmapped one renders `undefined`. Anything
 * unrecognised falls back to "building", which is the honest answer for a project the dashboard
 * does not yet have a word for — it is doing something.
 */
const STATE_TO_STATUS: Record<string, ProjectStatus> = {
  creating: "building",
  provisioning: "building",
  building: "building",
  deploying: "building",
  ready: "ready",
  active: "ready",
  sleeping: "sleeping",
  suspended: "sleeping",
  failed: "failed",
  error: "failed",
}

const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" })

/**
 * "2 hours ago", from a timestamp.
 *
 * The generated types say `updatedAt: Date`, but this client has no `transformers.gen.ts` — every
 * date arrives as an ISO string and the type is a lie. Coerced at the boundary, as `members.ts`
 * does, or formatting throws `RangeError: Invalid time value`.
 */
export function relativeLabel(value: Date | string): string {
  const elapsed = Date.now() - new Date(value).getTime()
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 1000],
    ["minute", 60_000],
    ["hour", 3_600_000],
    ["day", 86_400_000],
    ["month", 2_592_000_000],
    ["year", 31_536_000_000],
  ]

  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0]
  for (const unit of units) {
    if (elapsed >= unit[1]) chosen = unit
  }
  return RELATIVE.format(-Math.floor(elapsed / chosen[1]), chosen[0])
}

/**
 * The organization's projects.
 *
 * `costMicroUsd` arrives as a string and becomes a `bigint` here rather than a `Number`: it is
 * money, and `@lib/billing` is explicit that money never touches a float. A project with no metered
 * usage is genuinely `0n` — nothing has been recorded against it — rather than unknown.
 */
export function useProjects(orgSlug: string) {
  const query = useQuery(getV1OrgsByOrgSlugProjectsOptions({ path: { orgSlug } }))

  return {
    ...query,
    data: query.data?.data.map((project): Project => ({
      id: project.id,
      name: project.name,
      /*
          The first letter, not an emoji.

          The design has a glyph per project, but nothing stores one and nothing lets a user pick
          one — deriving an emoji from the id would be inventing a choice the customer never made.
          The initial is the same treatment the team switcher uses, and it is honest.
        */
      glyph: (project.name.trim()[0] ?? "·").toUpperCase(),
      repo: `${project.repositoryOwnerLogin}/${project.repositoryName}`,
      status: STATE_TO_STATUS[project.state] ?? "building",
      costMicros: BigInt(project.costMicroUsd),
      updatedLabel: relativeLabel(project.updatedAt),
      region: project.region ?? "—",
      hasUpstreamUpdate: project.hasUpstreamUpdate,
    })),
  }
}

/**
 * One project, in full.
 *
 * The list's fields plus what only the detail page needs. `url` is null until a deployment exists —
 * a project that has never deployed has no URL, and inventing one would be a link that 404s.
 */
export function useProject(orgSlug: string, projectId: string) {
  const query = useQuery(
    getV1OrgsByOrgSlugProjectsByProjectIdOptions({ path: { orgSlug, projectId } }),
  )

  const project = query.data
  return {
    ...query,
    data:
      project === undefined
        ? undefined
        : ({
            id: project.id,
            name: project.name,
            glyph: (project.name.trim()[0] ?? "\u00b7").toUpperCase(),
            repo: `${project.repositoryOwnerLogin}/${project.repositoryName}`,
            status: STATE_TO_STATUS[project.state] ?? "building",
            costMicros: BigInt(project.costMicroUsd),
            updatedLabel: relativeLabel(project.updatedAt),
            region: project.region ?? "\u2014",
            hasUpstreamUpdate: project.hasUpstreamUpdate,
            /*
              `state_reason` is what the provisioner wrote when it last changed state — an error, a
              step name, or nothing. It is the only description the database has; the store
              listing's blurb belongs to the listing, not to the fork.
            */
            description: project.stateReason ?? "",
            url: null,
            runtime: project.kind,
            autoUpdateForks: project.autoUpdateEnabled,
            createdLabel: relativeLabel(project.createdAt),
          } satisfies ProjectDetail),
  }
}

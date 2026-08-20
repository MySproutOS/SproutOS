import { usePlaceholderQuery } from "@frontends/dashboard/data/placeholder"

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
  url: string
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

const PROJECTS: Project[] = [
  {
    id: "prj_01j8recipebox",
    name: "Recipe Box",
    glyph: "🍲",
    repo: "andrew-chen-wang/recipe-box",
    status: "ready",
    costMicros: 40_000n,
    updatedLabel: "2 hours ago",
    region: "us-east-1",
    hasUpstreamUpdate: true,
  },
  {
    id: "prj_01j8messagesearch",
    name: "Message Search",
    glyph: "💬",
    repo: "andrew-chen-wang/imessage-rag",
    status: "ready",
    costMicros: 1_870_000n,
    updatedLabel: "yesterday",
    region: "us-east-1",
    hasUpstreamUpdate: false,
  },
  {
    id: "prj_01j8followups",
    name: "Client Follow-ups",
    glyph: "📮",
    repo: "acme-co/csm-automations",
    status: "building",
    costMicros: 310_000n,
    updatedLabel: "4 minutes ago",
    region: "us-east-1",
    hasUpstreamUpdate: false,
  },
  {
    id: "prj_01j8weeklydigest",
    name: "Weekly Digest",
    glyph: "📊",
    repo: "andrew-chen-wang/weekly-digest",
    status: "sleeping",
    costMicros: 0n,
    updatedLabel: "12 days ago",
    region: "eu-west-1",
    hasUpstreamUpdate: false,
  },
]

/**
 * PLACEHOLDER — swap for `getV1OrganizationByOrgSlugProjectOptions({ path: { orgSlug } })`.
 *
 * Append `?empty` to any project-list URL to render the TASK 5 empty state without
 * a database. That escape hatch goes away with the real endpoint.
 */
export function useProjects(orgSlug: string, empty = false) {
  return usePlaceholderQuery(
    ["organizations", orgSlug, "projects", { empty }],
    empty ? [] : PROJECTS,
  )
}

/** PLACEHOLDER — swap for `getV1OrganizationByOrgSlugProjectByIdOptions(...)`. */
export function useProject(orgSlug: string, projectId: string) {
  const base = PROJECTS.find((project) => project.id === projectId) ?? PROJECTS[0]
  const detail: ProjectDetail = {
    ...base,
    id: projectId,
    description: "Forked from the store listing and deployed on the shared runtime.",
    url: `https://${base.name.toLowerCase().replaceAll(" ", "-")}.sproutos.app`,
    runtime: "node22",
    autoUpdateForks: base.hasUpstreamUpdate,
    createdLabel: "3 weeks ago",
  }
  return usePlaceholderQuery(["organizations", orgSlug, "projects", projectId], detail)
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  deleteV1OrgsByOrgSlugProjectsByProjectIdMutation,
  getV1OrgsByOrgSlugProjectsByProjectIdOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdJobsOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdJobsQueryKey,
  getV1OrgsByOrgSlugProjectsByProjectIdQueryKey,
  getV1OrgsByOrgSlugProjectsOptions,
  getV1OrgsByOrgSlugProjectsQueryKey,
  getV1RegionsOptions,
  getV1RuntimesOptions,
  patchV1OrgsByOrgSlugProjectsByProjectIdMutation,
  postV1OrgsByOrgSlugProjectsByProjectIdJobsByJobIdRetryMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export type ProjectStatus = "ready" | "building" | "failed" | "sleeping"
export type AutoUpdateCadence =
  | "one_week"
  | "one_month"
  | "three_months"
  | "six_months"
  | "nine_months"
  | "one_year"
  | "two_years"

export type Project = {
  id: string
  name: string
  /** The owner's chosen emoji. Project data, not chrome — UI icons are lucide. */
  glyph: string
  repo: string
  /** `owner/name` on GitHub, so the card can link to it rather than just print it. */
  repoUrl: string
  status: ProjectStatus
  /** Workflows have their own organization index; sites remain on the Projects index. */
  kind: "site" | "workflow"
  /** Micro-USD. Never a float: see `@lib/billing`. */
  costMicros: bigint
  updatedLabel: string
  region: string
  hasUpstreamUpdate: boolean
  /** Holds other projects and deploys nothing itself. */
  isGroup: boolean
  /** Static projects terminate at CloudFront and do not support custom domains yet. */
  servingMode: "serverless" | "static" | null
  /** The group this belongs to, if any. */
  parentProjectId: string | null
  managedByOauthApp: { clientId: string; name: string } | null
  /** Where it is reachable. Null when it has never had a successful deployment. */
  url: string | null
  hostname: string | null
  primaryChildProjectId: string | null
  primaryUrl: string | null
  primaryHostname: string | null
  /** Which deployment is serving. Not the newest — a rollback makes those differ. */
  liveDeploymentId: string | null
}

export type ProjectDetail = Project & {
  description: string
  hostname: string | null
  deploymentPreset: string | null
  runtime: string | null
  handler: string | null
  autoUpdateForks: boolean
  autoUpdateCadence: AutoUpdateCadence
  upstreamFullName: string | null
  createdLabel: string
  pendingRepositoryCreation: boolean
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
 * Takes either, and coerces. The generated client now really does return `Date` — `transformer:
 * true` in `.config/openapi-ts.config.ts` wires the transformers that were previously emitted and
 * never called — but this is also handed plain ISO strings by callers that never went through it.
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
      repoUrl: `https://github.com/${project.repositoryOwnerLogin}/${project.repositoryName}`,
      status: STATE_TO_STATUS[project.state] ?? "building",
      kind: project.kind === "workflow" ? "workflow" : "site",
      costMicros: BigInt(project.costMicroUsd),
      updatedLabel: relativeLabel(project.updatedAt),
      region: project.region ?? "—",
      hasUpstreamUpdate: project.hasUpstreamUpdate,
      isGroup: project.isGroup,
      servingMode: project.servingMode ?? null,
      parentProjectId: project.parentProjectId ?? null,
      managedByOauthApp: project.managedByOauthApp ?? null,
      url: project.url ?? null,
      hostname: project.hostname ?? null,
      primaryChildProjectId: project.primaryChildProjectId ?? null,
      primaryUrl: project.primaryUrl ?? null,
      primaryHostname: project.primaryHostname ?? null,
      liveDeploymentId: project.liveDeploymentId ?? null,
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
            repoUrl: `https://github.com/${project.repositoryOwnerLogin}/${project.repositoryName}`,
            status: STATE_TO_STATUS[project.state] ?? "building",
            kind: project.kind === "workflow" ? "workflow" : "site",
            costMicros: BigInt(project.costMicroUsd),
            updatedLabel: relativeLabel(project.updatedAt),
            region: project.region ?? "\u2014",
            hasUpstreamUpdate: project.hasUpstreamUpdate,
            /*
              `state_reason` is what the provisioner wrote when it last changed state — an error, a
              step name, or nothing. It is the only description the database has; the store
              listing's blurb belongs to the listing, not to the fork.
            */
            description: project.description ?? "",
            /*
              From the server now, not hardcoded null.

              This was `url: null` unconditionally, which is why every project read "Not deployed
              yet" forever — including the ones that had deployed and were serving. The API reports
              the *live* deployment's URL, so a failed deploy does not change where a project says
              it is reachable.
            */
            url: project.url ?? null,
            hostname: project.hostname ?? null,
            primaryChildProjectId: project.primaryChildProjectId ?? null,
            primaryUrl: project.primaryUrl ?? null,
            primaryHostname: project.primaryHostname ?? null,
            isGroup: project.isGroup,
            servingMode: project.servingMode ?? null,
            parentProjectId: project.parentProjectId ?? null,
            managedByOauthApp: project.managedByOauthApp ?? null,
            liveDeploymentId: project.liveDeploymentId ?? null,
            deploymentPreset: project.deploymentPreset ?? null,
            runtime: project.runtime ?? null,
            handler: project.handler ?? null,
            autoUpdateForks: project.autoUpdateEnabled,
            autoUpdateCadence: project.autoUpdateCadence,
            upstreamFullName: project.repository.upstreamFullName,
            createdLabel: relativeLabel(project.createdAt),
            pendingRepositoryCreation: project.repository.pendingCreation,
          } satisfies ProjectDetail),
  }
}

export function useProjectProvisionJobs(orgSlug: string, projectId: string) {
  return useQuery(
    getV1OrgsByOrgSlugProjectsByProjectIdJobsOptions({ path: { orgSlug, projectId } }),
  )
}

export function useRetryProvision(orgSlug: string, projectId: string) {
  const client = useQueryClient()
  return useMutation({
    ...postV1OrgsByOrgSlugProjectsByProjectIdJobsByJobIdRetryMutation(),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: getV1OrgsByOrgSlugProjectsByProjectIdQueryKey({
            path: { orgSlug, projectId },
          }),
        }),
        client.invalidateQueries({
          queryKey: getV1OrgsByOrgSlugProjectsByProjectIdJobsQueryKey({
            path: { orgSlug, projectId },
          }),
        }),
      ])
    },
  })
}

/** A repository-backed workflow that is not nested beneath a project group. */
export function isStandaloneWorkflowProject(project: Project): boolean {
  return project.kind === "workflow" && project.parentProjectId === null
}

/**
 * Rename, re-region, and re-parent a project.
 *
 * The Modify screen had a "Save changes" button with no handler and no mutation behind it, so every
 * edit made there was silently discarded. A form that quietly throws away input is worse than no
 * form: the person believes they changed something.
 *
 * **Renaming changes the name, not the repository and not the hostname.** `project` carries both a
 * `name` and a `slug`, and the tenant hostname derives from the slug — so a rename is free, and the
 * repository on GitHub is untouched.
 */
export function useUpdateProject(orgSlug: string) {
  const client = useQueryClient()
  const mutation = patchV1OrgsByOrgSlugProjectsByProjectIdMutation()

  return useMutation({
    ...mutation,
    onSuccess: async (_result, variables) => {
      await client.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsQueryKey({ path: { orgSlug } }),
      })
      await client.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsByProjectIdQueryKey({
          path: { orgSlug, projectId: variables.path.projectId },
        }),
      })
    },
  })
}

/** The regions a project's services may be placed in. Served from the database, not hardcoded. */
export function useRegions() {
  return useQuery(getV1RegionsOptions())
}

/** The server-owned Lambda runtime catalogue, including compatibility and lifecycle warnings. */
export function useRuntimes() {
  return useQuery(getV1RuntimesOptions())
}

/**
 * Tear a project down.
 *
 * There were two "Delete project" controls in the dashboard — the row's dropdown item and the
 * Modify screen's danger-zone dialog — and **neither sent a request**. The dialog's confirm button
 * was a `DialogClose`, so it closed and did nothing; the dropdown item had no handler at all. Both
 * looked exactly like a working delete: the dialog appeared, the confirmation was destructive-red,
 * and the project was still there afterwards.
 *
 * The API soft-deletes and enqueues a teardown (ADR 0017) because billing grains and statements
 * retain project references.
 */
export function useDeleteProject(orgSlug: string) {
  const client = useQueryClient()
  const mutation = deleteV1OrgsByOrgSlugProjectsByProjectIdMutation()

  return useMutation({
    ...mutation,
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsQueryKey({ path: { orgSlug } }),
      })
    },
  })
}

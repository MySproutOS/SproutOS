import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getV1OrgsByOrgSlugProjectsByProjectIdDeploymentsOptions,
  getV1OrgsByOrgSlugProjectsByProjectIdDeploymentsQueryKey,
  getV1OrgsByOrgSlugProjectsByProjectIdQueryKey,
  getV1OrgsByOrgSlugProjectsQueryKey,
  postV1OrgsByOrgSlugDeploymentsByDeploymentIdRollbackMutation,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export type DeploymentStatus = "queued" | "building" | "deploying" | "ready" | "error" | "torn_down"

export type Deployment = {
  id: string
  kind: string
  status: string
  gitSha: string
  shortSha: string
  gitRef: string | null
  gitMessage: string | null
  url: string | null
  hostname: string | null
  lambdaVersion: string | null
  migrationStatus: string | null
  migrationOutput: string | null
  failureReason: string | null
  buildFailureReason: string | null
  createdByUserId: string | null
  createdAt: string
  createdLabel: string
}

const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" })

/** "3h ago" rather than a timestamp, which is what a deployment list is actually read for. */
function relativeLabel(iso: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ]

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit)
  }
  return RELATIVE.format(Math.round(seconds), "second")
}

export function useDeployments(orgSlug: string, projectId: string) {
  const query = useQuery(
    getV1OrgsByOrgSlugProjectsByProjectIdDeploymentsOptions({ path: { orgSlug, projectId } }),
  )

  return {
    ...query,
    data: query.data?.data.map((row): Deployment => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      gitSha: row.gitSha,
      // Seven characters, which is what git itself abbreviates to and what a commit is recognised
      // by. The full forty is noise in a list and is available on the row.
      shortSha: row.gitSha.slice(0, 7),
      gitRef: row.gitRef ?? null,
      gitMessage: row.gitMessage ?? null,
      url: row.url ?? null,
      hostname: row.hostname ?? null,
      lambdaVersion: row.lambdaVersion ?? null,
      migrationStatus: row.migrationStatus ?? null,
      migrationOutput: row.migrationOutput ?? null,
      failureReason: row.failureReason ?? null,
      buildFailureReason: row.buildFailureReason ?? null,
      createdByUserId: row.createdByUserId ?? null,
      createdAt: row.createdAt,
      createdLabel: relativeLabel(row.createdAt),
    })),
  }
}

/**
 * Whether a deployment is a legitimate rollback target.
 *
 * Mirrors the API's guards so the button is absent rather than present-and-refused. The server
 * still checks — this is the affordance, not the authorization — but offering a control that
 * always fails is its own kind of lie.
 */
export function canRollBackTo(deployment: Deployment, liveDeploymentId: string | null): boolean {
  if (deployment.id === liveDeploymentId) return false
  if (deployment.kind !== "production") return false
  if (deployment.status !== "ready") return false
  return deployment.lambdaVersion !== null
}

/**
 * Move the live alias back to an earlier release.
 *
 * No build and no upload — the old Lambda version was never deleted, so this is one API call. The
 * project and deployment lists are both invalidated because both now say the wrong thing about
 * which release is serving.
 */
export function useRollback(orgSlug: string, projectId: string) {
  const client = useQueryClient()
  const mutation = postV1OrgsByOrgSlugDeploymentsByDeploymentIdRollbackMutation()

  return useMutation({
    ...mutation,
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsByProjectIdDeploymentsQueryKey({
          path: { orgSlug, projectId },
        }),
      })
      await client.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsByProjectIdQueryKey({ path: { orgSlug, projectId } }),
      })
      await client.invalidateQueries({
        queryKey: getV1OrgsByOrgSlugProjectsQueryKey({ path: { orgSlug } }),
      })
    },
  })
}

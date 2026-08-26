/**
 * Neon's control-plane API.
 *
 * SproutOS is on Neon's **Agent plan**, which exists for platforms that provision Postgres for their
 * own end users — see ADR 0025 for why that beat self-hosting. This is the client for it: projects,
 * branches, endpoints and roles, plus the Consumption API that billing reads.
 *
 * ## The vocabulary, because it is easy to get backwards
 *
 * A Neon **project** is one customer database — it owns a storage lineage and a set of branches.
 * A **branch** is a copy-on-write timeline within that project. An **endpoint** is the compute that
 * serves a branch, and it suspends on its own when idle and wakes on connection. So a SproutOS
 * `backend_service` of kind `postgres` maps to one Neon project, `database_branch` to a Neon branch,
 * and nothing in SproutOS needs to model the compute at all.
 *
 * That last point retired a week of work and is worth restating: **Neon's own proxy does
 * wake-on-connect.** We do not start computes, do not track their addresses, and do not hold their
 * credentials.
 */

import { ServiceNotConfiguredError } from "./types"

export type NeonConfig = {
  apiKey: string
  /** `https://console.neon.tech/api/v2`. */
  apiUrl: string
  orgId: string
  /** Where new projects are created. Neon's own region ids, e.g. `aws-us-east-1`. */
  regionId: string
}

/*
  `ServiceNotConfiguredError`, not `Error`.

  These two threw a plain `Error`, and the route only turns `ServiceNotConfiguredError` into a 503
  naming the variable — so a missing `NEON_ORG_ID` came back as a bare `500 Internal Server Error`
  with no body. That is precisely the answer `docs/findings/0015` was written about, still being
  given, by the one driver whose errors were not the shared type.

  The reason it survived is that the two other Postgres paths *do* use it, so the class looked
  adopted. Being right in most places is how a diagnostic gets trusted while it is quietly not
  firing in the one place somebody is standing.
*/
export function neonApiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NeonConfig {
  const apiKey = env.NEON_API_KEY
  if (apiKey === undefined || apiKey === "") {
    throw new ServiceNotConfiguredError("NEON_API_KEY", "postgres")
  }

  const orgId = env.NEON_ORG_ID
  if (orgId === undefined || orgId === "") {
    throw new ServiceNotConfiguredError("NEON_ORG_ID", "postgres")
  }

  return {
    apiKey,
    apiUrl: (env.NEON_API_URL ?? "https://console.neon.tech/api/v2").replace(/\/$/, ""),
    orgId,
    regionId: env.NEON_REGION_ID ?? "aws-us-east-1",
  }
}

export class NeonApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`neon ${path}: ${status} ${message}`)
    this.name = "NeonApiError"
  }
}

async function call<T>(
  config: NeonConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const text = await response.text()
  if (!response.ok) throw new NeonApiError(response.status, path, text.slice(0, 400))
  // A 200 with an empty body happens on deletes, and `JSON.parse("")` throws.
  return (text === "" ? {} : JSON.parse(text)) as T
}

/**
 * How long to wait for a project's in-flight operations to finish.
 *
 * Creating a project starts asynchronous work — provisioning storage, starting an endpoint — and
 * **Neon serialises operations per project**. A branch requested while that work is running is
 * refused with `423 Locked` and
 * `project already has running conflicting operations, scheduling of new ones is prohibited`.
 *
 * That is not an error to surface: it means "not yet". Any caller that creates a project and then
 * does anything to it hits this, so the client waits rather than making every caller discover it.
 */
const OPERATION_TIMEOUT_MS = 120_000

/** Operation states Neon considers terminal. Anything else is still running. */
const SETTLED = new Set(["finished", "failed", "cancelled", "skipped", "error"])

export type NeonOperation = { id: string; action: string; status: string }

export type NeonProject = { id: string; name: string; region_id: string }
export type NeonBranch = {
  id: string
  name: string
  parent_id?: string | null
  parent_lsn?: string | null
  primary?: boolean
  default?: boolean
}
export type NeonConnectionUri = { connection_uri: string }

export function neonApi(config: NeonConfig) {
  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Block until a project has no operations in flight.
   *
   * Polled rather than pushed: Neon offers no webhook for this, and the alternative — retrying the
   * real call on 423 — burns a mutation attempt each time and reads worse in a log.
   */
  async function waitForOperations(projectId: string, now: () => number = Date.now): Promise<void> {
    const deadline = now() + OPERATION_TIMEOUT_MS

    while (now() < deadline) {
      const listed = await call<{ operations: NeonOperation[] }>(
        config,
        "GET",
        `/projects/${projectId}/operations`,
      )
      const running = listed.operations.filter((operation) => !SETTLED.has(operation.status))
      if (running.length === 0) return

      await sleep(1_000)
    }

    throw new NeonApiError(
      423,
      `/projects/${projectId}/operations`,
      "operations did not settle in time",
    )
  }

  /**
   * Create a project: one customer database.
   *
   * `autoscaling_limit_min_cu: 0` is the whole economic argument. It lets the compute scale to zero
   * when nobody is connected, so an idle customer database costs storage and no compute — and Neon
   * wakes it on the next connection without us doing anything.
   */
  async function createProject(input: {
    name: string
    minCu?: number
    maxCu?: number
    suspendTimeoutSeconds?: number
  }): Promise<{ project: NeonProject; branch: NeonBranch; connectionUri: string }> {
    const created = await call<{
      project: NeonProject
      branch: NeonBranch
      connection_uris: NeonConnectionUri[]
    }>(config, "POST", "/projects", {
      project: {
        name: input.name,
        org_id: config.orgId,
        region_id: config.regionId,
        default_endpoint_settings: {
          autoscaling_limit_min_cu: input.minCu ?? 0.25,
          autoscaling_limit_max_cu: input.maxCu ?? 2,
          // 0 means "use Neon's default". A positive value is seconds of idleness before suspend.
          suspend_timeout_seconds: input.suspendTimeoutSeconds ?? 0,
        },
      },
    })

    const connectionUri = created.connection_uris[0]?.connection_uri
    if (connectionUri === undefined) {
      // Neon returns the URI once, at creation. Losing it means the role's password is gone and the
      // only recovery is a reset — better to fail here than to write a half-provisioned row.
      throw new NeonApiError(200, "/projects", "created a project but returned no connection URI")
    }

    return { project: created.project, branch: created.branch, connectionUri }
  }

  async function deleteProject(projectId: string): Promise<void> {
    await call(config, "DELETE", `/projects/${projectId}`)
  }

  async function listProjects(): Promise<NeonProject[]> {
    const listed = await call<{ projects: NeonProject[] }>(
      config,
      "GET",
      `/projects?org_id=${encodeURIComponent(config.orgId)}`,
    )
    return listed.projects
  }

  /**
   * Branch a database, copy-on-write.
   *
   * Omitting `parent_lsn` branches from where the parent is now, which is what a customer asking for
   * a branch means. Passing one is how point-in-time restore works — the same call, and worth
   * knowing before someone builds a second mechanism for it.
   */
  async function createBranch(input: {
    projectId: string
    name: string
    parentId?: string
    parentLsn?: string
  }): Promise<{ branch: NeonBranch; connectionUri: string | undefined }> {
    // Neon serialises operations per project, so a branch requested while the project is still
    // settling is refused with 423. Waiting is the client's job, not every caller's.
    await waitForOperations(input.projectId)

    const created = await call<{
      branch: NeonBranch
      connection_uris?: NeonConnectionUri[]
    }>(config, "POST", `/projects/${input.projectId}/branches`, {
      branch: {
        name: input.name,
        ...(input.parentId === undefined ? {} : { parent_id: input.parentId }),
        ...(input.parentLsn === undefined ? {} : { parent_lsn: input.parentLsn }),
      },
      // Without an endpoint the branch exists in storage and nothing can connect to it.
      endpoints: [{ type: "read_write" }],
    })

    return {
      branch: created.branch,
      connectionUri: created.connection_uris?.[0]?.connection_uri,
    }
  }

  async function deleteBranch(projectId: string, branchId: string): Promise<void> {
    await waitForOperations(projectId)
    await call(config, "DELETE", `/projects/${projectId}/branches/${branchId}`)
  }

  async function listBranches(projectId: string): Promise<NeonBranch[]> {
    const listed = await call<{ branches: NeonBranch[] }>(
      config,
      "GET",
      `/projects/${projectId}/branches`,
    )
    return listed.branches
  }

  return {
    createBranch,
    createProject,
    deleteBranch,
    deleteProject,
    listBranches,
    listProjects,
    waitForOperations,
  }
}

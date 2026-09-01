import "@sproutos/db"
import { createServer } from "node:http"
import { afterAll, describe, expect, it } from "vitest"
import { neonApi, neonApiConfigFromEnv } from "./neon-api"

/**
 * Neon's control-plane API, against the real thing.
 *
 * Slow and it costs a little, which is why it creates one project and tears it down. Skips without
 * `NEON_API_KEY` rather than passing quietly.
 *
 * **The organization is on Neon's Free plan** while the Agent-plan application is pending, so
 * project quotas are tight. Every test here cleans up after itself for that reason as much as for
 * tidiness — a leaked project from a failed run is a quota nobody can spend.
 */
const config = (() => {
  try {
    return neonApiConfigFromEnv()
  } catch {
    return undefined
  }
})()

const reachable = await (async () => {
  if (config === undefined) return false
  try {
    await neonApi(config).listProjects()
    return true
  } catch {
    return false
  }
})()

const created: string[] = []

afterAll(async () => {
  if (!reachable) return
  for (const projectId of created) {
    await neonApi(config!)
      .deleteProject(projectId)
      .catch(() => undefined)
  }
}, 180_000)

describe("neonApiConfigFromEnv", () => {
  it("refuses to run without a key", () => {
    // The key is org-wide and admin over every project. There is no safe default and no read-only
    // fallback worth inventing.
    expect(() => neonApiConfigFromEnv({ NEON_ORG_ID: "org-x" })).toThrow(/NEON_API_KEY/)
  })

  it("refuses to create projects outside the organization", () => {
    expect(() => neonApiConfigFromEnv({ NEON_API_KEY: "napi_x" })).toThrow(/NEON_ORG_ID/)
  })
})

describe("project consumption", () => {
  it("requests invoice-aligned metrics and follows provider pagination", async () => {
    const requests: URL[] = []
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      requests.push(url)
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify(
          url.searchParams.has("cursor")
            ? {
                projects: [{ project_id: "project-b", periods: [] }],
                pagination: {},
              }
            : {
                projects: [{ project_id: "project-a", periods: [] }],
                pagination: { cursor: "next-page" },
              },
        ),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("server did not listen")
      const api = neonApi({
        apiKey: "test-key",
        apiUrl: `http://127.0.0.1:${address.port}`,
        orgId: "org-test",
        regionId: "aws-us-east-1",
      })
      const projects = await api.projectConsumption({
        projectIds: ["project-a", "project-b"],
        from: new Date("2026-08-26T00:00:00.000Z"),
        to: new Date("2026-08-26T01:00:00.000Z"),
      })

      expect(projects.map((project) => project.project_id)).toEqual(["project-a", "project-b"])
      expect(requests).toHaveLength(2)
      expect(requests[0]?.pathname).toBe("/consumption_history/v2/projects")
      expect(requests[0]?.searchParams.get("org_id")).toBe("org-test")
      expect(requests[0]?.searchParams.get("granularity")).toBe("hourly")
      expect(requests[0]?.searchParams.get("project_ids")).toBe("project-a,project-b")
      expect(requests[0]?.searchParams.get("metrics")).toBe(
        "compute_unit_seconds,root_branch_bytes_month,child_branch_bytes_month,instant_restore_bytes_month",
      )
      expect(requests[1]?.searchParams.get("cursor")).toBe("next-page")
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        }),
      )
    }
  })
})

describe("branch consumption", () => {
  it("scopes invoice-aligned usage to the requested branches and follows pagination", async () => {
    const requests: URL[] = []
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      requests.push(url)
      response.setHeader("Content-Type", "application/json")
      response.end(
        JSON.stringify(
          url.searchParams.has("cursor")
            ? {
                branches: [{ project_id: "project-a", branch_id: "branch-b", periods: [] }],
                pagination: {},
              }
            : {
                branches: [{ project_id: "project-a", branch_id: "branch-a", periods: [] }],
                pagination: { cursor: "next-page" },
              },
        ),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("server did not listen")
      const api = neonApi({
        apiKey: "test-key",
        apiUrl: `http://127.0.0.1:${address.port}`,
        orgId: "org-test",
        regionId: "aws-us-east-1",
      })
      const branches = await api.branchConsumption({
        projectIds: ["project-a"],
        branchIds: ["branch-a", "branch-b"],
        from: new Date("2026-08-26T00:00:00.000Z"),
        to: new Date("2026-08-26T01:00:00.000Z"),
      })

      expect(branches.map((branch) => branch.branch_id)).toEqual(["branch-a", "branch-b"])
      expect(requests).toHaveLength(2)
      expect(requests[0]?.pathname).toBe("/consumption_history/v2/branches")
      expect(requests[0]?.searchParams.get("project_ids")).toBe("project-a")
      expect(requests[0]?.searchParams.get("branch_ids")).toBe("branch-a,branch-b")
      expect(requests[0]?.searchParams.get("granularity")).toBe("hourly")
      expect(requests[1]?.searchParams.get("cursor")).toBe("next-page")
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        }),
      )
    }
  })
})

describe.runIf(reachable)("the control-plane API", () => {
  it("creates a project that scales to zero, and hands back a connection string", async () => {
    /*
      One Neon project is one customer database. `autoscaling_limit_min_cu` below 1 is the whole
      economic argument — an idle customer database costs storage and no compute, and Neon wakes it
      on the next connection without the platform doing anything.
    */
    const api = neonApi(config!)
    const { project, branch, connectionUri } = await api.createProject({
      name: `sproutos-test-${Date.now()}`,
      minCu: 0.25,
      maxCu: 1,
    })
    created.push(project.id)

    expect(project.region_id).toBe(config!.regionId)
    expect(connectionUri.startsWith("postgresql://")).toBe(true)
    // The default branch. Neon names it `main` and marks it default.
    expect(branch.id).toMatch(/^br-/)
  }, 180_000)

  it("branches copy-on-write, and the branch is connectable", async () => {
    // The property `database_branch` was designed around. Omitting `parent_lsn` branches from where
    // the parent is now, which is what a customer asking for a branch means.
    const api = neonApi(config!)
    const { project, branch } = await api.createProject({ name: `sproutos-branch-${Date.now()}` })
    created.push(project.id)

    const child = await api.createBranch({
      projectId: project.id,
      name: "preview",
      parentId: branch.id,
    })

    expect(child.branch.parent_id).toBe(branch.id)
    // An endpoint was requested with the branch; without one it exists in storage and nothing can
    // connect to it.
    expect(child.connectionUri).toBeTruthy()

    const branches = await api.listBranches(project.id)
    expect(branches.map((b) => b.id)).toContain(child.branch.id)
  }, 300_000)

  it("deletes a branch without taking its parent", async () => {
    // Tearing down a preview must not touch production's.
    const api = neonApi(config!)
    const { project, branch } = await api.createProject({ name: `sproutos-del-${Date.now()}` })
    created.push(project.id)

    const child = await api.createBranch({
      projectId: project.id,
      name: "doomed",
      parentId: branch.id,
    })
    await api.deleteBranch(project.id, child.branch.id)

    const remaining = await api.listBranches(project.id)
    expect(remaining.map((b) => b.id)).toContain(branch.id)
    expect(remaining.map((b) => b.id)).not.toContain(child.branch.id)
  }, 300_000)
})

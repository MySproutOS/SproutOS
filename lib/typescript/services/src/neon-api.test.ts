import "@sproutos/db"
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

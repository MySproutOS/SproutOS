import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { crudDeployment } from "./crud"
import { fetchDeployment } from "./fetch"

/**
 * Against the compose Postgres, because the thing worth testing is a predicate.
 *
 * `deployment` has no `organization_id`; it hangs off `project`. `requirePermission` builds an SRN
 * from the *resolved* organization plus an unverified path parameter, so a deployment id belonging
 * to somebody else produces a well-formed SRN in the caller's own organization and passes the
 * permission check cleanly. The tenancy predicate in the query is the only thing standing between
 * that and one customer reading another's deployment.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created: {
  table: "deployment" | "project" | "repository" | "organization" | "user"
  id: string
}[] = []

async function seedOrganizationWithDeployment() {
  const userId = v7()
  const orgId = v7()
  const repoId = v7()
  const projectId = v7()
  // The uuid's random tail: a UUIDv7 starts with a millisecond timestamp, so two seeds in one tick
  // share their leading characters.
  const suffix = repoId.slice(-12)

  await db
    .insertInto("user")
    .values({ id: userId, email: `deploy-${suffix}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })

  await db
    .insertInto("organization")
    .values({
      id: orgId,
      slug: `deploy-${suffix}`,
      name: "Deploy",
      kind: "team",
      ownerUserId: userId,
    })
    .execute()
  created.push({ table: "organization", id: orgId })

  await db
    .insertInto("repository")
    .values({
      id: repoId,
      organizationId: orgId,
      githubRepoId: BigInt(`0x${suffix}`),
      ownerLogin: "acme",
      name: `repo-${suffix}`,
      provenance: "new",
    })
    .execute()
  created.push({ table: "repository", id: repoId })

  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId: orgId,
      repositoryId: repoId,
      name: "App",
      slug: `app-${suffix}`,
    })
    .execute()
  created.push({ table: "project", id: projectId })

  const deployment = await crudDeployment(db).create({
    projectId,
    kind: "production",
    gitSha: "a".repeat(40),
    status: "ready",
  })
  created.push({ table: "deployment", id: deployment.id })

  return { deployment, orgId, projectId }
}

afterAll(async () => {
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await db.destroy()
})

describe.skipIf(!reachable)("fetchDeployment", () => {
  it("returns a deployment to the organization that owns it", async () => {
    const { deployment, orgId } = await seedOrganizationWithDeployment()

    const found = await fetchDeployment(db).getInOrganization(orgId, deployment.id, ["id", "kind"])

    expect(found?.id).toBe(deployment.id)
    expect(found?.kind).toBe("production")
  })

  it("hides a deployment from an organization that does not own it", async () => {
    const mine = await seedOrganizationWithDeployment()
    const theirs = await seedOrganizationWithDeployment()

    // The id is real and the caller's organization is real. Only the predicate connects them.
    const found = await fetchDeployment(db).getInOrganization(mine.orgId, theirs.deployment.id, [
      "id",
    ])

    expect(found).toBeUndefined()
  })

  it("returns a deployment only to its own project", async () => {
    const mine = await seedOrganizationWithDeployment()
    const theirs = await seedOrganizationWithDeployment()

    const found = await fetchDeployment(db).getForProject(mine.projectId, mine.deployment.id, [
      "id",
      "status",
    ])
    const crossed = await fetchDeployment(db).getForProject(mine.projectId, theirs.deployment.id, [
      "id",
    ])

    expect(found).toEqual({ id: mine.deployment.id, status: "ready" })
    expect(crossed).toBeUndefined()
  })

  it("hides a soft-deleted deployment", async () => {
    const { deployment, orgId } = await seedOrganizationWithDeployment()
    await crudDeployment(db).softDelete(deployment.id)

    expect(
      await fetchDeployment(db).getInOrganization(orgId, deployment.id, ["id"]),
    ).toBeUndefined()
  })

  it("reads the deployment and its project together", async () => {
    const { deployment, projectId } = await seedOrganizationWithDeployment()

    const found = await fetchDeployment(db).withProject(deployment.id)

    // Both halves in one read: the hostname is derived from both, and two round trips could render
    // a host for a project that was renamed in between.
    expect(found?.deployment.id).toBe(deployment.id)
    expect(found?.project.id).toBe(projectId)
    expect(found?.project.slug).toMatch(/^app-/)
  })

  it("finds the newest ready production deployment, not merely a ready one", async () => {
    const { projectId } = await seedOrganizationWithDeployment()

    const newer = await crudDeployment(db).create({
      projectId,
      kind: "production",
      gitSha: "b".repeat(40),
      status: "ready",
    })
    created.push({ table: "deployment", id: newer.id })

    // Two can be `ready` at once during a rollout. The newer one is the one serving.
    const current = await fetchDeployment(db).currentProduction(projectId, ["id", "gitSha"])

    expect(current?.id).toBe(newer.id)
  })
})

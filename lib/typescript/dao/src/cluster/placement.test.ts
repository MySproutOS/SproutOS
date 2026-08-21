import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { fetchPlacement } from "./placement"

/**
 * Against the compose Postgres, because every decision here is a query.
 *
 * The one that matters is what happens when a customer asked for a region the platform has no
 * cluster in: nothing. A silent fallback would put their data in another country and report success.
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
  table: "project" | "cluster" | "region" | "repository" | "organization" | "user"
  id: string
}[] = []

async function seedRegion(provider: string, code: string) {
  const id = v7()
  await db
    .insertInto("region")
    .values({ id, code, displayName: code, provider, isActive: true })
    .execute()
  created.push({ table: "region", id })
  return id
}

async function seedCluster(regionId: string, name: string, registry: string | null) {
  const id = v7()
  await db
    .insertInto("cluster")
    .values({
      id,
      regionId,
      name,
      environment: "prod",
      kubernetesVersion: "1.34",
      endpoint: `https://${name}.example`,
      status: "active",
      registry,
    })
    .execute()
  created.push({ table: "cluster", id })
  return id
}

async function seedProject(regionId: string | null) {
  const userId = v7()
  const orgId = v7()
  const repoId = v7()
  const projectId = v7()
  const tail = repoId.slice(-12)

  await db
    .insertInto("user")
    .values({ id: userId, email: `place-${tail}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({ id: orgId, slug: `place-${tail}`, name: "P", kind: "team", ownerUserId: userId })
    .execute()
  created.push({ table: "organization", id: orgId })
  await db
    .insertInto("repository")
    .values({
      id: repoId,
      organizationId: orgId,
      githubRepoId: BigInt(`0x${tail}`),
      ownerLogin: "acme",
      name: `r-${tail}`,
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
      name: "P",
      slug: `p-${tail}`,
      regionId,
    })
    .execute()
  created.push({ table: "project", id: projectId })
  return projectId
}

afterAll(async () => {
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await db.destroy()
})

describe.skipIf(!reachable)("fetchPlacement", () => {
  it("places a project in the cloud its region belongs to", async () => {
    const gcp = await seedRegion("gcp", `us-central1-${v7().slice(-6)}`)
    await seedCluster(gcp, `gke-${v7().slice(-6)}`, "us-central1-docker.pkg.dev/p/sproutos")

    const placement = await fetchPlacement(db).forProject(await seedProject(gcp))

    expect(placement?.provider).toBe("gcp")
    expect(placement?.registry).toContain("pkg.dev")
  })

  it("gives the registry of the cluster, not a global default", async () => {
    // Cross-cloud pulls work and cost egress on every pull, and an ECR credential expires after
    // twelve hours — so an image goes to the registry of the cloud that will run it.
    const azure = await seedRegion("azure", `eastus-${v7().slice(-6)}`)
    await seedCluster(azure, `aks-${v7().slice(-6)}`, "sproutos.azurecr.io")

    const placement = await fetchPlacement(db).forProject(await seedProject(azure))

    expect(placement?.registry).toBe("sproutos.azurecr.io")
  })

  it("returns nothing when the requested region has no cluster", async () => {
    // The important one. A customer who asked for a region and silently got another has had a
    // data-residency promise broken by a default — a deployment that refuses to start is enormously
    // preferable to one that starts in the wrong country.
    const empty = await seedRegion("aws", `eu-west-1-${v7().slice(-6)}`)

    expect(await fetchPlacement(db).forProject(await seedProject(empty))).toBeUndefined()
  })

  it("will not place a project on a draining cluster", async () => {
    const region = await seedRegion("aws", `us-east-1-${v7().slice(-6)}`)
    const id = await seedCluster(
      region,
      `eks-${v7().slice(-6)}`,
      "x.dkr.ecr.us-east-1.amazonaws.com",
    )
    await db.updateTable("cluster").set({ status: "draining" }).where("id", "=", id).execute()

    expect(await fetchPlacement(db).forProject(await seedProject(region))).toBeUndefined()
  })

  it("is stable, so two deployments of one project land together", async () => {
    // `order by random()` would scatter one customer's workloads across clusters for no reason
    // anybody could later explain.
    const region = await seedRegion("aws", `us-east-2-${v7().slice(-6)}`)
    await seedCluster(region, "eks-aaa", "a.example")
    await seedCluster(region, "eks-bbb", "b.example")
    const projectId = await seedProject(region)

    const first = await fetchPlacement(db).forProject(projectId)
    const second = await fetchPlacement(db).forProject(projectId)

    expect(first?.clusterId).toBe(second?.clusterId)
    expect(first?.registry).toBe("a.example")
  })
})

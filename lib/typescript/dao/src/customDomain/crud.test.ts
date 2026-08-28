import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { crudCustomDomain } from "./crud"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

describe.runIf(reachable)("custom-domain reconciliation fencing", () => {
  const userId = v7()
  const organizationId = v7()
  const repositoryId = v7()
  const projectId = v7()
  const domainId = v7()

  beforeAll(async () => {
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.test` })
      .execute()
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        slug: `domain-fence-${organizationId}`,
        name: "Domain fence",
        kind: "personal",
        ownerUserId: userId,
      })
      .execute()
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId,
        githubRepoId: Date.now(),
        ownerLogin: "test",
        name: `domain-fence-${repositoryId}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id: projectId,
        organizationId,
        repositoryId,
        name: "Domain fence",
        slug: `domain-fence-${projectId}`,
      })
      .execute()
    await db
      .insertInto("customDomain")
      .values({
        id: domainId,
        organizationId,
        projectId,
        hostname: `${domainId}.example.test`,
        verificationToken: "proof",
        status: "propagating",
      })
      .execute()
  })

  afterAll(async () => {
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
    await db.destroy()
  })

  it("revokes a stale issuance lease before it can overwrite deletion with active", async () => {
    const lease = v7()
    expect(await crudCustomDomain(db).claimReconciliation(domainId, lease)).toBeDefined()

    await crudCustomDomain(db).beginDelete(organizationId, domainId)
    expect(
      await crudCustomDomain(db).updateReconciliation(domainId, lease, {
        status: "active",
        deployedCertificateObjectKey: `custom-domains/${domainId}/current.json`,
        deployedCertificateObjectVersion: "stale-version",
      }),
    ).toBeUndefined()

    expect(
      await db
        .selectFrom("customDomain")
        .select(["status", "reconcileLeaseToken", "deployedCertificateObjectVersion"])
        .where("id", "=", domainId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "deleting",
      reconcileLeaseToken: null,
      deployedCertificateObjectVersion: null,
    })
  })
})

import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { fetchGithubInstallation } from "./fetch"

let reachable = false
let organizationId: string
let ownerUserId: string
let repositoryId: string
let linkedInstallationId: string

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  ownerUserId = v7()
  organizationId = v7()
  repositoryId = v7()
  linkedInstallationId = v7()

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `install-${ownerUserId}@test.invalid`, name: "Install Test" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Installation Test Org",
      slug: `install-test-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  await db
    .insertInto("githubInstallation")
    .values([
      {
        id: v7(),
        organizationId,
        installationId: String(Date.now()),
        accountLogin: "stale-installation",
        accountType: "Organization",
      },
      {
        id: linkedInstallationId,
        organizationId,
        installationId: String(Date.now() + 1),
        accountLogin: "linked-installation",
        accountType: "Organization",
      },
    ])
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: String(Date.now()),
      ownerLogin: "install-test",
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
      githubInstallationId: linkedInstallationId,
    })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("githubInstallation").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })
  await db.destroy()
})

describe("fetchGithubInstallation", () => {
  it("uses the installation linked to the repository instead of another org installation", async ({
    skip,
  }) => {
    if (!reachable) skip()

    const installation = await fetchGithubInstallation(db).getForRepository(
      organizationId,
      repositoryId,
      ["id", "accountLogin"],
    )

    expect(installation).toEqual({
      id: linkedInstallationId,
      accountLogin: "linked-installation",
    })
  })
})

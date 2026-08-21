import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { crudSandbox } from "./crud"
import { fetchSandbox } from "./fetch"

/**
 * Against a real Postgres, because the property under test is a SQL interval comparison and there
 * is nothing to observe about it anywhere else.
 */
let reachable = false
let organizationId: string
let ownerUserId: string
let repositoryId: string
let projectId: string

/**
 * A real `user` row.
 *
 * `sandbox.user_id` has a foreign key, so a random UUID is a constraint violation rather than
 * "some other user" — the first version of these tests used `v7()` and failed on the insert.
 */
async function anotherUser(): Promise<string> {
  const id = v7()
  await db
    .insertInto("user")
    .values({ id, email: `sbx-${id}@test.invalid`, name: "Other" })
    .execute()
  users.push(id)
  return id
}

const users: string[] = []

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
  projectId = v7()

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `sbx-${ownerUserId}@test.invalid`, name: "Sandbox Test" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Sandbox Test Org",
      slug: `sbx-test-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
      ownerLogin: "sbx-test",
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({ id: projectId, organizationId, repositoryId, name: "Sandbox", slug: "sbx-test" })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("sandbox").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx
      .deleteFrom("user")
      .where("id", "in", [ownerUserId, ...users])
      .execute()
  })
  await db.destroy()
})

describe("fetchSandbox", () => {
  it("finds a user's sandbox for a project, scoped by organization", async ({ skip }) => {
    if (!reachable) skip()
    const created = await crudSandbox(db).create({
      projectId,
      userId: ownerUserId,
      state: "running",
    })

    expect((await fetchSandbox(db).forUser(organizationId, projectId, ownerUserId))?.id).toBe(
      created.id,
    )
    // The id in a URL is the least trustworthy thing in the request; a different organization must
    // not reach it even with the right project and user.
    expect(await fetchSandbox(db).forUser(v7(), projectId, ownerUserId)).toBeUndefined()
    expect(await fetchSandbox(db).getInOrganization(v7(), created.id)).toBeUndefined()
  })

  it("lists one whose idle timeout has passed, and not one whose has not", async ({ skip }) => {
    if (!reachable) skip()
    const stale = await crudSandbox(db).create({
      projectId,
      userId: ownerUserId,
      state: "running",
      idleTimeoutS: 60,
      lastActivityAt: new Date(Date.now() - 120_000),
    })
    const fresh = await crudSandbox(db).create({
      projectId,
      userId: await anotherUser(),
      state: "running",
      idleTimeoutS: 3600,
      lastActivityAt: new Date(),
    })

    const ids = (await fetchSandbox(db).idle()).map((row) => row.id)
    expect(ids).toContain(stale.id)
    expect(ids).not.toContain(fresh.id)
  })

  it("never lists an always-on sandbox, however idle", async ({ skip }) => {
    if (!reachable) skip()
    // A caller that forgets this stops a customer's long-running environment, and the symptom is
    // "it keeps dying" with nothing in any log to explain it.
    const pinned = await crudSandbox(db).create({
      projectId,
      userId: await anotherUser(),
      state: "running",
      idleTimeoutS: 1,
      alwaysOn: true,
      lastActivityAt: new Date(Date.now() - 86_400_000),
    })
    expect((await fetchSandbox(db).idle()).map((row) => row.id)).not.toContain(pinned.id)
  })

  it("touch moves it out of the idle set", async ({ skip }) => {
    if (!reachable) skip()
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId: await anotherUser(),
      state: "running",
      idleTimeoutS: 60,
      lastActivityAt: new Date(Date.now() - 120_000),
    })
    expect((await fetchSandbox(db).idle()).map((row) => row.id)).toContain(sandbox.id)

    await crudSandbox(db).touch(sandbox.id)
    expect((await fetchSandbox(db).idle()).map((row) => row.id)).not.toContain(sandbox.id)
  })
})

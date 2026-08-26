import { crudSandbox } from "@lib/dao"
import {
  daytonaConfigFromEnv,
  sandboxDriverFromEnv,
  SNAPSHOT_RESOURCES,
  type SandboxDriver,
} from "@lib/sandbox"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { reapSandboxes, SANDBOX_KINDS, stopSandbox } from "./sandbox"

try {
  process.loadEnvFile()
} catch {
  // CI may supply variables directly, and a checkout may intentionally have no .env.
}

let driver: SandboxDriver | undefined
try {
  daytonaConfigFromEnv()
  driver = sandboxDriverFromEnv()
} catch {
  driver = undefined
}

let reachable = false
let userId: string
let organizationId: string
let repositoryId: string
let projectId: string
const sandboxes: string[] = []

beforeAll(async () => {
  if (driver === undefined) return
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  userId = v7()
  organizationId = v7()
  repositoryId = v7()
  projectId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `reap-${userId}@test.invalid`, name: "Reap Test" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Reap Test Org",
      slug: `reap-test-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
      ownerLogin: "reap-test",
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({ id: projectId, organizationId, repositoryId, name: "Reap", slug: "reap-test" })
    .execute()
}, 120_000)

afterAll(async () => {
  if (driver !== undefined) {
    for (const id of sandboxes) await driver.destroy(id).catch(() => {})
  }
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("usageEvent").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("backgroundJob").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("sandbox").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", userId).execute()
  })
}, 120_000)

describe("an idle sandbox is actually turned off", () => {
  it("stops Daytona at the provider, and meters the time before it does", async ({ skip }) => {
    if (!reachable || driver === undefined) skip()
    const activeDriver = driver!
    const made = await activeDriver.create({
      sandboxId: `reap-${Date.now()}`,
      organizationId,
      projectId,
      userId,
      sandboxClass: "container",
      resources: SNAPSHOT_RESOURCES,
      idleTimeoutS: 900,
    })
    sandboxes.push(made.externalId)
    expect(await activeDriver.state(made.externalId)).toBe("started")

    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: made.externalId,
      provider: "daytona",
      state: "running",
      idleTimeoutS: 900,
      lastActivityAt: new Date(Date.now() - 20 * 60_000),
    })

    await reapSandboxes(
      { id: v7(), kind: SANDBOX_KINDS.reap, payload: {} } as never,
      { db } as never,
    )

    const queued = await db
      .selectFrom("backgroundJob")
      .select(["id", "payload"])
      .where("kind", "=", SANDBOX_KINDS.stop)
      .orderBy("createdAt", "desc")
      .limit(1)
      .executeTakeFirstOrThrow()
    expect((queued.payload as { sandboxId?: string }).sandboxId).toBe(sandbox.id)

    await stopSandbox(() => activeDriver)(
      { id: queued.id, kind: SANDBOX_KINDS.stop, payload: queued.payload } as never,
      { db } as never,
    )

    expect(await activeDriver.state(made.externalId)).toBe("stopped")
    const row = await db
      .selectFrom("sandbox")
      .select(["state", "meteredThrough"])
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row.state).toBe("stopped")
    expect(row.meteredThrough).not.toBeNull()

    const usage = await db
      .selectFrom("usageEvent")
      .select(["quantity"])
      .where("organizationId", "=", organizationId)
      .execute()
    expect(usage.length).toBeGreaterThan(0)
  }, 600_000)
})

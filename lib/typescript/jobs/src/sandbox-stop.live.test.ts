import { crudSandbox } from "@lib/dao"
import { dockerConfigFromEnv, dockerDriver } from "@lib/sandbox"
import { db } from "@sproutos/db"
import { execFile } from "node:child_process"
import { sql } from "kysely"
import { promisify } from "node:util"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { reapSandboxes, SANDBOX_KINDS, stopSandbox } from "./sandbox"

const run = promisify(execFile)

/**
 * The fifteen-minute idle timer, against a sandbox that exists.
 *
 * `sandbox.test.ts` proves the reaper enqueues a stop: rows in, rows out. That is the whole of what
 * it can prove without a provider, and it is not the promise — the promise is that the machine goes
 * away, which is the difference between a feature and a bill. Nothing had ever checked the second
 * half, because until the docker driver there was no sandbox anywhere to check it against.
 */
let reachable = false
let userId: string
let organizationId: string
let repositoryId: string
let projectId: string

const driver = dockerDriver(dockerConfigFromEnv())
const containers: string[] = []

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 })
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
  for (const id of containers) await driver.destroy(id).catch(() => {})
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

/** What docker says the container is doing, or `gone` once it has been removed. */
async function containerState(externalId: string): Promise<string> {
  const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Status}}", externalId]).catch(
    () => ({ stdout: "gone" }),
  )
  return stdout.trim()
}

describe("an idle sandbox is actually turned off", () => {
  it("stops the container, and meters the time before it does", async ({ skip }) => {
    if (!reachable) skip()

    const made = await driver.create({
      sandboxId: `reap-${Date.now()}`,
      organizationId,
      projectId,
      userId,
      sandboxClass: "container",
      resources: { cpu: 1, memoryGib: 1, diskGib: 4 },
      idleTimeoutS: 900,
    })
    containers.push(made.externalId)
    expect(await containerState(made.externalId)).toBe("running")

    // Fifteen minutes of nothing, which is the rule as stated: `idle_timeout_s` defaults to 900 and
    // the comparison is per-row, so this is the real timeout rather than a shortened stand-in.
    const sandbox = await crudSandbox(db).create({
      projectId,
      userId,
      externalId: made.externalId,
      provider: "docker",
      state: "running",
      idleTimeoutS: 900,
      lastActivityAt: new Date(Date.now() - 20 * 60_000),
    })

    await reapSandboxes(
      { id: v7(), kind: SANDBOX_KINDS.reap, payload: {} } as never,
      {
        db,
      } as never,
    )

    const queued = await db
      .selectFrom("backgroundJob")
      .select(["id", "payload"])
      .where("kind", "=", SANDBOX_KINDS.stop)
      .orderBy("createdAt", "desc")
      .limit(1)
      .executeTakeFirstOrThrow()
    expect((queued.payload as { sandboxId?: string }).sandboxId).toBe(sandbox.id)

    /*
      The handler is run directly rather than through a worker.

      A worker claims by priority and age across every kind, so draining the queue here would run
      whatever else happens to be in it — which on a developer's database is thousands of rows from
      other work. What is under test is the stop, not the ordering `queue.test.ts` covers.
    */
    await stopSandbox(() => driver)(
      { id: queued.id, kind: SANDBOX_KINDS.stop, payload: queued.payload } as never,
      { db } as never,
    )

    // The promise, asserted where it is kept: at the provider.
    expect(await containerState(made.externalId)).toBe("exited")

    const row = await db
      .selectFrom("sandbox")
      .select(["state", "meteredThrough"])
      .where("id", "=", sandbox.id)
      .executeTakeFirstOrThrow()
    expect(row.state).toBe("stopped")
    // Metered *before* stopping: after the state says stopped, the meter skips the row, so the tail
    // between the last run and the stop would be unbillable with nothing left to notice it.
    expect(row.meteredThrough).not.toBeNull()

    const usage = await db
      .selectFrom("usageEvent")
      .select(["quantity"])
      .where("organizationId", "=", organizationId)
      .execute()
    expect(usage.length).toBeGreaterThan(0)
  }, 300_000)
})

import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { crudSandbox, SANDBOX_STATES } from "./crud"
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

beforeEach(async () => {
  if (!reachable || !projectId) return
  await db.deleteFrom("sandbox").where("projectId", "=", projectId).execute()
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

/*
  The words this code writes into `sandbox` have to be words the database permits.

  Three separate times a value was invented that a check constraint forbade, and each time the
  constraint violation *replaced* the error that was actually being handled:

  - `state: "error"` in the pod-create failure path. `sandbox_state_check` permits `starting`,
    `running`, `idle`, `stopped`, `failed` — so the recording of the failure threw, and Postgres
    complaining about a column value was the only thing in the log. Whatever had gone wrong creating
    the pod was gone.
  - `runtime_class: "none"`, writing down the truth that the pod got no RuntimeClass.
    `sandbox_runtime_class_check` permitted only `kata-fc` and `kata-clh`, so the schema could not
    represent a sandbox without a VM boundary — and every row claimed one, from the column default.
    That is fixed by migration rather than by choosing a different word.
  - and `blocked` on `workflow_run_step`, before either of these, which is why
    `workflow-run.test.ts` carries the same test for the same reason.

  Read out of `pg_constraint` rather than copied here: a copy of a constraint is a second place for
  the vocabulary to drift, and drift is the whole failure.
*/
describe("the sandbox vocabulary", () => {
  let reachable = false
  let allowed: { state: string[] } = { state: [] }

  beforeAll(async () => {
    try {
      const rows = await sql<{ conname: string; def: string }>`
        select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
        where conrelid = 'sandbox'::regclass and contype = 'c'
      `.execute(db)
      reachable = true

      const values = (name: string) =>
        [
          ...(rows.rows.find((row) => row.conname === name)?.def.matchAll(/'([a-z_-]+)'/g) ?? []),
        ].map((match) => match[1])

      allowed = { state: values("sandbox_state_check") }
    } catch {
      /* not reachable */
    }
  })

  /*
    Both directions, not a subset.

    A subset check would pass on the union that started this — it omitted `idle` and `failed`, and
    omissions are how a state the database can hold becomes a state no code handles. Equality is
    what makes `SANDBOX_STATES` the constraint rather than a guess about it.
  */
  it("declares exactly the states the check constraint allows", ({ skip }) => {
    if (!reachable) skip()
    expect([...SANDBOX_STATES].sort()).toEqual([...allowed.state].sort())
  })

  /*
    Neither the provider nor the sandbox class is enumerated, and that is the fix rather than an
    omission.

    `sandbox_runtime_class_check` listed `kata-fc` and `kata-clh`, then gained `none`, and then a
    GKE Sandbox node pool made `gvisor` the honest answer and it was rejected too. Each attempt to
    name the set ended with the *truth* being refused while a stale default stayed legal. The
    provider owns which classes exist — Daytona's own set is `linux-vm`, `container`, `android` and
    `windows`, and it will grow — so what is checked is the shape, and `SANDBOX_CLASSES` in
    `@lib/sandbox` owns which of them this platform actually supports.
  */
  it("accepts any of the provider's classes, including ones we do not use yet", async ({
    skip,
  }) => {
    if (!reachable) skip()

    for (const sandboxClass of ["container", "android", "linux-vm", "windows"]) {
      const row = await crudSandbox(db).create({
        projectId,
        userId: await anotherUser(),
        state: "stopped",
        sandboxClass,
      })
      expect(row.sandboxClass).toBe(sandboxClass)
    }
  })

  it("refuses a sandbox class that could not be an identifier", async ({ skip }) => {
    if (!reachable) skip()
    await expect(
      crudSandbox(db).create({
        projectId,
        userId: ownerUserId,
        state: "stopped",
        sandboxClass: "Not A Class",
      }),
    ).rejects.toThrow(/sandbox_class_check/)
  })

  /*
    Resources are what `sandbox.meter` bills from, so a zero is not a validation error — it is a
    free sandbox, and free compute has no error state (finding 0011). The constraint is the only
    thing standing between a unit mix-up and a customer paying nothing for real usage.
  */
  it("refuses a resource shape that would bill nothing", async ({ skip }) => {
    if (!reachable) skip()

    const impossible = [
      { cpu: 0 },
      { memoryGib: 0 },
      { diskGib: 0 },
      // A unit mix-up: MiB passed where GiB was meant.
      { memoryGib: 4096 },
    ]

    for (const resources of impossible) {
      await expect(
        crudSandbox(db).create({
          projectId,
          userId: ownerUserId,
          state: "stopped",
          ...resources,
        }),
      ).rejects.toThrow(/sandbox_resources_check/)
    }
  })

  /*
    One row per remote sandbox.

    A provision retried after losing its response can otherwise attach a second row to the same
    rented container, and then both rows meter it. The customer pays twice for one sandbox and the
    second charge is indistinguishable from a real one.
  */
  it("refuses a second row for the same provider sandbox", async ({ skip }) => {
    if (!reachable) skip()
    // Vitest can discover both source and an existing build output in the same checkout. A clock
    // value lets those two copies collide before either reaches the assertion this test owns.
    const externalId = `dup-${v7()}`
    await crudSandbox(db).create({ projectId, userId: ownerUserId, state: "stopped", externalId })
    await expect(
      crudSandbox(db).create({
        projectId,
        userId: await anotherUser(),
        state: "stopped",
        externalId,
      }),
    ).rejects.toThrow(/sandbox_provider_external_id_key/)
  })

  it("allows different users to have rows with no provider sandbox yet", async ({ skip }) => {
    if (!reachable) skip()

    const rows = []
    for (let i = 0; i < 2; i += 1) {
      rows.push(
        await crudSandbox(db).create({
          projectId,
          userId: await anotherUser(),
          state: "starting",
        }),
      )
    }
    expect(rows.map((row) => row.externalId)).toEqual([null, null])
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
  })

  it("refuses two sandboxes for one scoped project and user", async ({ skip }) => {
    if (!reachable) skip()
    await crudSandbox(db).create({ projectId, userId: ownerUserId, state: "starting" })
    await expect(
      crudSandbox(db).create({ projectId, userId: ownerUserId, state: "starting" }),
    ).rejects.toThrow(/sandbox_project_user_purpose_key/)
  })

  it("does not allow the word the failure path first used", ({ skip }) => {
    if (!reachable) skip()
    expect(allowed.state).not.toContain("error")
  })
})

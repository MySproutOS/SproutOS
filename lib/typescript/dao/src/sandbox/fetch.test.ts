import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { crudSandbox, NO_RUNTIME_CLASS, RUNTIME_CLASS_PATTERN, SANDBOX_STATES } from "./crud"
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
      runtimeClass: "none",
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
      runtimeClass: "none",
      idleTimeoutS: 60,
      lastActivityAt: new Date(Date.now() - 120_000),
    })
    const fresh = await crudSandbox(db).create({
      projectId,
      userId: await anotherUser(),
      state: "running",
      runtimeClass: "none",
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
      runtimeClass: "none",
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
      runtimeClass: "none",
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
  let allowed: { state: string[]; runtimeClass: string[] } = { state: [], runtimeClass: [] }

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

      allowed = {
        state: values("sandbox_state_check"),
        runtimeClass: values("sandbox_runtime_class_check"),
      }
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
    The runtime class is not enumerated, and that is the fix rather than an omission.

    The constraint listed `kata-fc` and `kata-clh`, then gained `none`, and then a GKE Sandbox node
    pool made `gvisor` the honest answer and it was rejected too. A RuntimeClass is created on the
    cluster; there is no set this schema can know, and each attempt to name one ended with the truth
    being refused while a stale default stayed legal. What is checked now is the shape.
  */
  it("accepts any Kubernetes object name as a runtime class", async ({ skip }) => {
    if (!reachable) skip()

    for (const name of ["gvisor", "kata-fc", "runsc", NO_RUNTIME_CLASS]) {
      expect(name).toMatch(RUNTIME_CLASS_PATTERN)
      const row = await crudSandbox(db).create({
        projectId,
        userId: ownerUserId,
        state: "stopped",
        runtimeClass: name,
      })
      expect(row.runtimeClass).toBe(name)
    }
  })

  it("still refuses something a RuntimeClass could not be called", async ({ skip }) => {
    if (!reachable) skip()

    await expect(
      crudSandbox(db).create({
        projectId,
        userId: ownerUserId,
        state: "stopped",
        runtimeClass: "Not A Runtime Class",
      }),
    ).rejects.toThrow(/sandbox_runtime_class_check/)
  })

  /*
    No default on `runtime_class`.

    The column defaulted to `kata-clh`, so a row asserted a hardware-virtualized boundary purely by
    existing. A default is exactly the wrong mechanism for a fact about a pod that has not been
    created yet — see the migration.
  */
  it("has no default runtime class for a row to inherit a lie from", async ({ skip }) => {
    if (!reachable) skip()
    const row = await sql<{ default: string | null }>`
      select column_default as "default"
      from information_schema.columns
      where table_name = 'sandbox' and column_name = 'runtime_class'
    `.execute(db)
    expect(row.rows[0]?.default).toBeNull()
  })

  it("does not allow the word the failure path first used", ({ skip }) => {
    if (!reachable) skip()
    expect(allowed.state).not.toContain("error")
  })
})

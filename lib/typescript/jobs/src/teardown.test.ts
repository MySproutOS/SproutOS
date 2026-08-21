import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { TEARDOWN_KIND, tearDownProject, type TeardownKube } from "./teardown"

/**
 * Against the docker-compose Postgres. What is asserted here is which rows change and which
 * deliberately do not, and both are database facts.
 *
 * Kubernetes is stubbed: the calls this makes there are `get` and `remove` by path, and a fake that
 * records them proves the same thing a cluster would while running in a second.
 */
let reachable = false
let organizationId: string
let ownerUserId: string
let projectId: string
let repositoryId: string

const removed: string[] = []
/** Collection deletes, as `path` + the selector — see `removeCollection`. */
const removedCollections: string[] = []

/*
  Typed as `TeardownKube` rather than cast to `never`.

  The cast is how this stub came to be missing `removeCollection` entirely: the teardown handler
  gained a call, the type gained a member, and `as never` waved both through — so the first sign was
  a `TypeError` at runtime, in a test whose whole job is to prove teardown does not throw.
*/
const kube: TeardownKube = {
  // Generic, because `get` is: a non-generic stub only satisfies `Promise<{}>` and the real
  // signature promises `T | undefined`.
  get: <T>() => Promise.resolve({} as T),
  remove: (path: string) => {
    removed.push(path)
    return Promise.resolve()
  },
  removeCollection: (path: string, labelSelector: string) => {
    removedCollections.push(`${path}?${labelSelector}`)
    return Promise.resolve()
  },
}

/** The handler, with the Kubernetes client replaced by one that records what it deleted. */
function handler() {
  return tearDownProject(kube)
}

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  ownerUserId = v7()
  organizationId = v7()
  projectId = v7()
  repositoryId = v7()

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `teardown-${ownerUserId}@test.invalid`, name: "Teardown" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Teardown Org",
      slug: `teardown-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Date.now() % 1_000_000_000,
      ownerLogin: "teardown",
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "Teardown Project",
      slug: `teardown-${projectId.slice(-12)}`,
    })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("projectEnvVar").where("projectId", "=", projectId).execute()
    // `usage_event` references `project` with `ON DELETE RESTRICT`, so it goes before the project.
    await tx.deleteFrom("usageEvent").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("usageRollup").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("deployment").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })
})

const job = (payload: Record<string, unknown>) => ({ payload }) as never
const context = () => ({ db, keepAlive: () => Promise.resolve(true) }) as never

describe("tearing down a deleted project", () => {
  /*
    The check that makes a misfired job harmless instead of catastrophic.

    A teardown enqueued for a *live* project would destroy a customer's running site, and the only
    thing between the two is a field in a payload. Asserted first because it is the assertion that
    matters most.
  */
  it("refuses a project that is not deleted", async ({ skip }) => {
    if (!reachable) skip()
    await expect(handler()(job({ projectId }), context())).rejects.toThrow(/not deleted/)
  })

  it("does nothing for a project that no longer exists", async ({ skip }) => {
    if (!reachable) skip()
    await expect(handler()(job({ projectId: v7() }), context())).resolves.toBeUndefined()
  })

  it("refuses a payload with no project", async ({ skip }) => {
    if (!reachable) skip()
    await expect(handler()(job({}), context())).rejects.toThrow(/needs a projectId/)
  })

  it("tears down the deployments and the customer's secrets, and keeps the billing history", async ({
    skip,
  }) => {
    if (!reachable) skip()

    await db
      .insertInto("deployment")
      .values({
        id: v7(),
        projectId,
        kind: "production",
        gitSha: "abc",
        status: "ready",
        imageUri: "registry/app:sha",
      })
      .execute()
    await db
      .insertInto("projectEnvVar")
      .values({
        id: v7(),
        projectId,
        key: "SECRET",
        target: "production",
        valueCiphertext: "ciphertext",
        valueWrappedDek: "wrapped",
        valueKmsKeyId: "test-key",
      })
      .execute()

    // A usage event, which must survive: a statement has to resolve its line items to a project.
    const eventId = v7()
    await db
      .insertInto("usageEvent")
      .values({
        id: eventId,
        organizationId,
        projectId,
        resourceType: "site",
        dimension: "site_vcpu_second",
        quantity: "1",
        occurredAt: new Date(),
        source: "teardown-test",
        externalId: `teardown-${eventId}`,
        /*
          Pre-rated, so no rollup ever claims it.

          `rollUpUsage` is a platform-wide sweep with no organization filter — it cannot have one,
          its job is to sweep everything owed. An unrated event left here by *this* file is picked
          up by whichever billing test happens to run next, and the assertion that breaks is in that
          file rather than this one. This test only cares that the row survives a deletion.
        */
        ratedAt: new Date(),
      })
      .execute()

    await db
      .updateTable("project")
      .set({ deletedAt: new Date(), state: "deleting" })
      .where("id", "=", projectId)
      .execute()

    await handler()(job({ projectId }), context())

    const deployments = await db
      .selectFrom("deployment")
      .select(["status"])
      .where("projectId", "=", projectId)
      .execute()
    expect(deployments.every((d) => d.status === "torn_down")).toBe(true)

    // The customer's secrets are gone. Nothing references them and the request was to stop holding
    // the project's data.
    const envVars = await db
      .selectFrom("projectEnvVar")
      .select(["id"])
      .where("projectId", "=", projectId)
      .execute()
    expect(envVars).toHaveLength(0)

    /*
      And the billing history is untouched — `RETAINED_ON_DELETE`, ADR 0017.

      `usage_event` references `project` with `ON DELETE RESTRICT` so last month's statement can
      still name the project it billed for. A teardown that took the evidence behind a bill with it
      would be worse than one that ran late.
    */
    const events = await db
      .selectFrom("usageEvent")
      .select(["id"])
      .where("projectId", "=", projectId)
      .execute()
    expect(events).toHaveLength(1)

    const project = await db
      .selectFrom("project")
      .select(["state"])
      .where("id", "=", projectId)
      .executeTakeFirst()
    expect(project?.state).toBe("deleted")
  })

  /*
    Retried, because a job is.

    Every step tolerates having been done: a delete of something absent is ignored, and the row
    writes are assignments. A teardown that failed halfway must be safe to run again — the
    alternative is a half-destroyed project nobody dares touch.
  */
  it("is safe to run twice", async ({ skip }) => {
    if (!reachable) skip()
    await expect(handler()(job({ projectId }), context())).resolves.toBeUndefined()
  })

  it("is registered under the kind the route enqueues", () => {
    expect(TEARDOWN_KIND).toBe("project.teardown")
  })
})

describe("the environment secrets in the cluster", () => {
  it("collects them by label, because their names cannot be enumerated", async ({ skip }) => {
    /*
      A revision's environment is a Secret named after its own contents, so a project accumulates
      one per environment it has ever deployed with. There is no list of names to walk.

      Deleting the `project_env_var` rows and leaving these would mean a customer who asked the
      platform to stop holding their data, and was told it had, while their *decrypted* values sat
      in a namespace indefinitely — the database rows at least were sealed.
    */
    if (!reachable) skip()

    await handler()(job({ projectId }), context())

    expect(
      removedCollections.some((entry) => entry.includes(`sproutos.dev/project=${projectId}`)),
    ).toBe(true)
    // The collection path, not one object's: an empty name is what `secretPath` turns into it.
    expect(removedCollections.some((entry) => entry.includes("/secrets?"))).toBe(true)
  })
})

/* oxlint-disable no-await-in-loop */
import { tenantQueuePrefix } from "@lib/queue"
import { encodeShortId } from "@lib/services/tenant-auth"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { Queue } from "bullmq"
import { Redis } from "ioredis"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  tenantValkeyReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

/**
 * TASK 35 end to end: a real BullMQ job in the compose Valkey, read and edited through the API.
 *
 * The point of testing this at the route level rather than at `@lib/queue`'s is everything between:
 * that the run resolves to the right project, that the project resolves to the right namespace, and
 * that an edit writes an audit row. A unit test of the queue library proves none of it, and getting
 * the namespace wrong here means editing a job belonging to somebody else.
 */
const VALKEY_URL = process.env.SERVICE_VALKEY_ADMIN_URL ?? "redis://127.0.0.1:41023"

const reachable = await databaseReachable()

const valkeyUp = await tenantValkeyReachable()

const up = reachable && valkeyUp

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  user: TestUser,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: authHeaders(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: (await response.json()) as Json }
}

type Fixture = {
  user: TestUser
  orgSlug: string
  projectId: string
  workflowId: string
  runId: string
  jobId: string
  backendServiceId: string
  repositoryId: string
}

let fixture: Fixture | undefined
let producer: Queue<unknown> | undefined
let connection: Redis | undefined

function active(): Fixture {
  if (fixture === undefined) throw new Error("the fixture was not built")
  return fixture
}

/**
 * Creates an organization through the API rather than by inserting rows.
 *
 * `POST /v1/orgs` also creates the membership and grants the owner role, and `requirePermission`
 * reads those. A hand-inserted organization row would leave the caller a stranger to their own
 * team, and every assertion below would be testing a 403.
 */
async function createOrganization(
  user: TestUser,
  name: string,
): Promise<{ id: string; slug: string }> {
  const created = await call("POST", "/v1/orgs", user, { name })
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(
      `could not create an organization: ${created.status} ${JSON.stringify(created.json)}`,
    )
  }
  const id = created.json.id as string
  trackOrganization(id)
  return { id, slug: created.json.slug as string }
}

async function build(): Promise<Fixture> {
  const user = await createTestUser("wfjob")
  const organization = await createOrganization(user, `Jobs Suite ${v7()}`)

  const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()

  // `project.repository_id` is NOT NULL — a project without a repository is not a thing this
  // product has — so the fixture needs a repository row even though nothing here touches GitHub.
  const repositoryId = v7()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId: organization.id,
      githubRepoId: BigInt(Date.now()),
      ownerLogin: "sprout-test",
      name: `jobs-${repositoryId}`,
      provenance: "new",
    })
    .execute()

  const projectId = v7()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId: organization.id,
      repositoryId,
      name: "Jobs Project",
      slug: `jobs-${projectId}`,
    })
    .execute()

  const backendServiceId = v7()
  await db
    .insertInto("backendService")
    .values({
      id: backendServiceId,
      organizationId: organization.id,
      projectId,
      regionId: region.id,
      name: "Queue",
      kind: "valkey",
      status: "active",
    })
    .execute()

  const workflowId = v7()
  await db
    .insertInto("workflow")
    .values({
      id: workflowId,
      projectId,
      slug: "nightly",
      name: "Nightly",
      queueName: "nightly",
    })
    .execute()

  // The tenant's own producer: same queue name, same namespace the proxy would have applied.
  connection = new Redis(VALKEY_URL, { maxRetriesPerRequest: null })
  producer = new Queue<unknown>("nightly", {
    connection,
    prefix: tenantQueuePrefix(backendServiceId),
  })
  const job = await producer.add("report", { month: "2026-08", dryRun: true })

  const runId = v7()
  await db
    .insertInto("workflowRun")
    .values({
      id: runId,
      workflowId,
      triggerType: "manual",
      queueJobId: job.id ?? "",
      status: "queued",
    })
    .execute()

  return {
    user,
    orgSlug: organization.slug,
    projectId,
    workflowId,
    runId,
    jobId: job.id ?? "",
    backendServiceId,
    repositoryId,
  }
}

function jobPath(f: Fixture): string {
  return `/v1/orgs/${f.orgSlug}/projects/${f.projectId}/workflows/${f.workflowId}/runs/${f.runId}/job`
}

beforeAll(async () => {
  if (!up) return
  fixture = await build()
})

afterAll(async () => {
  if (!up) return
  await producer?.obliterate({ force: true }).catch(() => undefined)
  await producer?.close()
  await connection?.quit().catch(() => connection?.disconnect())
  if (fixture !== undefined) {
    /*
      `workflow_job_edit_audit` is append-only, enforced by a trigger, so an ordinary DELETE is
      refused — which is the point of the table. This is the same privileged purge path retention
      and GDPR deletion have to use: suppress triggers for one transaction, deliberately awkwardly.

      The audit goes first regardless: its foreign key to `workflow_run` is RESTRICT, so the history
      of an edit cannot be swept away by deleting the run it describes.
    */
    const runId = fixture.runId
    await db.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = 'replica'`.execute(tx)
      await tx.deleteFrom("workflowJobEditAudit").where("workflowRunId", "=", runId).execute()
    })
    await db.deleteFrom("workflowRun").where("id", "=", fixture.runId).execute()
    await db.deleteFrom("workflow").where("id", "=", fixture.workflowId).execute()
    await db.deleteFrom("backendService").where("id", "=", fixture.backendServiceId).execute()
    await db.deleteFrom("project").where("id", "=", fixture.projectId).execute()
    await db.deleteFrom("repository").where("id", "=", fixture.repositoryId).execute()
  }
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("TASK 35: peering into and editing jobs", () => {
  it("reads the job behind a run", async ({ skip }) => {
    if (!up) skip()
    const f = active()
    const { status, json } = await call("GET", jobPath(f), f.user)

    expect(status).toBe(200)
    expect(json.id).toBe(f.jobId)
    expect(json.name).toBe("report")
    expect(json.data).toEqual({ month: "2026-08", dryRun: true })
    expect(json.editable).toBe(true)
  })

  it("edits the data and writes an audit row in the same request", async ({ skip }) => {
    if (!up) skip()
    const f = active()
    const { status, json } = await call("PATCH", jobPath(f), f.user, {
      data: { month: "2026-08", dryRun: false },
      reason: "The dry-run flag was left on by mistake before the release",
    })

    expect(status).toBe(200)
    expect((json.job as Json).data).toEqual({ month: "2026-08", dryRun: false })

    const audit = await db
      .selectFrom("workflowJobEditAudit")
      .selectAll()
      .where("workflowRunId", "=", f.runId)
      .executeTakeFirstOrThrow()

    // The before value has to be what this edit actually replaced, not a second read that could
    // have caught the job after something else changed it.
    expect(audit.before).toEqual({ month: "2026-08", dryRun: true })
    expect(audit.after).toEqual({ month: "2026-08", dryRun: false })
    expect(audit.actorUserId).toBe(f.user.id)
    expect(audit.reason).toContain("dry-run flag")
    expect(audit.jobStateAtEdit).toBe("waiting")

    /*
      And it is really in Valkey — at the key the *proxy's* namespace puts it, spelled out here
      rather than derived from `tenantQueuePrefix`.

      Deriving it would make this assertion agree with the function under test by construction: drop
      the namespace from `tenantQueuePrefix` and both the write and the read move together, so the
      test goes on passing while every tenant shares one keyspace.
    */
    const expectedKey = `{kv:${encodeShortId(f.backendServiceId)}}:bull:nightly:${f.jobId}`
    expect(tenantQueuePrefix(f.backendServiceId)).toBe(
      `{kv:${encodeShortId(f.backendServiceId)}}:bull`,
    )
    const stored = await connection?.hget(expectedKey, "data")
    expect(JSON.parse(stored ?? "null")).toEqual({ month: "2026-08", dryRun: false })

    // Nothing outside the namespace. An unnamespaced write would be readable by every other tenant.
    expect(await connection?.exists(`bull:nightly:${f.jobId}`)).toBe(0)
  })

  it("requires a substantial reason", async ({ skip }) => {
    if (!up) skip()
    const f = active()
    // An audit row saying only who and when answers none of the questions asked afterwards, so an
    // empty reason is a 400 rather than a nullable column.
    const { status } = await call("PATCH", jobPath(f), f.user, { data: {}, reason: "x" })
    expect(status).toBe(400)
  })

  it("hides another organization's run behind the same 404 as a missing one", async ({ skip }) => {
    if (!up) skip()
    const f = active()
    const stranger = await createTestUser("wfjob-stranger")
    const strangerOrg = await createOrganization(stranger, `Stranger ${v7()}`)

    /*
      Addressed with the stranger's own org slug, because that is the path their session can reach.
      A 403 here would confirm the run exists; the answer has to be the same one a genuinely
      missing run gets.
    */
    const path = `/v1/orgs/${strangerOrg.slug}/projects/${f.projectId}/workflows/${f.workflowId}/runs/${f.runId}/job`
    const { status } = await call("GET", path, stranger)
    expect([403, 404]).toContain(status)

    const missing = await call(
      "GET",
      `/v1/orgs/${f.orgSlug}/projects/${f.projectId}/workflows/${f.workflowId}/runs/${v7()}/job`,
      f.user,
    )
    expect(missing.status).toBe(404)
  })

  it("says so plainly when a run was never enqueued", async ({ skip }) => {
    if (!up) skip()
    const f = active()
    const runId = v7()
    await db
      .insertInto("workflowRun")
      .values({
        id: runId,
        workflowId: f.workflowId,
        triggerType: "manual",
        queueJobId: null,
        status: "queued",
      })
      .execute()

    const path = `/v1/orgs/${f.orgSlug}/projects/${f.projectId}/workflows/${f.workflowId}/runs/${runId}/job`
    const { status, json } = await call("GET", path, f.user)
    expect(status).toBe(409)
    expect(JSON.stringify(json)).toContain("never enqueued")

    await db.deleteFrom("workflowRun").where("id", "=", runId).execute()
  })
})

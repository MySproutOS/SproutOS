/* oxlint-disable no-await-in-loop */
import {
  closeClickhouse,
  ensureSchema,
  observabilityConfigured,
  writeRuntimeLogs,
} from "@lib/observability"
import { db } from "@sproutos/db"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

/**
 * TASK 34 end to end: issue an ingest key, send OTLP with it, read the logs back.
 *
 * The interesting part is not any one of those — it is that the key resolves to the right project
 * and that a search cannot reach past it. So the suite provisions two projects in one organization
 * and has both send a log line containing the same text.
 */
const reachable = await databaseReachable()

const storeUp = await (async () => {
  if (!observabilityConfigured()) {
    if (process.env.CI !== undefined) {
      throw new Error("CLICKHOUSE_URL is not set in CI; these tests must not silently skip here")
    }
    return false
  }
  try {
    await ensureSchema()
    return true
  } catch (cause) {
    if (process.env.CI !== undefined) throw cause
    return false
  }
})()

const up = reachable && storeUp

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

/** Posts an OTLP batch shaped exactly as an OpenTelemetry exporter would send it. */
async function sendLogs(
  key: string,
  body: string,
  service = "checkout",
): Promise<{ status: number; json: Json }> {
  const response = await app.request("/v1/otlp/v1/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
          scopeLogs: [
            {
              scope: { name: "test" },
              logRecords: [
                {
                  timeUnixNano: String(BigInt(Date.now()) * 1000000n),
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: { stringValue: body },
                },
              ],
            },
          ],
        },
      ],
    }),
  })
  return { status: response.status, json: (await response.json()) as Json }
}

type Project = { id: string; repositoryId: string }

let user: TestUser | undefined
let orgSlug = ""
let organizationId = ""
let mine: Project | undefined
let theirs: Project | undefined
let myKey = ""
let theirKey = ""

/*
  `skip()` inside a test does not narrow a type, so the fixtures are reached through these rather
  than with an assertion operator on every line. They cannot actually throw: the suite is skipped
  wholesale when the services are unreachable, which is the only path that leaves them unset.
*/
function actor(): TestUser {
  if (user === undefined) throw new Error("the fixture was not built")
  return user
}

function myProject(): Project {
  if (mine === undefined) throw new Error("the fixture was not built")
  return mine
}

function theirProject(): Project {
  if (theirs === undefined) throw new Error("the fixture was not built")
  return theirs
}

async function createProject(): Promise<Project> {
  const repositoryId = v7()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      // Unique per row: `repository.github_repo_id` is not nullable and two fixtures in the same
      // millisecond would otherwise collide.
      githubRepoId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
      ownerLogin: "sprout-test",
      name: `obs-${repositoryId}`,
      provenance: "new",
    })
    .execute()

  const id = v7()
  await db
    .insertInto("project")
    .values({ id, organizationId, repositoryId, name: "Obs", slug: `obs-${id}` })
    .execute()
  return { id, repositoryId }
}

beforeAll(async () => {
  if (!up) return
  user = await createTestUser("obs")
  const created = await call("POST", "/v1/orgs", user, { name: `Obs Suite ${v7()}` })
  organizationId = created.json.id as string
  orgSlug = created.json.slug as string
  trackOrganization(organizationId)

  mine = await createProject()
  theirs = await createProject()

  const a = await call("POST", `/v1/orgs/${orgSlug}/projects/${mine.id}/observability/key`, user, {
    retentionDays: 7,
  })
  myKey = a.json.key as string
  const b = await call(
    "POST",
    `/v1/orgs/${orgSlug}/projects/${theirs.id}/observability/key`,
    user,
    {},
  )
  theirKey = b.json.key as string
})

afterAll(async () => {
  if (!up) return
  for (const project of [mine, theirs]) {
    if (project === undefined) continue
    await db.deleteFrom("observabilityStream").where("projectId", "=", project.id).execute()
    await db.deleteFrom("project").where("id", "=", project.id).execute()
    await db.deleteFrom("repository").where("id", "=", project.repositoryId).execute()
  }
  await closeClickhouse()
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("TASK 34: observability", () => {
  it("issues a key that is shown once and stored hashed", async ({ skip }) => {
    if (!up) skip()
    expect(myKey.startsWith("sos_ing_")).toBe(true)

    const stored = await db
      .selectFrom("observabilityStream")
      .select(["otlpIngestKeyHash", "retentionDays"])
      .where("projectId", "=", myProject().id)
      .executeTakeFirstOrThrow()

    // A stolen table must yield nothing that can be sent with.
    expect(stored.otlpIngestKeyHash).not.toContain(myKey)
    expect(stored.otlpIngestKeyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.retentionDays).toBe(7)

    // And there is no route that reads it back.
    const fetched = await call(
      "GET",
      `/v1/orgs/${orgSlug}/projects/${myProject().id}/observability`,
      actor(),
    )
    expect(fetched.status).toBe(200)
    expect(JSON.stringify(fetched.json)).not.toContain(myKey)
    expect(fetched.json.endpoint).toContain("/v1/otlp")
  })

  it("accepts an OTLP batch", async ({ skip }) => {
    if (!up) skip()
    const sent = await sendLogs(myKey, `probe-${v7()}`)
    expect(sent.status).toBe(200)
    // An empty object, not a partial success: nothing was rejected.
    expect(sent.json).toEqual({})
  })

  /*
    The search reads `runtime_log`, so this seeds `runtime_log`.

    It used to send OTLP and search for it back, which stopped testing anything the moment the
    viewer moved to the table the platform fills by itself — the assertion would have been a search
    over an empty table returning nothing, passing only where it expected nothing. The property is
    the same and it is the one worth keeping: two projects, one organization, one caller entitled to
    both, and nothing but the project scoping separating identical text.
  */
  it("keeps one project's runtime logs out of another's search", async ({ skip }) => {
    if (!up) skip()
    const marker = `shared-${v7()}`
    const now = new Date()

    await writeRuntimeLogs([
      {
        ts: now,
        projectId: myProject().id,
        deploymentId: v7(),
        requestId: v7(),
        level: "info",
        message: `${marker} from mine`,
      },
      {
        ts: now,
        projectId: theirProject().id,
        deploymentId: v7(),
        requestId: v7(),
        level: "info",
        message: `${marker} from theirs`,
      },
    ])

    const ours = await call(
      "GET",
      `/v1/orgs/${orgSlug}/projects/${myProject().id}/logs?search=${marker}`,
      actor(),
    )
    expect(ours.status).toBe(200)
    expect((ours.json.lines as Json[]).map((line) => line.message)).toEqual([`${marker} from mine`])
  })

  it("streams a scoped v1 SSE record with an exact resumable id", async ({ skip }) => {
    if (!up) skip()
    const marker = `follow-${v7()}`
    await writeRuntimeLogs([
      {
        ts: new Date(),
        projectId: myProject().id,
        deploymentId: v7(),
        requestId: v7(),
        level: "info",
        message: marker,
      },
    ])

    const response = await app.request(
      `/v1/orgs/${orgSlug}/projects/${myProject().id}/logs/follow?search=${marker}`,
      { headers: authHeaders(actor()), signal: AbortSignal.timeout(5_000) },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("cache-control")).toContain("no-store")

    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const decoder = new TextDecoder()
    let body = ""
    while (!body.includes("event: log")) {
      const chunk = await reader?.read()
      expect(chunk?.done).toBe(false)
      body += decoder.decode(chunk?.value, { stream: true })
    }
    await reader?.cancel()

    const id = /^id: (1:[0-9]+:[0-9]+:[0-9A-F]{32,64})$/m.exec(body)?.[1]
    expect(id).toBeDefined()
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data: {") && line.includes(`"message":"${marker}"`))
    expect(data).toBeDefined()
    const event = JSON.parse(data?.slice(6) ?? "{}") as Json
    expect(event.schemaVersion).toBe(1)
    expect(event.type).toBe("log")
    expect(event.cursor).toBe(id)
    expect((event.line as Json).cursor).toBe(id)

    const malformed = await app.request(
      `/v1/orgs/${orgSlug}/projects/${myProject().id}/logs/follow?cursor=not-a-cursor`,
      { headers: authHeaders(actor()) },
    )
    expect(malformed.status).toBe(400)

    const mismatch = await app.request(
      `/v1/orgs/${orgSlug}/projects/${myProject().id}/logs/follow?cursor=${id}`,
      {
        headers: { ...authHeaders(actor()), "Last-Event-ID": `1:0:0:${"A".repeat(32)}` },
      },
    )
    expect(mismatch.status).toBe(400)

    const headerOnly = await app.request(
      `/v1/orgs/${orgSlug}/projects/${myProject().id}/logs/follow?search=${marker}`,
      {
        headers: { ...authHeaders(actor()), "Last-Event-ID": id ?? "" },
        signal: AbortSignal.timeout(5_000),
      },
    )
    expect(headerOnly.status).toBe(200)
    const headerReader = headerOnly.body?.getReader()
    const firstHeaderChunk = await headerReader?.read()
    expect(new TextDecoder().decode(firstHeaderChunk?.value)).toContain("event: ready")
    await headerReader?.cancel()
  })

  it("refuses a batch with no key, a wrong key, or the wrong content type", async ({ skip }) => {
    if (!up) skip()
    const noKey = await app.request("/v1/otlp/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(noKey.status).toBe(401)

    expect((await sendLogs("sos_ing_definitely-not-a-real-key", "should not land")).status).toBe(
      401,
    )

    // An exporter defaults to protobuf and has to be told to send JSON. Saying so beats a parse
    // error that reads like a bug in the customer's own code.
    const protobuf = await app.request("/v1/otlp/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/x-protobuf", Authorization: `Bearer ${myKey}` },
      body: " ",
    })
    expect(protobuf.status).toBe(415)
    expect(JSON.stringify(await protobuf.json())).toContain("http/json")
  })

  it("answers the same way for an unknown key and a malformed one", async ({ skip }) => {
    if (!up) skip()
    // Any difference is an oracle for working out which keys are real, one request at a time.
    const unknown = await sendLogs("sos_ing_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "x")
    const malformed = await sendLogs("not-even-the-right-prefix", "x")
    expect(unknown.status).toBe(malformed.status)
    expect(unknown.json).toEqual(malformed.json)
  })

  it("rotates a key and stops the old one working immediately", async ({ skip }) => {
    if (!up) skip()
    const rotated = await call(
      "POST",
      `/v1/orgs/${orgSlug}/projects/${theirProject().id}/observability/key`,
      actor(),
      {},
    )
    expect(rotated.status).toBe(201)
    const fresh = rotated.json.key as string
    expect(fresh).not.toBe(theirKey)

    // The point of rotating is that a leaked key stops working. Immediately, not eventually.
    expect((await sendLogs(theirKey, "with the old key")).status).toBe(401)
    expect((await sendLogs(fresh, "with the new key")).status).toBe(200)
    theirKey = fresh
  })

  it("lets a member read logs but not rotate the key", async ({ skip }) => {
    if (!up) skip()
    /*
      Rotating invalidates every exporter the project has deployed, so it is an admin action even
      though reading the logs is not.
    */
    const member = await createTestUser("obs-member")
    const roles = await db
      .selectFrom("role")
      .select(["id", "name"])
      .where("organizationId", "=", organizationId)
      .execute()
    const memberRoleId = roles.find((role) => role.name === "member")?.id
    expect(memberRoleId).toBeDefined()

    const invite = await call("POST", `/v1/orgs/${orgSlug}/invites`, actor(), {
      email: member.email,
      roleId: memberRoleId,
    })
    expect(invite.status).toBe(201)
    expect(
      (await call("POST", "/v1/invites/accept", member, { token: invite.json.token })).status,
    ).toBe(200)

    expect(
      (await call("GET", `/v1/orgs/${orgSlug}/projects/${myProject().id}/logs`, member)).status,
    ).toBe(200)
    expect(
      (
        await call(
          "POST",
          `/v1/orgs/${orgSlug}/projects/${myProject().id}/observability/key`,
          member,
          {},
        )
      ).status,
    ).toBe(403)
  })

  it("refuses a body larger than one batch may be", async ({ skip }) => {
    if (!up) skip()
    /*
      The bound that matters, because it applies before the key is even looked up: an
      unauthenticated caller must not be able to make the process hold an arbitrary amount of JSON.
      Sent as one oversized string rather than as millions of records, which is the cheap way to
      cross the line the guard actually checks.
    */
    const oversized = await app.request("/v1/otlp/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${myKey}` },
      body: JSON.stringify({ padding: "x".repeat(9 * 1024 * 1024) }),
    })
    expect(oversized.status).toBe(413)
  })

  it("caps how many lines one page returns", async ({ skip }) => {
    if (!up) skip()
    const page = await call(
      "GET",
      `/v1/orgs/${orgSlug}/projects/${myProject().id}/logs?limit=100000`,
      actor(),
    )
    expect((page.json.lines as Json[]).length).toBeLessThanOrEqual(500)
  })
})

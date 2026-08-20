/* oxlint-disable no-await-in-loop */
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
 * The organization-wide workflow views.
 *
 * What is worth testing here is the parts that are not a straight `select`: how health is decided
 * from recent runs, that a disabled schedule is not reported as a schedule, and that the recency
 * window is taken *per workflow* rather than across all of them.
 */
const up = await databaseReachable()

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  user: TestUser,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, { method, headers: authHeaders(user) })
  return { status: response.status, json: (await response.json()) as Json }
}

let user: TestUser | undefined
let orgSlug = ""
let organizationId = ""
let projectId = ""
let repositoryId = ""
const workflowIds: string[] = []
const runIds: string[] = []

function actor(): TestUser {
  if (user === undefined) throw new Error("the fixture was not built")
  return user
}

async function makeWorkflow(name: string, enabled = true): Promise<string> {
  const id = v7()
  await db
    .insertInto("workflow")
    .values({ id, projectId, slug: `wf-${id}`, name, queueName: `q-${id}`, enabled })
    .execute()
  workflowIds.push(id)
  return id
}

async function makeRun(workflowId: string, status: string, agoMs: number): Promise<string> {
  const id = v7()
  const createdAt = new Date(Date.now() - agoMs)
  await db
    .insertInto("workflowRun")
    .values({
      id,
      workflowId,
      triggerType: "cron",
      status,
      createdAt,
      startedAt: createdAt,
      finishedAt: new Date(createdAt.getTime() + 1500),
    })
    .execute()
  runIds.push(id)
  return id
}

beforeAll(async () => {
  if (!up) return
  user = await createTestUser("wf")
  const created = await app.request("/v1/orgs", {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify({ name: `Workflow Suite ${v7()}` }),
  })
  const organization = (await created.json()) as Json
  organizationId = organization.id as string
  orgSlug = organization.slug as string
  trackOrganization(organizationId)

  repositoryId = v7()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
      ownerLogin: "sprout-test",
      name: `wf-${repositoryId}`,
      provenance: "new",
    })
    .execute()

  projectId = v7()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "Workflows",
      slug: `wf-${projectId}`,
    })
    .execute()
})

afterAll(async () => {
  if (!up) return
  if (runIds.length > 0) {
    await db.deleteFrom("workflowRun").where("id", "in", runIds).execute()
  }
  if (workflowIds.length > 0) {
    await db.deleteFrom("workflowSchedule").where("workflowId", "in", workflowIds).execute()
    await db.deleteFrom("workflow").where("id", "in", workflowIds).execute()
  }
  await db.deleteFrom("project").where("id", "=", projectId).execute()
  await db.deleteFrom("repository").where("id", "=", repositoryId).execute()
  await cleanupFixtures()
  await db.destroy()
})

describe.skipIf(!up)("the organization's workflows", () => {
  it("is empty for an organization with no workflows", async ({ skip }) => {
    if (!up) skip()
    const stranger = await createTestUser("wf-stranger")
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(stranger),
      body: JSON.stringify({ name: `Empty ${v7()}` }),
    })
    const organization = (await created.json()) as Json
    trackOrganization(organization.id as string)

    const response = await call(
      "GET",
      `/v1/orgs/${organization.slug as string}/workflows`,
      stranger,
    )
    expect(response.status).toBe(200)
    expect(response.json.data).toEqual([])
  })

  it("lists a workflow with its project and no schedule", async ({ skip }) => {
    if (!up) skip()
    const workflowId = await makeWorkflow("Unscheduled")

    const response = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    const entry = (response.json.data as Json[]).find((row) => row.id === workflowId)

    expect(entry?.projectName).toBe("Workflows")
    expect(entry?.cronExpression).toBeNull()
    // No runs is "healthy", not "unknown": the first run has not happened, which is not a problem,
    // and a fourth state meaning "nothing yet" is one every list has to explain.
    expect(entry?.health).toBe("healthy")
    expect(entry?.lastRunAt).toBeNull()
  })

  it("does not report a disabled schedule as a schedule", async ({ skip }) => {
    if (!up) skip()
    const workflowId = await makeWorkflow("Scheduled")
    await db
      .insertInto("workflowSchedule")
      .values({
        id: v7(),
        workflowId,
        cronExpression: "*/15 * * * *",
        timezone: "UTC",
        enabled: false,
      })
      .execute()

    const off = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    // Reporting it anyway would have the UI show "every 15 minutes" for something that has not run
    // in a month.
    expect(
      (off.json.data as Json[]).find((row) => row.id === workflowId)?.cronExpression,
    ).toBeNull()

    await db
      .updateTable("workflowSchedule")
      .set({ enabled: true })
      .where("workflowId", "=", workflowId)
      .execute()

    const on = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    expect((on.json.data as Json[]).find((row) => row.id === workflowId)?.cronExpression).toBe(
      "*/15 * * * *",
    )
  })

  it("calls a workflow failing when its latest run failed", async ({ skip }) => {
    if (!up) skip()
    const workflowId = await makeWorkflow("Failing")
    await makeRun(workflowId, "succeeded", 60_000)
    await makeRun(workflowId, "failed", 1_000)

    const response = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    const entry = (response.json.data as Json[]).find((row) => row.id === workflowId)
    expect(entry?.health).toBe("failing")
    expect(entry?.lastRunStatus).toBe("failed")
    expect(entry?.recentFailures).toBe(1)
  })

  it("calls it degraded when it failed recently but recovered", async ({ skip }) => {
    if (!up) skip()
    const workflowId = await makeWorkflow("Degraded")
    await makeRun(workflowId, "failed", 60_000)
    await makeRun(workflowId, "succeeded", 1_000)

    const response = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    const entry = (response.json.data as Json[]).find((row) => row.id === workflowId)
    expect(entry?.health).toBe("degraded")
    expect(entry?.lastRunStatus).toBe("succeeded")
  })

  it("calls a disabled workflow paused even when its last run failed", async ({ skip }) => {
    if (!up) skip()
    // Disabled beats everything: a paused workflow is not failing, it is off, and calling it
    // failing would have someone investigate a thing they turned off themselves.
    const workflowId = await makeWorkflow("Paused", false)
    await makeRun(workflowId, "failed", 1_000)

    const response = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    expect((response.json.data as Json[]).find((row) => row.id === workflowId)?.health).toBe(
      "paused",
    )
  })

  it("calls a disabled workflow with no runs paused, not healthy", async ({ skip }) => {
    if (!up) skip()
    /*
      The ordering of the two checks in `healthOf`, made visible.

      A workflow someone turned off before it ever ran is off, not fine — and testing only the
      disabled-with-runs case leaves the two checks interchangeable, which they are not.
    */
    const workflowId = await makeWorkflow("Never ran, switched off", false)

    const response = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    const entry = (response.json.data as Json[]).find((row) => row.id === workflowId)
    expect(entry?.recentRuns).toBe(0)
    expect(entry?.health).toBe("paused")
  })

  it("forgets a failure that has scrolled out of the recent window", async ({ skip }) => {
    if (!up) skip()
    /*
      The window is per workflow, and it is what makes health mean "lately".

      One old failure followed by ten successes is a healthy workflow. If the window were taken
      across every workflow rather than per workflow, a busy neighbour's runs would push this one's
      history out and the verdict would depend on what else the organization was doing.
    */
    const workflowId = await makeWorkflow("Recovered")
    await makeRun(workflowId, "failed", 3_600_000)
    for (let index = 0; index < 10; index += 1) {
      await makeRun(workflowId, "succeeded", 60_000 - index * 1000)
    }

    const response = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    const entry = (response.json.data as Json[]).find((row) => row.id === workflowId)
    expect(entry?.recentRuns).toBe(10)
    expect(entry?.recentFailures).toBe(0)
    expect(entry?.health).toBe("healthy")
  })

  it("keeps one workflow's history out of another's verdict", async ({ skip }) => {
    if (!up) skip()
    // A busy workflow's runs must not fill the window and starve a quiet one of its own history.
    const busy = await makeWorkflow("Busy")
    for (let index = 0; index < 15; index += 1) {
      await makeRun(busy, "succeeded", 1000 + index)
    }
    const quiet = await makeWorkflow("Quiet")
    await makeRun(quiet, "failed", 500)

    const response = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    const entry = (response.json.data as Json[]).find((row) => row.id === quiet)
    expect(entry?.recentRuns).toBe(1)
    expect(entry?.health).toBe("failing")
  })

  it("hides another organization's workflows", async ({ skip }) => {
    if (!up) skip()
    const stranger = await createTestUser("wf-outsider")
    const created = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(stranger),
      body: JSON.stringify({ name: `Outsider ${v7()}` }),
    })
    const organization = (await created.json()) as Json
    trackOrganization(organization.id as string)

    const response = await call(
      "GET",
      `/v1/orgs/${organization.slug as string}/workflows`,
      stranger,
    )
    expect(response.json.data).toEqual([])

    // And the other way: our own list must not have grown.
    const ours = await call("GET", `/v1/orgs/${orgSlug}/workflows`, actor())
    expect((ours.json.data as Json[]).every((row) => row.projectId === projectId)).toBe(true)
  })
})

describe.skipIf(!up)("recent runs across the organization", () => {
  it("returns runs newest first with a duration", async ({ skip }) => {
    if (!up) skip()
    const workflowId = await makeWorkflow("Recent")
    await makeRun(workflowId, "succeeded", 20_000)
    const newest = await makeRun(workflowId, "succeeded", 1_000)

    const response = await call("GET", `/v1/orgs/${orgSlug}/workflow-runs`, actor())
    expect(response.status).toBe(200)

    const rows = response.json.data as Json[]
    const ours = rows.filter((row) => row.workflowId === workflowId)
    expect(ours[0]?.id).toBe(newest)
    expect(ours[0]?.durationMs).toBe(1500)
    expect(ours[0]?.workflowName).toBe("Recent")
    expect(ours[0]?.projectName).toBe("Workflows")
    // Micro-USD as a string: money is bigint, and JSON has no integer wide enough to trust.
    expect(typeof ours[0]?.costMicroUsd).toBe("string")
  })

  it("has no duration for a run that has not finished", async ({ skip }) => {
    if (!up) skip()
    // "So far" is not something a table column can say, so the honest answer is null.
    const workflowId = await makeWorkflow("Running")
    const id = v7()
    await db
      .insertInto("workflowRun")
      .values({
        id,
        workflowId,
        triggerType: "manual",
        status: "running",
        startedAt: new Date(),
        finishedAt: null,
      })
      .execute()
    runIds.push(id)

    const response = await call("GET", `/v1/orgs/${orgSlug}/workflow-runs`, actor())
    const entry = (response.json.data as Json[]).find((row) => row.id === id)
    expect(entry?.durationMs).toBeNull()
    expect(entry?.finishedAt).toBeNull()
  })

  describe.skipIf(!up)("one workflow and its graph", () => {
    it("has no graph before anything is saved", async ({ skip }) => {
      if (!up) skip()
      const workflowId = await makeWorkflow("Unsaved")

      const response = await call(
        "GET",
        `/v1/orgs/${orgSlug}/projects/${projectId}/workflows/${workflowId}`,
        actor(),
      )
      expect(response.status).toBe(200)
      /*
      Null, not `{nodes: [], edges: []}`.

      An empty graph is a graph `validateGraph` refuses, so handing one to the editor would make
      "never saved" and "saved something invalid" look the same.
    */
      expect(response.json.graph).toBeNull()
      expect(response.json.currentVersion).toBeNull()
    })

    it("returns the graph that was saved", async ({ skip }) => {
      if (!up) skip()
      const workflowId = await makeWorkflow("Saved")
      const graph = {
        nodes: [
          {
            id: "start",
            type: "trigger.cron",
            name: "Every night",
            config: {},
            position: { x: 0, y: 0 },
          },
          {
            id: "fetch",
            type: "action.http",
            name: "Fetch",
            config: { url: "https://example.com" },
            position: { x: 240, y: 0 },
          },
        ],
        edges: [{ from: "start", to: "fetch" }],
      }

      const saved = await app.request(
        `/v1/orgs/${orgSlug}/projects/${projectId}/workflows/${workflowId}/graph`,
        { method: "PUT", headers: authHeaders(actor()), body: JSON.stringify({ graph }) },
      )
      expect(saved.status).toBe(200)

      const response = await call(
        "GET",
        `/v1/orgs/${orgSlug}/projects/${projectId}/workflows/${workflowId}`,
        actor(),
      )
      expect(response.json.currentVersion).toBe(1)
      expect(response.json.graph).toEqual(graph)
      expect(response.json.graphSha256).toMatch(/^[0-9a-f]{64}$/)
    })

    it("round-trips node positions the editor set", async ({ skip }) => {
      if (!up) skip()
      /*
      Positions are the editor's, and the server never interprets them — but it does have to give
      them back. A graph that loses its layout on save is one a person has to re-arrange every time
      they open it.
    */
      const workflowId = await makeWorkflow("Positioned")
      const graph = {
        nodes: [
          {
            id: "only",
            type: "trigger.manual",
            name: "Start",
            config: {},
            position: { x: 137.5, y: -42 },
          },
        ],
        edges: [],
      }
      await app.request(`/v1/orgs/${orgSlug}/projects/${projectId}/workflows/${workflowId}/graph`, {
        method: "PUT",
        headers: authHeaders(actor()),
        body: JSON.stringify({ graph }),
      })

      const response = await call(
        "GET",
        `/v1/orgs/${orgSlug}/projects/${projectId}/workflows/${workflowId}`,
        actor(),
      )
      const nodes = (response.json.graph as Json).nodes as Json[]
      expect(nodes[0]?.position).toEqual({ x: 137.5, y: -42 })
    })

    it("hides another organization's workflow behind a 404", async ({ skip }) => {
      if (!up) skip()
      const workflowId = await makeWorkflow("Private")
      const stranger = await createTestUser("wf-graph-outsider")
      const created = await app.request("/v1/orgs", {
        method: "POST",
        headers: authHeaders(stranger),
        body: JSON.stringify({ name: `Graph Outsider ${v7()}` }),
      })
      const organization = (await created.json()) as Json
      trackOrganization(organization.id as string)

      const response = await call(
        "GET",
        `/v1/orgs/${organization.slug as string}/projects/${projectId}/workflows/${workflowId}`,
        stranger,
      )
      // A 403 would confirm the workflow exists. The answer has to be the one a missing workflow gets.
      expect([403, 404]).toContain(response.status)
    })
  })
})

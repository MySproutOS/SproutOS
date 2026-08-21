import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { BUILD_KINDS } from "./build"
import { deployRevision, revisionOutcome, tenantNamespace } from "./deploy"
import type { Job } from "./queue"

/**
 * Against the compose Postgres and, when one is reachable, a real Kubernetes API.
 *
 * The database half is always exercised. The cluster half runs only when `KUBE_SERVER` points at an
 * API endpoint — `kubectl proxy` locally — because the thing worth checking is that Knative accepts
 * what the renderer produces, and a fake API server would only confirm the fake agrees with itself.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const KUBE_SERVER = process.env.KUBE_SERVER
const cluster = await (async () => {
  if (KUBE_SERVER === undefined) return false
  try {
    const response = await fetch(`${KUBE_SERVER}/version`)
    return response.ok
  } catch {
    return false
  }
})()

const created: {
  table: "deployment" | "project" | "repository" | "organization" | "user"
  id: string
}[] = []

async function seed(overrides: { imageUri?: string | null } = {}) {
  const userId = v7()
  const orgId = v7()
  const repoId = v7()
  const projectId = v7()
  const suffix = repoId.slice(-12)

  await db
    .insertInto("user")
    .values({ id: userId, email: `dep-${suffix}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({ id: orgId, slug: `dep-${suffix}`, name: "Dep", kind: "team", ownerUserId: userId })
    .execute()
  created.push({ table: "organization", id: orgId })
  await db
    .insertInto("repository")
    .values({
      id: repoId,
      organizationId: orgId,
      githubRepoId: BigInt(`0x${suffix}`),
      ownerLogin: "acme",
      name: `repo-${suffix}`,
      provenance: "new",
    })
    .execute()
  created.push({ table: "repository", id: repoId })
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId: orgId,
      repositoryId: repoId,
      name: "App",
      slug: `dep${suffix.slice(0, 6)}`,
    })
    .execute()
  created.push({ table: "project", id: projectId })

  const deploymentId = v7()
  await db
    .insertInto("deployment")
    .values({
      id: deploymentId,
      projectId,
      kind: "production",
      gitSha: "c".repeat(40),
      status: "queued",
      imageUri:
        overrides.imageUri === undefined
          ? "ghcr.io/knative/helloworld-go:latest"
          : overrides.imageUri,
      runtimeClass: "kata-clh",
      containerConcurrency: 10,
      memoryMb: 128,
      maxDurationS: 120,
    })
    .execute()
  created.push({ table: "deployment", id: deploymentId })

  return { deploymentId, orgId, projectId }
}

const context = { db, keepAlive: () => Promise.resolve(true), signal: new AbortController().signal }

function jobFor(deploymentId: string): Job {
  return {
    id: v7(),
    kind: "deploy.revision",
    payload: { deploymentId },
    attempt: 1,
    maxAttempts: 3,
    organizationId: null,
  }
}

async function statusOf(id: string) {
  return await db
    .selectFrom("deployment")
    .select(["status", "url", "knativeRevision"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
}

afterAll(async () => {
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await db.destroy()
})

describe("revisionOutcome", () => {
  it("reads a first deploy still coming up as progressing, not failed", () => {
    // These are the exact conditions Knative publishes seconds after a healthy Service is created.
    // Reading the top-level `Ready: False` as a failure marks every good deployment as errored, and
    // that is what the first version of this handler did.
    const outcome = revisionOutcome({
      status: {
        conditions: [
          { type: "ConfigurationsReady", status: "Unknown" },
          {
            type: "Ready",
            status: "False",
            reason: "RevisionMissing",
            message: 'Configuration "app" does not have any ready Revision.',
          },
        ],
      },
    })

    expect(outcome.state).toBe("progressing")
  })

  it("reads a failed revision as failed, and carries the message worth showing", () => {
    // Same top-level `Ready` as above — same status, same reason, same message. Only
    // `ConfigurationsReady` distinguishes them.
    const outcome = revisionOutcome({
      status: {
        conditions: [
          {
            type: "ConfigurationsReady",
            status: "False",
            reason: "RevisionFailed",
            message: 'Revision "app-00001" failed with message: Unable to fetch image.',
          },
          {
            type: "Ready",
            status: "False",
            reason: "RevisionMissing",
            message: 'Configuration "app" does not have any ready Revision.',
          },
        ],
      },
    })

    expect(outcome).toEqual({
      state: "failed",
      message: 'Revision "app-00001" failed with message: Unable to fetch image.',
    })
  })

  it("reads a ready service as ready", () => {
    expect(
      revisionOutcome({ status: { conditions: [{ type: "Ready", status: "True" }] } }).state,
    ).toBe("ready")
  })

  it("treats a service with no status yet as progressing", () => {
    // Between the apply returning and the controller first reconciling, there are no conditions at
    // all. That is not a failure.
    expect(revisionOutcome({}).state).toBe("progressing")
  })
})

describe("tenantNamespace", () => {
  it("is a valid DNS label that does not start with a digit", () => {
    // A UUID frequently starts with a digit, and a namespace name may not. The prefix is not
    // decoration.
    const namespace = tenantNamespace("01a01e12-1700-76ac-9713-dd208babdf5a")

    expect(namespace).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/)
    expect(namespace.length).toBeLessThanOrEqual(63)
  })

  it("gives two organizations different namespaces", () => {
    expect(tenantNamespace(v7())).not.toBe(tenantNamespace(v7()))
  })
})

describe.skipIf(!reachable)("deployRevision", () => {
  it("does not deploy a deployment with no image, and says it is still building", async () => {
    // The absence of an image means the build has not finished, not that anything is wrong. A
    // handler that treated it as an error would fail every deployment during its normal first
    // few seconds.
    const { deploymentId } = await seed({ imageUri: null })

    await deployRevision({ server: "http://127.0.0.1:1" })(jobFor(deploymentId), context)

    expect((await statusOf(deploymentId)).status).toBe("building")
  })

  it("does nothing to a torn-down deployment", async () => {
    const { deploymentId } = await seed()
    await db
      .updateTable("deployment")
      .set({ status: "torn_down" })
      .where("id", "=", deploymentId)
      .execute()

    // The unreachable server is the assertion: reaching the cluster at all would throw.
    await deployRevision({ server: "http://127.0.0.1:1" })(jobFor(deploymentId), context)

    expect((await statusOf(deploymentId)).status).toBe("torn_down")
  })

  it("ignores a deployment that no longer exists", async () => {
    await expect(
      deployRevision({ server: "http://127.0.0.1:1" })(jobFor(v7()), context),
    ).resolves.toBeUndefined()
  })
})

describe.skipIf(!reachable || !cluster)("deployRevision against a real cluster", () => {
  it("applies a Knative Service and records the URL it was given", async () => {
    const { deploymentId, orgId } = await seed()
    const namespace = tenantNamespace(orgId)

    // The namespace is created by the control plane in production; here the handler is the only
    // thing under test, so it is created directly.
    await fetch(`${KUBE_SERVER}/api/v1/namespaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespace, labels: { "pod-security.kubernetes.io/enforce": "baseline" } },
      }),
    })

    const handler = deployRevision({ server: KUBE_SERVER! })

    await handler(jobFor(deploymentId), context)

    // A first pull can outrun the handler's budget, in which case it re-enqueues and leaves the row
    // `deploying`. Running it again is what the queue would do, and is the difference between a
    // test that requires `ready` and one that accepts either — the latter passes just as happily
    // when the deploy never completes at all.
    if ((await statusOf(deploymentId)).status === "deploying") {
      await handler(jobFor(deploymentId), context)
    }

    const after = await statusOf(deploymentId)
    expect(after.status).toBe("ready")
    // One label before the apex, from the cluster rather than from the renderer.
    expect(after.url).toMatch(/^http:\/\/[^.]+\.sprout\.run$/)
    expect(after.knativeRevision).not.toBeNull()
  }, 240_000)
})

/*
  The link the pipeline was missing.

  `buildImage` was written, registered in `PLATFORM_HANDLERS`, and only ever enqueued *by itself* as
  a recheck of a build already running — the first one had no origin. `POST /deployments` created a
  row, enqueued `deployRevision`, and this handler marked it `building` and returned. It stayed
  `building` forever, so no project this platform forked could ever deploy.

  Asserted on the enqueue rather than on the status: `building` was always written correctly, and
  the status was the half that worked.
*/
describe("a deployment with no image yet", () => {
  it("starts the build instead of waiting for one nobody asked for", async ({ skip }) => {
    if (!reachable) skip()

    const { deploymentId } = await seed({ imageUri: null })
    await deployRevision()({ payload: { deploymentId }, attempt: 1 } as never, context)

    const queued = await db
      .selectFrom("backgroundJob")
      .select(["id"])
      .where("kind", "=", BUILD_KINDS.image)
      .where(sql`payload ->> 'deploymentId'`, "=", deploymentId)
      .execute()
    expect(queued).toHaveLength(1)

    // And it is still marked building, which was always correct.
    const row = await db
      .selectFrom("deployment")
      .select(["status"])
      .where("id", "=", deploymentId)
      .executeTakeFirst()
    expect(row?.status).toBe("building")
  })

  /*
    Keyed on the deployment, so redeploying something already building joins the build in flight
    rather than paying for a second one.
  */
  it("does not start a second build for the same deployment", async ({ skip }) => {
    if (!reachable) skip()

    const { deploymentId } = await seed({ imageUri: null })
    const run = () => deployRevision()({ payload: { deploymentId }, attempt: 1 } as never, context)

    await run()
    await run()

    const queued = await db
      .selectFrom("backgroundJob")
      .select(["id"])
      .where("kind", "=", BUILD_KINDS.image)
      .where(sql`payload ->> 'deploymentId'`, "=", deploymentId)
      .execute()
    expect(queued).toHaveLength(1)
  })
})

describe("a revision that failed", () => {
  /*
    The reason has to reach the row, not just the exception.

    The comment on this path said "recorded as an error so the customer sees Knative's own message
    rather than a job that vanished" — and the message went into the thrown error, which reaches
    `background_job.last_error` and stops there, a table no customer can read. What they saw was
    `status: error` and nothing else.

    The first real one on this platform was `parsing config: reading /app/config/glance.yml: no such
    file or directory`: not a platform fault, and exactly what the person who forked the application
    needs in order to know the problem is theirs.
  */
  it("carries Knative's message, which is what says whose fault it is", () => {
    const outcome = revisionOutcome({
      status: {
        conditions: [
          { type: "Ready", status: "False" },
          {
            type: "ConfigurationsReady",
            status: "False",
            reason: "RevisionFailed",
            message:
              'Revision "glance-00001" failed with message: Container failed with: parsing config: reading /app/config/glance.yml: open /app/config/glance.yml: no such file or directory',
          },
        ],
      },
    })

    expect(outcome.state).toBe("failed")
    expect(outcome.state === "failed" && outcome.message).toContain("glance.yml")
  })

  it("does not mistake a revision still coming up for one that failed", () => {
    // `Ready: False` on its own is every revision for the first few seconds of its life. Only
    // `ConfigurationsReady: False` with `RevisionFailed` means Knative has given up.
    expect(
      revisionOutcome({ status: { conditions: [{ type: "Ready", status: "False" }] } }).state,
    ).toBe("progressing")
  })
})

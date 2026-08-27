import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  CLAIM_TIMEOUT_MS,
  claimSigningJob,
  completeSigning,
  enqueueSigning,
  failSigning,
} from "./apk-signing"

/**
 * Against the compose Postgres, because every property worth asserting here is a property of a
 * conditional `UPDATE` running concurrently. A fake queue would only confirm the fake agrees with
 * itself; the question is whether Postgres lets two claims of one row both succeed.
 */
/*
  Resolved at module scope. `describe.runIf` is evaluated at collection time, before any hook runs,
  so a flag set in `beforeAll` is still `false` when the decision is made and the suite skips
  green and silent. This repository has written that finding twice.
*/
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created: {
  table: "deployment" | "project" | "repository" | "organization" | "user"
  id: string
}[] = []

const projects: string[] = []

async function seed(): Promise<{ projectId: string; deploymentId: string }> {
  const userId = v7()
  const orgId = v7()
  const repoId = v7()
  const projectId = v7()
  const deploymentId = v7()
  const suffix = repoId.slice(-12)

  await db
    .insertInto("user")
    .values({ id: userId, email: `apk-${suffix}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({ id: orgId, slug: `apk-${suffix}`, name: "Apk", kind: "team", ownerUserId: userId })
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
      slug: `apk${suffix.slice(0, 6)}`,
    })
    .execute()
  created.push({ table: "project", id: projectId })
  projects.push(projectId)
  await db
    .insertInto("deployment")
    .values({ id: deploymentId, projectId, kind: "production", gitSha: "d".repeat(40) })
    .execute()
  created.push({ table: "deployment", id: deploymentId })

  return { projectId, deploymentId }
}

/*
  The queue is global — `claimSigningJob` takes the oldest claimable row in the table, not the
  oldest belonging to the caller. So a test that abandons a claim leaves a candidate that the next
  test's signer picks up instead of its own, and the assertion fails against a job it never made.
  Clearing between tests is the isolation; scoping the claim would be testing a different function.
*/
beforeEach(async () => {
  if (!reachable || projects.length === 0) return
  await db.deleteFrom("apkSigningJob").where("projectId", "in", projects).execute()
})

async function queue(): Promise<{ jobId: string; projectId: string; deploymentId: string }> {
  const { projectId, deploymentId } = await seed()
  const jobId = await enqueueSigning(db, {
    deploymentId,
    projectId,
    unsignedKey: `builds/${deploymentId}/app-unsigned.apk`,
    unsignedDigest: "a".repeat(64),
  })
  return { jobId, projectId, deploymentId }
}

function statusOf(jobId: string) {
  return db
    .selectFrom("apkSigningJob")
    .select(["status", "attempts", "claimedBy", "signedKey"])
    .where("id", "=", jobId)
    .executeTakeFirstOrThrow()
}

afterAll(async () => {
  if (!reachable) return

  if (projects.length > 0) {
    await db.deleteFrom("apkSigningJob").where("projectId", "in", projects).execute()
  }
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await db.destroy()
})

describe.runIf(reachable)("the APK signing queue", () => {
  it("hands one job to exactly one of two signers polling together", async () => {
    const { jobId } = await queue()

    // Both claims issued before either is awaited: the interleaving is Postgres's to choose, which
    // is the point. A sequential pair would pass even if the update had no condition on it.
    const [first, second] = await Promise.all([
      claimSigningJob(db, "signer-a"),
      claimSigningJob(db, "signer-b"),
    ])

    const winners = [
      { claim: first, signerId: "signer-a" },
      { claim: second, signerId: "signer-b" },
    ].filter(({ claim }) => claim?.id === jobId)
    expect(winners).toHaveLength(1)
    expect(winners[0]?.claim?.unsignedDigest).toBe("a".repeat(64))
    // A successful response and the durable holder must name the same winner. The old scalar
    // subquery let both requests return the job even though the second update replaced the first.
    expect((await statusOf(jobId)).claimedBy).toBe(winners[0]?.signerId)
  })

  it("offers the job again once a claim has gone stale", async () => {
    const { jobId } = await queue()

    const held = await claimSigningJob(db, "signer-dead")
    expect(held?.id).toBe(jobId)

    // Nothing is offered while the claim is fresh.
    expect(await claimSigningJob(db, "signer-live")).toBeUndefined()

    const later = () => new Date(Date.now() + CLAIM_TIMEOUT_MS + 1_000)
    const reclaimed = await claimSigningJob(db, "signer-live", later)
    expect(reclaimed?.id).toBe(jobId)
    expect((await statusOf(jobId)).claimedBy).toBe("signer-live")
  })

  it("refuses a completion from a signer that no longer holds the claim", async () => {
    const { jobId } = await queue()

    await claimSigningJob(db, "signer-dead")
    const later = () => new Date(Date.now() + CLAIM_TIMEOUT_MS + 1_000)
    await claimSigningJob(db, "signer-live", later)

    // The evicted signer finishes its upload late. Accepting it would replace the artifact the
    // current holder is about to produce, and the store would serve whichever landed last.
    const stale = await completeSigning(db, {
      jobId,
      signerId: "signer-dead",
      signedKey: "signed/stale.apk",
      signedDigest: "b".repeat(64),
    })
    expect(stale).toBe(false)

    const accepted = await completeSigning(db, {
      jobId,
      signerId: "signer-live",
      signedKey: "signed/good.apk",
      signedDigest: "c".repeat(64),
    })
    expect(accepted).toBe(true)

    const row = await statusOf(jobId)
    expect(row.status).toBe("signed")
    expect(row.signedKey).toBe("signed/good.apk")
  })

  it("retries a failure and gives up after enough of them", async () => {
    const { jobId } = await queue()

    for (const attempt of [1, 2]) {
      await claimSigningJob(db, "signer-a")
      await failSigning(db, { jobId, signerId: "signer-a", error: "apksigner exited 1" })
      const row = await statusOf(jobId)
      expect(row.attempts).toBe(attempt)
      // Back in the queue: a signing failure is usually the signer restarting mid-job.
      expect(row.status).toBe("pending")
    }

    await claimSigningJob(db, "signer-a")
    await failSigning(db, { jobId, signerId: "signer-a", error: "apksigner exited 1" })
    const row = await statusOf(jobId)
    expect(row.attempts).toBe(3)
    expect(row.status).toBe("failed")
    expect(row.claimedBy).toBeNull()

    // A failed job is not offered again — three signers in a row is a broken artifact, not luck.
    expect(await claimSigningJob(db, "signer-b")).toBeUndefined()
  })

  it("does not queue a second job for a re-released deployment", async () => {
    const { jobId, projectId, deploymentId } = await queue()

    const again = await enqueueSigning(db, {
      deploymentId,
      projectId,
      unsignedKey: "builds/other/app-unsigned.apk",
      unsignedDigest: "e".repeat(64),
    })
    // The id of the job that exists, not the one the second call generated and discarded.
    expect(again).toBe(jobId)

    const rows = await db
      .selectFrom("apkSigningJob")
      .select(["id", "unsignedKey"])
      .where("deploymentId", "=", deploymentId)
      .execute()

    expect(rows).toHaveLength(1)
    // The original key survives: a re-release must not repoint a claimed job at a different
    // artifact under the signer's feet.
    expect(rows[0]?.unsignedKey).toBe(`builds/${deploymentId}/app-unsigned.apk`)
  })
})

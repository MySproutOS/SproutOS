import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

/**
 * The queue an on-premises signer polls.
 *
 * **The platform does not hold the Android signing key.** A dedicated machine on somebody's
 * premises does: it polls for work, downloads the unsigned APK, signs it, and uploads the result.
 * The key never reaches AWS, a CI runner, or this repository.
 *
 * That matters more here than it would elsewhere. SproutOS is developer of record for every app it
 * publishes, so its signing key is the identity of every customer app at once — a key on a machine
 * that also serves public HTTP has an enormous attack surface for what it protects.
 *
 * The signer is behind a firewall: it can reach out, nothing can reach in. So the platform cannot
 * push and the signer polls, which also means the signer can be offline for a day without anything
 * being lost.
 */

/**
 * How long a claim is honoured before the job is offered again.
 *
 * A signer that dies holding a claim must not block the queue forever, and signing an APK is
 * seconds of work — so this is generous by two orders of magnitude and still short enough that a
 * crashed signer costs one poll interval rather than an afternoon.
 */
export const CLAIM_TIMEOUT_MS = 10 * 60 * 1000

export type SigningJob = {
  id: string
  deploymentId: string
  projectId: string
  unsignedKey: string
  unsignedDigest: string
}

/** Queue an APK for signing. One job per deployment — the unique constraint says so. */
export async function enqueueSigning(
  db: Kysely<DB>,
  input: {
    deploymentId: string
    projectId: string
    unsignedKey: string
    unsignedDigest: string
  },
): Promise<string> {
  const id = v7()
  await db
    .insertInto("apkSigningJob")
    .values({
      id,
      deploymentId: input.deploymentId,
      projectId: input.projectId,
      unsignedKey: input.unsignedKey,
      unsignedDigest: input.unsignedDigest,
      status: "pending",
    })
    // Re-releasing the same deployment is not an error and must not create a second job: two
    // signers each producing a signed artifact for one release means whichever uploads last wins,
    // silently.
    .onConflict((oc) => oc.column("deploymentId").doNothing())
    .execute()

  // Read the id back rather than returning the one we generated. `doNothing` writes no row and
  // returns none, so on the second call `id` is a UUID that exists nowhere — a caller storing it
  // against the release would hold a reference to a job that was never created.
  const job = await db
    .selectFrom("apkSigningJob")
    .select("id")
    .where("deploymentId", "=", input.deploymentId)
    .executeTakeFirstOrThrow()

  return job.id
}

/**
 * Claim the oldest pending job, if there is one.
 *
 * The row is selected and locked inside the same statement that records the claim. `SKIP LOCKED`
 * lets another signer move to the next job instead of waiting, while the timeout makes a claim held
 * by a dead signer eligible again.
 */
export async function claimSigningJob(
  db: Kysely<DB>,
  signerId: string,
  now: () => Date = () => new Date(),
): Promise<SigningJob | undefined> {
  const claimedAt = now()
  const staleBefore = new Date(claimedAt.getTime() - CLAIM_TIMEOUT_MS)

  const claimed = await db
    .with("candidate", (qb) =>
      qb
        .selectFrom("apkSigningJob")
        .select("id")
        .where((eb) =>
          eb.or([
            eb("status", "=", "pending"),
            // A claim that has gone stale is available again. Without this a signer that crashed
            // mid-job takes that release out of the queue permanently.
            eb.and([eb("status", "=", "claimed"), eb("claimedAt", "<", staleBefore)]),
          ]),
        )
        .orderBy("createdAt", "asc")
        .limit(1)
        .forUpdate()
        .skipLocked(),
    )
    .updateTable("apkSigningJob")
    .from("candidate")
    .set({ status: "claimed", claimedBy: signerId, claimedAt, updatedAt: claimedAt })
    .whereRef("apkSigningJob.id", "=", "candidate.id")
    .returning([
      "apkSigningJob.id as id",
      "apkSigningJob.deploymentId as deploymentId",
      "apkSigningJob.projectId as projectId",
      "apkSigningJob.unsignedKey as unsignedKey",
      "apkSigningJob.unsignedDigest as unsignedDigest",
    ])
    .executeTakeFirst()

  return claimed
}

/** Record a signed artifact against the job that produced it. */
export async function completeSigning(
  db: Kysely<DB>,
  input: { jobId: string; signerId: string; signedKey: string; signedDigest: string },
): Promise<boolean> {
  const updated = await db
    .updateTable("apkSigningJob")
    .set({
      status: "signed",
      signedKey: input.signedKey,
      signedDigest: input.signedDigest,
      signedAt: new Date(),
      updatedAt: new Date(),
    })
    .where("id", "=", input.jobId)
    // Only the signer holding the claim may complete it. Otherwise a signer whose claim expired
    // mid-upload could overwrite the artifact a second signer has already produced.
    .where("claimedBy", "=", input.signerId)
    .where("status", "=", "claimed")
    .returning("id")
    .executeTakeFirst()

  return updated !== undefined
}

/** Report a failure and put the job back, or give up after enough attempts. */
export async function failSigning(
  db: Kysely<DB>,
  input: { jobId: string; signerId: string; error: string; maxAttempts?: number },
): Promise<void> {
  const maxAttempts = input.maxAttempts ?? 3

  const job = await db
    .selectFrom("apkSigningJob")
    .select(["attempts"])
    .where("id", "=", input.jobId)
    .executeTakeFirst()

  const attempts = (job?.attempts ?? 0) + 1

  await db
    .updateTable("apkSigningJob")
    .set({
      // Back to pending until it has failed enough times to be somebody's problem rather than a
      // retry. A signing failure is usually a transient one — the signer restarting mid-job.
      status: attempts >= maxAttempts ? "failed" : "pending",
      attempts,
      lastError: input.error.slice(0, 2000),
      claimedBy: null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where("id", "=", input.jobId)
    .where("claimedBy", "=", input.signerId)
    .execute()
}

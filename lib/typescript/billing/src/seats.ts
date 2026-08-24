import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

/**
 * The team fee (§2).
 *
 * > "$4 flat fee for team pricing, but it only kicks in if more than 2 users… is committing to the
 * > repository. You would block launching a project otherwise."
 *
 * Three separate things, and keeping them separate is most of the design:
 *
 * 1. **Counting** who has committed, from the push webhooks the platform already receives.
 * 2. **Deciding** whether a fee is due, which is a pure function of that count and one flag.
 * 3. **Blocking a launch** when it is due and unpaid — a *launch*, not a running deployment.
 */

/** Micro-USD per month once a private repository is over the threshold. */
export const TEAM_FEE_MICRO_USD = 4_000_000n

/**
 * More than two. Not "at least two".
 *
 * The requirement says "more than 2 users", so a pair working together is free and the third
 * committer is what starts the charge. Off by one here is a customer charged for a collaboration
 * they were told was included.
 */
export const FREE_COMMITTERS = 2

/**
 * Names that are automation, not people.
 *
 * Matched on the `[bot]` suffix GitHub appends to every App identity, plus the handful that predate
 * it. Charging a customer a team fee because Dependabot opened a pull request would be indefensible
 * and is exactly what a naive distinct-author count does.
 */
export function isBot(login: string | null, email: string | null): boolean {
  const name = (login ?? "").toLowerCase()
  if (name.endsWith("[bot]")) return true
  if (["dependabot", "renovate", "github-actions", "sproutos-agent"].includes(name)) return true

  const address = (email ?? "").toLowerCase()
  return address.endsWith("@users.noreply.github.com") && address.includes("[bot]")
}

/**
 * What the count keys on.
 *
 * The login where GitHub resolved one, the email otherwise. Neither alone is enough: an author
 * email is whatever the committer configured locally, so counting on it charges for one person with
 * two machines; the login is authoritative but absent when GitHub cannot match the email to an
 * account, so counting on it undercounts.
 */
export function identityOf(login: string | null, email: string | null): string | undefined {
  const resolved = (login ?? "").trim().toLowerCase()
  if (resolved !== "") return resolved

  const address = (email ?? "").trim().toLowerCase()
  return address === "" ? undefined : address
}

export type Committer = { login: string | null; email: string | null }

/** Record everyone who appeared in a push. Idempotent: a redelivered webhook changes nothing. */
export async function recordCommitters(
  db: Kysely<DB>,
  repositoryId: string,
  committers: Committer[],
  now: Date = new Date(),
): Promise<void> {
  for (const committer of committers) {
    const identity = identityOf(committer.login, committer.email)
    if (identity === undefined) continue

    await db
      .insertInto("repositoryCommitter")
      .values({
        id: v7(),
        repositoryId,
        login: committer.login,
        email: committer.email,
        identity,
        isBot: isBot(committer.login, committer.email),
        firstSeenAt: now,
        lastSeenAt: now,
      })
      /*
        Seen again, not seen anew.

        `first_seen_at` is left alone deliberately — it is the evidence for when a customer's team
        grew, which is the question a disputed fee turns on.
      */
      .onConflict((oc) => oc.columns(["repositoryId", "identity"]).doUpdateSet({ lastSeenAt: now }))
      .execute()
  }
}

export type SeatDecision = {
  billable: boolean
  committers: number
  reason: string
}

/**
 * Whether an organization owes the team fee.
 *
 * Per **organization**, not per repository. "Flat $4 fee for team pricing" reads per-organization
 * and "more than 2 users committing to the repository" reads per-repository; charging per
 * repository would multiply a flat fee by how many repositories a team happens to split their work
 * across, which is not what "flat" means.
 *
 * Public repositories are exempt. The requirement says "private repository", and it is the same
 * shape as every other platform: open source does not pay for seats.
 */
export async function decideSeats(
  db: Kysely<DB>,
  organizationId: string,
  since: Date,
): Promise<SeatDecision> {
  const rows = await db
    .selectFrom("repositoryCommitter")
    .innerJoin("repository", "repository.id", "repositoryCommitter.repositoryId")
    .select("repositoryCommitter.identity")
    .where("repository.organizationId", "=", organizationId)
    .where("repository.deletedAt", "is", null)
    // Private only.
    .where("repository.private", "=", true)
    .where("repositoryCommitter.isBot", "=", false)
    .where("repositoryCommitter.lastSeenAt", ">=", since)
    .distinct()
    .execute()

  const committers = rows.length

  if (committers === 0) {
    return { billable: false, committers, reason: "no private repository has been committed to" }
  }
  if (committers <= FREE_COMMITTERS) {
    return {
      billable: false,
      committers,
      reason: `${committers} committer(s), and the fee starts above ${FREE_COMMITTERS}`,
    }
  }

  return {
    billable: true,
    committers,
    reason: `${committers} people have committed to a private repository this period`,
  }
}

/**
 * Whether a project may be launched.
 *
 * **A launch, not a running deployment.** The requirement is to block launching; pulling a live
 * site down over an unpaid seat fee is a different and much larger decision, and it is not what was
 * asked for. A customer whose team grew mid-month keeps serving and cannot deploy again until they
 * settle — which is visible, recoverable, and does not take their users offline.
 */
export function mayLaunch(
  decision: SeatDecision,
  feePaid: boolean,
): { allowed: boolean; reason?: string } {
  if (!decision.billable || feePaid) return { allowed: true }

  return {
    allowed: false,
    reason:
      `This organization has ${decision.committers} people committing to private repositories, ` +
      `which is above the ${FREE_COMMITTERS} included. Add the team plan to launch new projects. ` +
      `Anything already running keeps running.`,
  }
}

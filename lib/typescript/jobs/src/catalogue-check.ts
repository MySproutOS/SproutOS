import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { sql } from "kysely"
import { verifyDeploymentMirror } from "@lib/github"
import type { JobHandler } from "./worker"

/**
 * Build every published listing, and unpublish the ones that cannot be built.
 *
 * The store's promise is that a listed application deploys. Nothing checked it, and the catalogue
 * quietly failed that promise in three different ways in one afternoon:
 *
 * - four of six listings pointed at repositories whose Dockerfile is not at the root, so the fork
 *   succeeded and the build died on `failed to read dockerfile`;
 * - one pointed at a framework's monorepo and called it a blog starter;
 * - one pointed at a Dockerfile that is real and is a *release* Dockerfile — `COPY dist/shiori…`,
 *   which expects a binary a goreleaser pipeline put there and which no fork of the source has.
 *
 * Every one was found by a customer-shaped action failing, and every one was invisible to
 * inspection: the repository exists, the path exists, the file is a valid Dockerfile.
 *
 * So the catalogue is verified the only way it can honestly be verified — by building it, with the
 * same pipeline a customer's fork uses. A listing that cannot be built is moved to `archived`,
 * where it stays visible to a moderator and is no longer forkable.
 *
 * **Nothing is deleted and nothing is auto-republished.** A listing that starts building again is
 * a decision for whoever curates the store: an upstream that broke its Dockerfile for a week and
 * fixed it should not silently reappear, because the customers who forked it in between still have
 * a repository that does not build.
 */
export const CATALOGUE_CHECK_KIND = "store.verify_catalogue"

/** From `store_listing_status_check`. Not "withdrawn", which is the natural word and is not in it. */
const LISTING_ARCHIVED = "archived"

/** How long a listing may go unverified before it is checked again. */
export const RECHECK_AFTER_DAYS = 7

/** How many to check per run. The whole catalogue in one job would be an hour of billed compute. */
export const BATCH_SIZE = 3

export type CatalogueCheckResult = {
  checked: number
  archived: string[]
}

/**
 * The listings due for a check, oldest first.
 *
 * `last_verified_at is null` first, so a newly added listing is checked before an old one is
 * re-checked — a listing nobody has ever built is the one most likely to be wrong.
 */
export async function listingsDueForCheck(
  db: Kysely<DB>,
  limit: number = BATCH_SIZE,
  at: Date = new Date(),
): Promise<
  {
    id: string
    slug: string
    upstreamOwner: string
    upstreamRepo: string
    deploymentSourceOwner: string | null
    deploymentSourceRepo: string | null
    defaultBranch: string
    rootDir: string
    dockerfilePath: string
  }[]
> {
  const cutoff = new Date(at.getTime() - RECHECK_AFTER_DAYS * 24 * 60 * 60 * 1000)

  return await db
    .selectFrom("storeListing")
    .select([
      "id",
      "slug",
      "upstreamOwner",
      "upstreamRepo",
      "deploymentSourceOwner",
      "deploymentSourceRepo",
      "defaultBranch",
      "rootDir",
      "dockerfilePath",
    ])
    .where("status", "=", "published")
    .where("deletedAt", "is", null)
    .where((eb) => eb.or([eb("lastVerifiedAt", "is", null), eb("lastVerifiedAt", "<", cutoff)]))
    .orderBy(sql`last_verified_at asc nulls first`)
    .limit(limit)
    .execute()
}

/**
 * Record the outcome of one listing's check.
 *
 * `last_verified_at` moves whether the build passed or failed, because it is "when we last looked",
 * not "when it last worked". Leaving it unset on failure would make a permanently broken listing
 * the only thing this job ever checks.
 */
export async function recordVerification(
  db: Kysely<DB>,
  listingId: string,
  outcome: { ok: boolean; detail: string },
  at: Date = new Date(),
): Promise<void> {
  await db
    .updateTable("storeListing")
    .set({
      lastVerifiedAt: at,
      verificationError: outcome.ok ? null : outcome.detail.slice(0, 2000),
      updatedAt: at,
    })
    .where("id", "=", listingId)
    .execute()

  if (!outcome.ok) {
    /*
      Written here rather than through `crudStoreListing.unpublish`, which requires a reviewer.

      There is no reviewer: nobody looked. Passing a system user's id would put a person's name on
      a decision they did not make, and `reviewed_by_user_id` is what a moderation UI shows as
      "archived by". Left null, with the reason saying which build failed, the row reads as what it
      is — a listing the catalogue check could not build.
    */
    await db
      .updateTable("storeListing")
      .set({
        status: LISTING_ARCHIVED,
        rejectionReason: `The catalogue check could not build this listing: ${outcome.detail.slice(0, 500)}`,
        updatedAt: at,
      })
      .where("id", "=", listingId)
      .execute()
  }
}

export function verifyCatalogue(
  build: (input: {
    repositoryUrl: string
    ref: string
    contextSubdir: string
    dockerfilePath: string
  }) => Promise<{ ok: boolean; detail: string }>,
  verifyMirror: typeof verifyDeploymentMirror = verifyDeploymentMirror,
): JobHandler {
  return async (_job, { db }) => {
    const due = await listingsDueForCheck(db)

    for (const listing of due) {
      if (listing.deploymentSourceOwner === null || listing.deploymentSourceRepo === null) {
        await recordVerification(db, listing.id, {
          ok: false,
          detail: "The listing has no SproutOS-Apps deployment mirror.",
        })
        continue
      }

      const instructionsPath = await verifyMirror({
        upstreamOwner: listing.upstreamOwner,
        mirrorOwner: listing.deploymentSourceOwner,
        repo: listing.deploymentSourceRepo,
        branch: listing.defaultBranch,
      })
      if (instructionsPath === null) {
        await recordVerification(db, listing.id, {
          ok: false,
          detail:
            "The deployment mirror is behind upstream, lacks SPROUT_OS_DEPLOY.md, or changes other source files.",
        })
        continue
      }

      const outcome = await build({
        repositoryUrl: `https://github.com/${listing.deploymentSourceOwner}/${listing.deploymentSourceRepo}.git`,
        ref: listing.defaultBranch,
        contextSubdir: listing.rootDir,
        dockerfilePath: listing.dockerfilePath,
      })

      await recordVerification(db, listing.id, outcome)

      if (!outcome.ok) {
        console.warn(
          `[jobs] ${listing.slug} no longer builds and has been archived: ${outcome.detail.slice(0, 200)}`,
        )
      }
    }
  }
}

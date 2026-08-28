import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import {
  listingsDueForCheck,
  recordVerification,
  RECHECK_AFTER_DAYS,
  verifyCatalogue,
} from "./catalogue-check"

/**
 * The store's promise is that a listed application deploys, and nothing checked it.
 *
 * The catalogue broke that promise three ways in one afternoon: four of six listings kept their
 * Dockerfile somewhere other than the repository root, one pointed at a framework's monorepo and
 * called it a blog starter, and one pointed at a Dockerfile that is real and is a *release*
 * Dockerfile — `COPY dist/shiori…`, expecting a binary a goreleaser pipeline put there that no fork
 * of the source has.
 *
 * All three were invisible to inspection. The repository exists, the path exists, the file is a
 * valid Dockerfile. Each was found by a customer-shaped action failing, which is the argument for
 * building the catalogue rather than reading it.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created: string[] = []

async function listing(overrides: { lastVerifiedAt?: Date | null } = {}) {
  const id = v7()
  await db
    .insertInto("storeListing")
    .values({
      id,
      slug: `chk-${id.slice(-10)}`,
      name: "Checked",
      tagline: "A listing the catalogue check looks at",
      descriptionMd: "",
      upstreamHost: "github.com",
      // Unique per listing: `store_listing_upstream_live_key` allows one live listing per upstream,
      // which is the right constraint and means fixtures cannot share one.
      upstreamOwner: "acme",
      upstreamRepo: `app-${id.slice(-10)}`,
      upstreamRepoUrl: `https://github.com/acme/app-${id.slice(-10)}`,
      status: "published",
      dockerfilePath: "Dockerfile",
      ...(overrides.lastVerifiedAt === undefined
        ? {}
        : { lastVerifiedAt: overrides.lastVerifiedAt }),
    })
    .execute()
  created.push(id)
  return id
}

async function statusOf(id: string) {
  return await db
    .selectFrom("storeListing")
    .select(["status", "lastVerifiedAt", "verificationError", "rejectionReason"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
}

afterAll(async () => {
  if (!reachable || created.length === 0) return
  await db.deleteFrom("storeListing").where("id", "in", created).execute()
})

describe.runIf(reachable)("the catalogue check", () => {
  it("looks at a listing nobody has ever built before re-checking an old one", async () => {
    // A listing nobody has built is the one most likely to be wrong, and every listing in the
    // catalogue was in that state.
    const never = await listing({ lastVerifiedAt: null })
    const old = await listing({
      lastVerifiedAt: new Date(Date.now() - (RECHECK_AFTER_DAYS + 1) * 86_400_000),
    })

    const due = (await listingsDueForCheck(db, 50)).map((row) => row.id)
    expect(due).toContain(never)
    expect(due).toContain(old)
    expect(due.indexOf(never)).toBeLessThan(due.indexOf(old))
  })

  it("leaves a recently verified listing alone", async () => {
    const fresh = await listing({ lastVerifiedAt: new Date() })
    expect((await listingsDueForCheck(db, 50)).map((row) => row.id)).not.toContain(fresh)
  })

  it("archives a listing that cannot be built, and says which build failed", async () => {
    const id = await listing({ lastVerifiedAt: null })

    await recordVerification(db, id, {
      ok: false,
      detail: 'failed to compute cache key: "/dist/shiori_linux_amd64/shiori": not found',
    })

    const row = await statusOf(id)
    expect(row.status).toBe("archived")
    expect(row.rejectionReason).toContain("dist/shiori")
    // Null, because nobody looked. A system user's id here would put a person's name on a decision
    // they did not make.
    expect(
      await db
        .selectFrom("storeListing")
        .select(["reviewedByUserId"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ reviewedByUserId: null })
  })

  it("moves last_verified_at on a failure too", async () => {
    /*
      "When we last looked", not "when it last worked".

      Leaving it unset on failure makes a permanently broken listing the only thing the check ever
      looks at — the batch is small and ordered by this column, so one unbuildable listing would
      starve the rest of the catalogue forever.
    */
    const id = await listing({ lastVerifiedAt: null })
    await recordVerification(db, id, { ok: false, detail: "nope" })

    expect((await statusOf(id)).lastVerifiedAt).not.toBeNull()
    expect((await listingsDueForCheck(db, 50)).map((row) => row.id)).not.toContain(id)
  })

  it("keeps a listing that builds, and clears a stale error", async () => {
    const id = await listing({ lastVerifiedAt: null })
    await recordVerification(db, id, { ok: false, detail: "was broken" })
    await db.updateTable("storeListing").set({ status: "published" }).where("id", "=", id).execute()

    await recordVerification(db, id, { ok: true, detail: "" })

    const row = await statusOf(id)
    expect(row.status).toBe("published")
    expect(row.verificationError).toBeNull()
  })

  it("builds each due listing at its own ref, root and Dockerfile path", async () => {
    // The three things a listing carries that the build needs. A check that built the repository
    // root of the default branch would pass for exactly the listings that were already broken.
    const id = await listing({ lastVerifiedAt: null })
    await db
      .updateTable("storeListing")
      .set({
        defaultBranch: "develop",
        rootDir: "apps/web",
        dockerfilePath: "docker/prod.Dockerfile",
      })
      .where("id", "=", id)
      .execute()

    /*
      Everything else marked verified first.

      The batch is three, and the fixtures from the tests above are also due — so without this the
      assertion depends on which order the tests ran in, which is the kind of test that passes for
      a while and then does not.
    */
    await db
      .updateTable("storeListing")
      .set({ lastVerifiedAt: new Date() })
      .where("id", "!=", id)
      .where("status", "=", "published")
      .execute()

    const seen: unknown[] = []
    await verifyCatalogue((input) => {
      seen.push(input)
      return Promise.resolve({ ok: true, detail: "" })
    })(
      {
        id: v7(),
        kind: "store.verify_catalogue",
        payload: {},
        attempt: 1,
        maxAttempts: 3,
        organizationId: null,
      },
      {
        db,
        keepAlive: () => Promise.resolve(true),
        signal: new AbortController().signal,
      },
    )

    const expected = await db
      .selectFrom("storeListing")
      .select(["upstreamOwner", "upstreamRepo"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow()

    expect(seen).toContainEqual({
      repositoryUrl: `https://github.com/${expected.upstreamOwner}/${expected.upstreamRepo}.git`,
      ref: "develop",
      contextSubdir: "apps/web",
      dockerfilePath: "docker/prod.Dockerfile",
    })
  })
})

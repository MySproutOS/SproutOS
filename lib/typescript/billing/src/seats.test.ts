import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import {
  decideSeats,
  FREE_COMMITTERS,
  identityOf,
  isBot,
  mayLaunch,
  recordCommitters,
} from "./seats"

/**
 * The team fee. Against the real database, because the count is a `distinct` across a join and the
 * thing that goes wrong is a query counting the same person twice.
 */
const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const created: { table: "repository" | "organization" | "user"; id: string }[] = []

async function organization(): Promise<string> {
  const userId = v7()
  const organizationId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `seat-${userId}@test.invalid` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Seats",
      slug: `seat-${organizationId.slice(-12)}`,
      kind: "team",
      ownerUserId: userId,
    })
    .execute()
  created.push({ table: "organization", id: organizationId })

  return organizationId
}

async function repository(organizationId: string, isPrivate: boolean): Promise<string> {
  const repositoryId = v7()
  const suffix = repositoryId.slice(-12)

  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: BigInt(`0x${suffix}`),
      ownerLogin: "acme",
      name: `repo-${suffix}`,
      provenance: "new",
      private: isPrivate,
    })
    .execute()
  created.push({ table: "repository", id: repositoryId })

  return repositoryId
}

const EPOCH = new Date("2026-01-01T00:00:00Z")

afterAll(async () => {
  if (!reachable) return
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  await db.destroy()
})

describe("who counts as a committer", () => {
  it("does not charge a customer for their robots", () => {
    // A naive distinct-author count charges for Dependabot opening a pull request, which would be
    // indefensible on an invoice.
    expect(isBot("dependabot[bot]", null)).toBe(true)
    expect(isBot("github-actions[bot]", null)).toBe(true)
    expect(isBot("renovate", null)).toBe(true)
    expect(isBot("sproutos-agent", null)).toBe(true)

    expect(isBot("ada", "ada@example.com")).toBe(false)
    // A person whose name merely contains "bot".
    expect(isBot("robotham", "rob@example.com")).toBe(false)
  })

  it("keys on the login when there is one and the email otherwise", () => {
    // The login is authoritative but absent when GitHub cannot resolve the email; the email is
    // whatever the committer configured locally. Neither alone is enough.
    expect(identityOf("Ada", "ada@example.com")).toBe("ada")
    expect(identityOf(null, "Ada@Example.com")).toBe("ada@example.com")
    expect(identityOf("", "  ")).toBeUndefined()
    expect(identityOf(null, null)).toBeUndefined()
  })
})

describe.runIf(reachable)("deciding the fee", () => {
  it("counts one person once, however many commits they push", async () => {
    const organizationId = await organization()
    const repositoryId = await repository(organizationId, true)

    // The same person, three pushes, two machines with different git emails.
    await recordCommitters(db, repositoryId, [{ login: "ada", email: "ada@work.example" }])
    await recordCommitters(db, repositoryId, [{ login: "ada", email: "ada@home.example" }])
    await recordCommitters(db, repositoryId, [{ login: "ada", email: "ada@work.example" }])

    const decision = await decideSeats(db, organizationId, EPOCH)

    // One, not three. Counting on email would charge for a person with two laptops.
    expect(decision.committers).toBe(1)
    expect(decision.billable).toBe(false)
  })

  it("is free at the threshold and charges above it", async () => {
    const organizationId = await organization()
    const repositoryId = await repository(organizationId, true)

    await recordCommitters(db, repositoryId, [
      { login: "ada", email: "ada@example.com" },
      { login: "grace", email: "grace@example.com" },
    ])

    // Exactly two is free: the requirement says "more than 2", so the pair is included and the
    // third person is what starts the charge.
    const pair = await decideSeats(db, organizationId, EPOCH)
    expect(pair.committers).toBe(FREE_COMMITTERS)
    expect(pair.billable).toBe(false)

    await recordCommitters(db, repositoryId, [{ login: "alan", email: "alan@example.com" }])

    const trio = await decideSeats(db, organizationId, EPOCH)
    expect(trio.committers).toBe(3)
    expect(trio.billable).toBe(true)
  })

  it("exempts public repositories", async () => {
    const organizationId = await organization()
    const open = await repository(organizationId, false)

    await recordCommitters(db, open, [
      { login: "ada", email: "a@example.com" },
      { login: "grace", email: "g@example.com" },
      { login: "alan", email: "t@example.com" },
      { login: "edsger", email: "e@example.com" },
    ])

    // Four committers, and nothing owed. Open source does not pay for seats.
    const decision = await decideSeats(db, organizationId, EPOCH)
    expect(decision.committers).toBe(0)
    expect(decision.billable).toBe(false)
  })

  it("charges an organization once, not once per repository", async () => {
    const organizationId = await organization()
    const first = await repository(organizationId, true)
    const second = await repository(organizationId, true)

    await recordCommitters(db, first, [
      { login: "ada", email: "a@example.com" },
      { login: "grace", email: "g@example.com" },
    ])
    await recordCommitters(db, second, [
      { login: "ada", email: "a@example.com" },
      { login: "alan", email: "t@example.com" },
    ])

    /*
      Three people across two repositories, counted once each.

      "Flat" is the load-bearing word: charging per repository would multiply a flat fee by how many
      repositories a team happens to split their work across.
    */
    const decision = await decideSeats(db, organizationId, EPOCH)
    expect(decision.committers).toBe(3)
    expect(decision.billable).toBe(true)
  })

  it("does not count a robot towards the threshold", async () => {
    const organizationId = await organization()
    const repositoryId = await repository(organizationId, true)

    await recordCommitters(db, repositoryId, [
      { login: "ada", email: "a@example.com" },
      { login: "grace", email: "g@example.com" },
      { login: "dependabot[bot]", email: "support@github.com" },
    ])

    const decision = await decideSeats(db, organizationId, EPOCH)

    // Two people and a robot is two people.
    expect(decision.committers).toBe(2)
    expect(decision.billable).toBe(false)
  })

  it("only counts commits inside the window", async () => {
    const organizationId = await organization()
    const repositoryId = await repository(organizationId, true)

    const lastYear = new Date("2025-06-01T00:00:00Z")
    await recordCommitters(
      db,
      repositoryId,
      [
        { login: "ada", email: "a@example.com" },
        { login: "grace", email: "g@example.com" },
        { login: "alan", email: "t@example.com" },
      ],
      lastYear,
    )

    // A team that was three people a year ago and is nobody now owes nothing.
    const decision = await decideSeats(db, organizationId, EPOCH)
    expect(decision.committers).toBe(0)
    expect(decision.billable).toBe(false)
  })
})

describe("blocking a launch", () => {
  it("blocks a new launch and leaves what is running alone", () => {
    const owing = { billable: true, committers: 3, reason: "three people" }

    const blocked = mayLaunch(owing, false)
    expect(blocked.allowed).toBe(false)
    /*
      The message says what is still true.

      Pulling a live site down over an unpaid seat fee is a different and much larger decision than
      the one asked for, and a customer reading this needs to know their users are not affected.
    */
    expect(blocked.reason).toContain("keeps running")

    expect(mayLaunch(owing, true).allowed).toBe(true)
  })

  it("does not block an organization that owes nothing", () => {
    expect(mayLaunch({ billable: false, committers: 2, reason: "" }, false).allowed).toBe(true)
  })
})

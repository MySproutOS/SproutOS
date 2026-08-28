import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { crudAgentSession, fetchAgentSession } from "./crud"

/*
  The *tail* of a UUIDv7, not the head.

  A v7 is 48 bits of millisecond timestamp followed by random bits, so `slice(0, 8)` is pure clock:
  two ids minted in the same millisecond share it exactly. That is not hypothetical — it made this
  suite fail roughly one run in three with
  `duplicate key value violates unique constraint "organization_slug_live_key"`, from a value chosen
  precisely because it was supposed to be unique.

  The last twelve characters are the random half.
*/

/**
 * Against the docker-compose Postgres.
 *
 * The property under test is the unique constraint's, and the bug was a SQL expression: nothing
 * about it is observable without a database that enforces `agent_turn_session_seq_key`.
 */
let reachable = false
let organizationId: string
let ownerUserId: string
let repositoryId: string
let projectId: string
let sessionId: string

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  ownerUserId = v7()
  organizationId = v7()
  repositoryId = v7()
  projectId = v7()
  sessionId = v7()

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `turns-${ownerUserId}@test.invalid`, name: "Turns Test" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Turns Test Org",
      slug: `turns-test-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
      ownerLogin: "turns-test",
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "Turns Test Project",
      slug: "turns-test",
    })
    .execute()
  await db
    .insertInto("agentSession")
    // `agent_session` hangs off the project, not the organization — the org is reached
    // through it. Scoping reads still go through the project join.
    .values({ id: sessionId, projectId, createdByUserId: ownerUserId })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return

  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("agentEvent").where("agentSessionId", "=", sessionId).execute()
    await tx.deleteFrom("agentTurn").where("agentSessionId", "=", sessionId).execute()
    await tx.deleteFrom("agentSession").where("id", "=", sessionId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })

  await db.destroy()
})

describe("openTurn", () => {
  /*
    The bug this exists for.

    `seq` was derived as `coalesce(max(seq), 0)` — the *existing* maximum, which is 0 on an empty
    session and therefore right by accident for the first turn and wrong for every one after it.
    Every agent session accepted exactly one message; the second failed with a unique-constraint
    violation surfaced to the browser as a bare 500. One turn per session is the kind of limit
    nobody writes a test for, because nobody would design it.
  */
  it("numbers turns 0, 1, 2 — a session takes more than one message", async ({ skip }) => {
    if (!reachable) skip()
    const sessions = crudAgentSession(db)

    const first = await sessions.openTurn({ agentSessionId: sessionId, role: "user" })
    const second = await sessions.openTurn({ agentSessionId: sessionId, role: "assistant" })
    const third = await sessions.openTurn({ agentSessionId: sessionId, role: "user" })

    expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2])
  })

  it("survives concurrent opens, which is what the retry is for", async ({ skip }) => {
    if (!reachable) skip()
    const sessions = crudAgentSession(db)
    const before = await db
      .selectFrom("agentTurn")
      .select(db.fn.countAll<string>().as("n"))
      .where("agentSessionId", "=", sessionId)
      .executeTakeFirstOrThrow()

    // Three at once: each derives its sequence inside the INSERT, and the losers retry rather than
    // failing the request.
    const opened = await Promise.all([
      sessions.openTurn({ agentSessionId: sessionId, role: "user" }),
      sessions.openTurn({ agentSessionId: sessionId, role: "user" }),
      sessions.openTurn({ agentSessionId: sessionId, role: "user" }),
    ])

    // Distinct sequences, which is the whole point of the constraint.
    expect(new Set(opened.map((turn) => turn.seq)).size).toBe(3)

    const after = await db
      .selectFrom("agentTurn")
      .select(db.fn.countAll<string>().as("n"))
      .where("agentSessionId", "=", sessionId)
      .executeTakeFirstOrThrow()
    expect(Number(after.n)).toBe(Number(before.n) + 3)
  })

  it("reads persisted turns and associates activity with its turn", async ({ skip }) => {
    if (!reachable) skip()
    const turn = await crudAgentSession(db).openTurn({
      agentSessionId: sessionId,
      role: "user",
      inputText: "build a webhook workflow",
    })
    const start = await crudAgentSession(db).nextEventSeq(sessionId)
    await crudAgentSession(db).appendEvents(sessionId, start, [
      { type: "tool_use", payload: { type: "tool_use", name: "Read" }, agentTurnId: turn.id },
    ])

    const [turns, events] = await Promise.all([
      fetchAgentSession(db).listTurns(sessionId),
      fetchAgentSession(db).listEvents(sessionId, null),
    ])
    expect(
      turns.some((row) => row.id === turn.id && row.inputText === "build a webhook workflow"),
    ).toBe(true)
    expect(events.some((event) => event.agentTurnId === turn.id && event.type === "tool_use")).toBe(
      true,
    )
  })
})

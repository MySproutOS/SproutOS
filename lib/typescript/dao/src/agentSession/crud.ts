import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Selectable, type Transaction } from "kysely"
import { v7 } from "uuid"

export type AgentEventRow = {
  type: string
  payload: unknown
  agentTurnId?: string | null
}

/**
 * Append events while holding the per-session sequence lock.
 *
 * Agent actions arrive on a second HTTP request while the chat stream is still buffering harness
 * events. Deriving `max(seq) + 1` outside a shared lock lets both requests claim the same sequence
 * and makes the later insert fail. The transaction-scoped advisory lock serializes only writers to
 * this one transcript; unrelated sessions never wait on it.
 */
export async function appendAgentEventsInTransaction(
  tx: Transaction<DB>,
  agentSessionId: string,
  events: readonly AgentEventRow[],
): Promise<void> {
  if (events.length === 0) return

  await sql`select pg_advisory_xact_lock(hashtextextended(${agentSessionId}, 0))`.execute(tx)
  const row = await tx
    .selectFrom("agentEvent")
    .select((eb) => eb.fn.max("seq").as("maxSeq"))
    .where("agentSessionId", "=", agentSessionId)
    .executeTakeFirst()
  const startSeq = BigInt(row?.maxSeq ?? 0) + 1n

  await tx
    .insertInto("agentEvent")
    .values(
      events.map((event, index) => ({
        id: v7(),
        agentSessionId,
        agentTurnId: event.agentTurnId ?? null,
        seq: startSeq + BigInt(index),
        type: event.type,
        payload: JSON.stringify(event.payload),
      })),
    )
    .execute()
}

/**
 * How many times `openTurn` re-derives its sequence after losing the race.
 *
 * Three, because the losers of a collision are bounded by how many messages a single session has in
 * flight at once, and that is a person typing. A number large enough to matter here would mean
 * something other than concurrency is wrong.
 */
const RETRIES = 3

export function crudAgentSession(db: Kysely<DB>) {
  async function createSession(input: {
    projectId: string
    createdByUserId: string
    title?: string | null
  }): Promise<Selectable<DB["agentSession"]>> {
    return await db
      .insertInto("agentSession")
      .values({
        id: v7(),
        projectId: input.projectId,
        createdByUserId: input.createdByUserId,
        title: input.title ?? null,
        status: "active",
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * Open a turn and take its sequence number in one statement.
   *
   * `agent_turn_session_seq_key` is a unique constraint, so two messages sent at once must not both
   * read the same max and both write it. Deriving the sequence inside the INSERT lets the database
   * settle that race: the loser hits the constraint, and `RETRIES` below is what turns it into a
   * second attempt rather than a 500.
   *
   * **`max(seq) + 1`, not `max(seq)`.** It was the latter, which is 0 on an empty session — right
   * by accident for the first turn — and then returns the *existing* maximum forever after. So
   * every session accepted exactly one turn and the second message failed with
   * `duplicate key value violates unique constraint "agent_turn_session_seq_key"`, a 500 with no
   * user-facing explanation. `max(...) + 1` is NULL on an empty set, which is what makes the
   * `coalesce` give 0 for the first turn and n+1 for every one after it.
   */
  async function openTurn(input: {
    agentSessionId: string
    role: "user" | "assistant" | "system"
    inputText?: string | null
  }): Promise<Selectable<DB["agentTurn"]>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await db
          .insertInto("agentTurn")
          .values((eb) => ({
            id: v7(),
            agentSessionId: input.agentSessionId,
            role: input.role,
            inputText: input.inputText ?? null,
            seq: eb
              .selectFrom("agentTurn as prior")
              .select((inner) =>
                inner.fn.coalesce(sql<number>`max(prior.seq) + 1`, inner.lit(0)).as("nextSeq"),
              )
              .where("prior.agentSessionId", "=", input.agentSessionId)
              .$castTo<number>(),
          }))
          .returningAll()
          .executeTakeFirstOrThrow()
      } catch (error) {
        // Only the sequence collision, and only a bounded number of times. Retrying anything else
        // would turn a schema error into a slow schema error, and retrying forever would turn a
        // genuinely stuck session into a spinning request.
        const collided = String(error).includes("agent_turn_session_seq_key")
        if (!collided || attempt >= RETRIES) throw error
      }
    }
  }

  async function closeTurn(
    id: string,
    values: {
      resultSubtype?: string | null
      estimatedCostMicroUsd?: bigint | null
      numTurns?: number | null
      durationMs?: number | null
      error?: string | null
    },
  ): Promise<void> {
    await db.updateTable("agentTurn").set(values).where("id", "=", id).execute()
  }

  /**
   * Append events, numbered per session.
   *
   * Batched rather than written per event: a chat turn emits hundreds of them, and a round trip
   * each would make the database the slowest part of streaming a response the model already sent.
   */
  async function appendEvents(
    agentSessionId: string,
    events: readonly AgentEventRow[],
  ): Promise<void> {
    await db
      .transaction()
      .execute((tx) => appendAgentEventsInTransaction(tx, agentSessionId, events))
  }

  async function setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
    await db
      .updateTable("agentSession")
      .set({ sdkSessionId, updatedAt: new Date() })
      .where("id", "=", id)
      .execute()
  }

  async function setStatus(
    id: string,
    status: "active" | "idle" | "completed" | "failed" | "archived",
  ): Promise<void> {
    await db
      .updateTable("agentSession")
      .set({ status, updatedAt: new Date() })
      .where("id", "=", id)
      .execute()
  }

  /**
   * Close every resumable conversation that shared a sandbox the user explicitly deleted.
   *
   * Sandboxes are scoped to a repository group, while agent sessions belong to the particular
   * group or child project the user opened. Archiving only the route's project leaves another
   * child's session marked active and causes the dashboard to restore a conversation whose
   * workspace no longer exists.
   */
  async function archiveRestorableForSandboxScope(
    projectId: string,
    createdByUserId: string,
  ): Promise<void> {
    const projectsInScope = db
      .selectFrom("project as scopedProject")
      .select("scopedProject.id")
      .where((eb) =>
        eb.or([
          eb("scopedProject.id", "=", projectId),
          eb("scopedProject.parentProjectId", "=", projectId),
        ]),
      )

    await db
      .updateTable("agentSession")
      .set({ status: "archived", updatedAt: new Date() })
      .where("createdByUserId", "=", createdByUserId)
      .where("projectId", "in", projectsInScope)
      .where("status", "in", ["active", "idle"])
      .execute()
  }

  /** The first prompt becomes the title, so a session list is readable without opening each one. */
  async function titleIfUnset(id: string, prompt: string): Promise<void> {
    const title = prompt.trim().replace(/\s+/g, " ").slice(0, 80)
    if (title === "") return

    await db
      .updateTable("agentSession")
      .set({ title, updatedAt: new Date() })
      .where("id", "=", id)
      .where("title", "is", null)
      .execute()
  }

  return {
    archiveRestorableForSandboxScope,
    appendEvents,
    closeTurn,
    createSession,
    openTurn,
    setSdkSessionId,
    setStatus,
    titleIfUnset,
  }
}

export function fetchAgentSession(db: Kysely<DB> | Transaction<DB>) {
  /**
   * A session is reached through its project, and the project through the organization. There is
   * no organization column on `agent_session`, so the join is the tenancy check — asking for a
   * session by id alone would answer for any organization's.
   */
  async function getInOrganization(
    organizationId: string,
    projectId: string,
    id: string,
  ): Promise<Selectable<DB["agentSession"]> | undefined> {
    return await db
      .selectFrom("agentSession")
      .innerJoin("project", "project.id", "agentSession.projectId")
      .selectAll("agentSession")
      .where("agentSession.id", "=", id)
      .where("agentSession.projectId", "=", projectId)
      .where("project.organizationId", "=", organizationId)
      .where("project.deletedAt", "is", null)
      .executeTakeFirst()
  }

  async function listForProject(
    organizationId: string,
    projectId: string,
    limit = 50,
  ): Promise<Selectable<DB["agentSession"]>[]> {
    return await db
      .selectFrom("agentSession")
      .innerJoin("project", "project.id", "agentSession.projectId")
      .selectAll("agentSession")
      .where("agentSession.projectId", "=", projectId)
      .where("project.organizationId", "=", organizationId)
      .where("project.deletedAt", "is", null)
      .where("agentSession.archivedAt", "is", null)
      .orderBy("agentSession.createdAt", "desc")
      .limit(limit)
      .execute()
  }

  async function listEvents(
    agentSessionId: string,
    afterSeq: bigint | null,
    limit = 500,
  ): Promise<
    { seq: string; type: string; payload: unknown; agentTurnId: string | null; createdAt: Date }[]
  > {
    const rows = await db
      .selectFrom("agentEvent")
      .select(["seq", "type", "payload", "agentTurnId", "createdAt"])
      .where("agentSessionId", "=", agentSessionId)
      // `seq` is bigint in Postgres and selects as a string, so the comparand is stringified
      // rather than cast: a Number() here would silently lose precision past 2^53.
      .$if(afterSeq !== null, (qb) => qb.where("seq", ">", String(afterSeq)))
      .orderBy("seq", "asc")
      .limit(limit)
      .execute()

    return rows.map((row) => ({
      seq: String(row.seq),
      type: row.type,
      payload: row.payload,
      agentTurnId: row.agentTurnId,
      createdAt: row.createdAt,
    }))
  }

  async function listTurns(agentSessionId: string) {
    return await db
      .selectFrom("agentTurn")
      .select(["id", "role", "inputText", "error", "seq", "createdAt"])
      .where("agentSessionId", "=", agentSessionId)
      .orderBy("seq", "asc")
      .execute()
  }

  async function getTurnInSession(agentSessionId: string, agentTurnId: string) {
    return await db
      .selectFrom("agentTurn")
      .select(["id", "agentSessionId", "resultSubtype"])
      .where("id", "=", agentTurnId)
      .where("agentSessionId", "=", agentSessionId)
      .executeTakeFirst()
  }

  return {
    getInOrganization,
    getTurnInSession,
    listEvents,
    listForProject,
    listTurns,
  }
}

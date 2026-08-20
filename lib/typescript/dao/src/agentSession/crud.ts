import type { DB } from "@sproutos/db"
import type { Kysely, Selectable, Transaction } from "kysely"
import { v7 } from "uuid"

export type AgentEventRow = {
  type: string
  payload: unknown
  agentTurnId?: string | null
}

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
   * `agent_turn_session_seq_key` is a unique constraint, so two messages sent at once must not
   * both read the same max and both write it. Deriving the sequence inside the INSERT lets the
   * database settle the race: the loser hits the constraint and retries rather than silently
   * overwriting the winner's turn.
   */
  async function openTurn(input: {
    agentSessionId: string
    role: "user" | "assistant" | "system"
    inputText?: string | null
  }): Promise<Selectable<DB["agentTurn"]>> {
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
            inner.fn.coalesce(inner.fn.max("prior.seq"), inner.lit(0)).as("maxSeq"),
          )
          .where("prior.agentSessionId", "=", input.agentSessionId)
          .$castTo<number>(),
      }))
      .returningAll()
      .executeTakeFirstOrThrow()
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
    startSeq: bigint,
    events: readonly AgentEventRow[],
  ): Promise<void> {
    if (events.length === 0) return

    await db
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

  async function nextEventSeq(agentSessionId: string): Promise<bigint> {
    const row = await db
      .selectFrom("agentEvent")
      .select((eb) => eb.fn.max("seq").as("maxSeq"))
      .where("agentSessionId", "=", agentSessionId)
      .executeTakeFirst()

    return BigInt(row?.maxSeq ?? 0) + 1n
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
    appendEvents,
    closeTurn,
    createSession,
    nextEventSeq,
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
  ): Promise<{ seq: string; type: string; payload: unknown; createdAt: Date }[]> {
    const rows = await db
      .selectFrom("agentEvent")
      .select(["seq", "type", "payload", "createdAt"])
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
      createdAt: row.createdAt,
    }))
  }

  return { getInOrganization, listEvents, listForProject }
}

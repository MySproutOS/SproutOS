import { type Kysely, sql } from "kysely"

/**
 * Bind a sandbox proxy token to the person and chat turn that received it.
 *
 * The token was originally useful only at the LLM proxy, where organization/project scope is
 * enough to attribute model usage. A coding agent can now perform one narrow control-plane action:
 * nominate a deployable child as its group's primary project. That action must be attributable to
 * the person who started the turn and must stop working when the turn's token expires or is
 * revoked, so those identities live on the same hashed-token row rather than in caller-controlled
 * headers.
 *
 * Nullable preserves already-issued tokens and the organization-scoped manual mint endpoint. The
 * action route refuses any row without all three values; only a token minted for a live chat turn
 * can mutate a group.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("agent_proxy_token")
    .addColumn("actor_user_id", "uuid", (col) => col.references("user.id").onDelete("restrict"))
    .addColumn("agent_session_id", "uuid", (col) =>
      col.references("agent_session.id").onDelete("cascade"),
    )
    .addColumn("agent_turn_id", "uuid", (col) =>
      col.references("agent_turn.id").onDelete("cascade"),
    )
    .execute()

  await sql`
    alter table agent_proxy_token
      add constraint agent_proxy_token_turn_scope_check
      check ((agent_session_id is null) = (agent_turn_id is null))
  `.execute(db)

  for (const column of ["actor_user_id", "agent_session_id", "agent_turn_id"] as const) {
    await db.schema
      .createIndex(`agent_proxy_token_${column}_idx`)
      .on("agent_proxy_token")
      .column(column)
      .execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const column of ["agent_turn_id", "agent_session_id", "actor_user_id"] as const) {
    await db.schema.dropIndex(`agent_proxy_token_${column}_idx`).ifExists().execute()
  }
  await sql`
    alter table agent_proxy_token
      drop constraint if exists agent_proxy_token_turn_scope_check
  `.execute(db)
  await db.schema
    .alterTable("agent_proxy_token")
    .dropColumn("agent_turn_id")
    .dropColumn("agent_session_id")
    .dropColumn("actor_user_id")
    .execute()
}

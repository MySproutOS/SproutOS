import { type Kysely, sql } from "kysely"

/**
 * The credential a sandbox agent holds, which is not a model provider's credential.
 *
 * ## Why this table exists
 *
 * `CreateSandboxInput.env` has said from the day it was written: "Never the customer's raw LLM
 * credential." Nothing enforced it, because there was nothing else to give the agent. A sandbox is
 * a machine a model can run arbitrary commands on; putting an Anthropic key or an OpenAI key in its
 * environment means the first `printenv` exfiltrates a credential that bills the customer directly
 * and that we cannot rotate on their behalf.
 *
 * So the agent gets one of these instead. It is minted for one project, it expires, and it is only
 * useful when presented to our own proxy — which holds the real credential and never sends it
 * onward to the sandbox.
 *
 * ## Two tokens, not one
 *
 * An access token short enough that a leak has a bounded blast radius is too short for an agent
 * turn that runs for an hour. A refresh token fixes that without making the access token
 * long-lived: the access token expires in minutes and the agent exchanges the refresh token for
 * another. A leaked access token is worth what is left of its window; a leaked refresh token is
 * revocable, and revoking it is one `UPDATE` here rather than a rotation at the provider.
 *
 * ## Hashes, not tokens
 *
 * Both columns hold a SHA-256 of the token and never the token, for the same reason
 * `service_credential` and `session` do: a database leak yields nothing replayable. The token
 * exists once, in the response that mints it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("agent_proxy_token")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("organization_id", "uuid", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    /*
      The project, so a token minted for one sandbox cannot bill another.

      Nullable because a turn can be organization-scoped — the chat surface has no project — and a
      token with no project meters against the organization alone.
    */
    .addColumn("project_id", "uuid", (col) => col.references("project.id").onDelete("cascade"))
    /*
      Which credential the proxy should use upstream.

      Nullable: absent means the platform's own key, billed to credit. That is the same fork
      `resolveAgentCredential` already makes, recorded here so the proxy does not have to re-derive
      it from configuration that may have changed since the token was minted.
    */
    .addColumn("agent_credential_id", "uuid", (col) =>
      col.references("agent_credential.id").onDelete("cascade"),
    )
    .addColumn("access_token_hash", "text", (col) => col.notNull())
    .addColumn("refresh_token_hash", "text", (col) => col.notNull())
    .addColumn("access_expires_at", "timestamptz", (col) => col.notNull())
    .addColumn("refresh_expires_at", "timestamptz", (col) => col.notNull())
    /*
      Set when the token is deliberately withdrawn — a sandbox torn down, a customer revoking a
      credential. Distinct from expiry so "this was taken away" and "this ran out" are different
      facts, which matters when someone is asking why an agent stopped working.
    */
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  /*
    The lookup the proxy makes on every request, so it is an index and not a scan.

    Unique: two rows with the same access-token hash would mean one token authorising two
    identities, and which one the proxy picked would depend on physical row order.
  */
  await db.schema
    .createIndex("agent_proxy_token_access_key")
    .on("agent_proxy_token")
    .column("access_token_hash")
    .unique()
    .execute()

  await db.schema
    .createIndex("agent_proxy_token_refresh_key")
    .on("agent_proxy_token")
    .column("refresh_token_hash")
    .unique()
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("agent_proxy_token").execute()
}

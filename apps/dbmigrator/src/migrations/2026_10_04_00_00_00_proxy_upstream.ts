import type { Kysely } from "kysely"

/**
 * What the proxy should send upstream, decided when the token is minted.
 *
 * ## Why the secret is carried here rather than looked up
 *
 * The customer's model credential is envelope-encrypted under KMS, and opening it needs the same
 * KMS calls and the same key hierarchy the control plane has. The router is a Rust process on a
 * public-facing box; giving it `kms:Decrypt` on the envelope key would let anything that took that
 * box read every customer credential in the account, not just the one it is proxying for.
 *
 * So the control plane opens the credential once, at mint time, and re-seals it under a symmetric
 * key both components share. The router can open exactly what it was handed and nothing else. The
 * blast radius of the router is one live sandbox session, which is what it is proxying anyway.
 *
 * ## Why it is a snapshot
 *
 * A customer who rotates their key mid-session keeps working until the token expires, and the next
 * mint picks up the new one. The alternative — resolving the credential per request — means the
 * proxy re-derives configuration that may have changed under it, and a turn that silently switched
 * providers halfway would be very hard to explain.
 *
 * Null in all three means the platform's own key, which the router reads from its own environment.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("agent_proxy_token")
    // `anthropic` or `openai`, which is what decides the wire format the proxy has to parse usage
    // out of — `message_delta` against `response.completed`.
    .addColumn("upstream_kind", "text")
    .addColumn("upstream_base_url", "text")
    // AES-256-GCM under the shared key, base64. Never the plaintext, and never KMS ciphertext:
    // this is a different key with a much smaller reach, deliberately.
    .addColumn("upstream_secret", "text")
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("agent_proxy_token")
    .dropColumn("upstream_kind")
    .dropColumn("upstream_base_url")
    .dropColumn("upstream_secret")
    .execute()
}

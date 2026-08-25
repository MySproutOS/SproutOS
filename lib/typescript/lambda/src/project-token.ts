import { createHmac } from "node:crypto"

/**
 * A token that proves one thing: which project a caller is.
 *
 * Minted here and verified in `services/router/src/log_token.rs`, against the shared vectors in
 * `services/router/fixtures/log-token.json` — one of the cross-language seams `AGENTS.md` names,
 * where both sides read the same file rather than each hard-coding a value one of them can quietly
 * change.
 *
 * The format is byte-for-byte the deploy token's: `<project>.<expires-at>.<hmac-sha256-base64url>`.
 * Two token *purposes*, one token *shape*, because a second shape would be a second parser and a
 * second set of ways to be wrong about padding or separators.
 *
 * **What it deliberately is not.** It is not a secret in the sense of a credential — the Lambda
 * extension carries it in the customer's own environment, where the customer's code can read it.
 * That is acceptable precisely because of what it says: the worst use of a project's token is
 * writing logs to that project, which the customer can already do by calling `console.log`. It
 * replaced a shared Kafka credential that could write *any* tenant's logs, which was not acceptable
 * at all.
 */
export function mintProjectToken(projectId: string, expiresAt: number, secret: string): string {
  const body = `${projectId}.${expiresAt}`
  const mac = createHmac("sha256", secret).update(body).digest("base64url")
  return `${body}.${mac}`
}

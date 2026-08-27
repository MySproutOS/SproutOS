import { createHmac } from "node:crypto"

/**
 * A token that proves one thing: which project a caller is.
 *
 * Minted here and verified in `services/router/src/log_token.rs`, against the shared vectors in
 * `services/router/fixtures/log-token.json` — one of the cross-language seams `AGENTS.md` names,
 * where both sides read the same file rather than each hard-coding a value one of them can quietly
 * change.
 *
 * The format is
 * `<project>.<organization>.<expires-at>.<hmac-sha256-base64url>`. Organization is signed beside
 * project because the router turns verified runtime reports into billable usage; accepting the
 * organization from the extension body would let customer code attribute its usage to anyone.
 *
 * **What it deliberately is not.** It is not a secret in the sense of a credential — the Lambda
 * extension carries it in the customer's own environment, where the customer's code can read it.
 * It is scoped to one project and its owning organization. Customer code can submit extra reports
 * for its own project and thereby overstate its own bill, but it cannot move usage onto another
 * organization. It replaced a shared Kafka credential that could write *any* tenant's logs, which
 * was not acceptable at all.
 */
export function mintProjectToken(
  projectId: string,
  organizationId: string,
  expiresAt: number,
  secret: string,
): string {
  const body = `${projectId}.${organizationId}.${expiresAt}`
  const mac = createHmac("sha256", secret).update(body).digest("base64url")
  return `${body}.${mac}`
}

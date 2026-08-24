/**
 * Whether an OAuth identity may adopt an existing SproutOS user by email address.
 *
 * **This is an account-takeover decision, so it lives on its own and is tested.** Signing in with a
 * provider and finding an existing user with the same address means inheriting that user's
 * organizations, projects and credits. If the address were not proven, anyone could register with a
 * provider claiming somebody else's email and walk into their account.
 *
 * Google reports `email_verified` in the ID token, and it is false for some Workspace and federated
 * configurations — so this is a branch that happens, not a theoretical one.
 *
 * A refusal is not a dead end for the person: they get a **new** user instead. They still sign in,
 * they simply do not inherit an existing account, and the two can be linked later from settings by
 * someone who can demonstrate they hold both.
 */
export function mayLinkByEmail(identity: {
  email: string | null | undefined
  emailVerified: boolean
}): boolean {
  if (!identity.emailVerified) return false
  const email = identity.email
  // An empty or absent address matches nothing useful and, worse, could match a row written by some
  // future code path that also stored an empty string.
  return typeof email === "string" && email.includes("@")
}

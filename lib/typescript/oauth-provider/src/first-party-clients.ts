/** Stable public OAuth identity compiled into every `sprout` CLI release. */
export const SPROUT_CLI_CLIENT_ID = "01a03b00-0000-7000-8000-0000000c1101"

/** RFC 8252 loopback template. Only the port may vary at authorization time. */
export const SPROUT_CLI_REDIRECT_URI = "http://127.0.0.1/oauth/callback"

/** Full user authority, still intersected with the user's live organization RBAC. */
export const SPROUT_CLI_DEFAULT_SCOPES = ["*"] as const

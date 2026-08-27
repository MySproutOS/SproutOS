/** The session query has four states; transport failure is not an authentication answer. */
export function authGateState(input: {
  loading: boolean
  failed: boolean
  user: unknown
}): "loading" | "failed" | "unauthenticated" | "authenticated" {
  if (input.loading) return "loading"
  if (input.failed) return "failed"
  return input.user == null ? "unauthenticated" : "authenticated"
}

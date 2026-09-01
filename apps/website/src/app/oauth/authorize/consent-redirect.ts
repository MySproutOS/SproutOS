/** Build the OAuth-standard refusal redirect without depending on browser state. */
export function deniedAuthorizationRedirect(redirectUri: string, state: string | null): string {
  const target = new URL(redirectUri)
  target.searchParams.set("error", "access_denied")
  target.searchParams.set("error_description", "The user declined the request")
  if (state !== null) target.searchParams.set("state", state)
  return target.toString()
}

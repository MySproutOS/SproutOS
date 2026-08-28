import { OAuthError } from "./errors"

/**
 * Redirect URIs are matched exactly, string for string.
 *
 * OAuth 2.1 requires it, and every relaxation anyone has tried has been an open redirect:
 *
 * - **Prefix matching** — `https://app.example.com/cb` registered, `https://app.example.com/cb/../../evil`
 *   accepted.
 * - **Subdomain wildcards** — one compromised subdomain takes every client on the domain.
 * - **Ignoring the query** — `?next=https://evil.example` rides along.
 *
 * So: no normalization, no case folding, no trailing-slash forgiveness. A client that registered
 * `https://app.example.com/callback` and asks for `https://app.example.com/callback/` gets an
 * error, and that is a better outcome than the alternative.
 */
export function assertRegisteredRedirect(requested: string, registered: readonly string[]): string {
  if (registered.length === 0) {
    throw new OAuthError("invalid_request", "This client has no registered redirect URI")
  }

  // No default. RFC 6749 permits omitting redirect_uri when exactly one is registered; OAuth 2.1
  // does not, because a client that stops sending it stops noticing when the registration changes.
  if (!registered.some((candidate) => matchesRegisteredRedirect(requested, candidate))) {
    throw new OAuthError("invalid_request", "redirect_uri does not match a registered URI")
  }

  return requested
}

function loopbackTemplateMatch(requested: string, registered: string): boolean {
  let actual: URL
  let template: URL
  try {
    actual = new URL(requested)
    template = new URL(registered)
  } catch {
    return false
  }

  /*
    RFC 8252 section 7.3 permits native applications to choose an ephemeral loopback port.

    This is deliberately the whole exception. The registered URI must be the literal IPv4
    loopback template with no port, and the request may vary only that port. `localhost`, IPv6,
    paths, queries, fragments and credentials do not get normalized or widened.
  */
  if (
    template.protocol !== "http:" ||
    template.hostname !== "127.0.0.1" ||
    template.port !== "" ||
    template.username !== "" ||
    template.password !== "" ||
    template.hash !== ""
  ) {
    return false
  }

  return (
    actual.protocol === template.protocol &&
    actual.hostname === template.hostname &&
    actual.port !== "" &&
    actual.pathname === template.pathname &&
    actual.search === template.search &&
    actual.hash === "" &&
    actual.username === "" &&
    actual.password === ""
  )
}

/** Exact for every web client; RFC 8252's port-only exception for one loopback template. */
export function matchesRegisteredRedirect(requested: string, registered: string): boolean {
  return requested === registered || loopbackTemplateMatch(requested, registered)
}

/**
 * What may be registered in the first place.
 *
 * Loopback and custom schemes are how native clients work, so both are allowed; everything else
 * must be HTTPS. A fragment is refused because the authorization response *is* delivered in the
 * query and a fragment cannot survive it, and a URI with credentials in it is never intentional.
 */
export function assertValidRedirectRegistration(uri: string): void {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new OAuthError("invalid_request", "redirect_uri is not a URL")
  }

  if (parsed.hash !== "") {
    throw new OAuthError("invalid_request", "redirect_uri may not contain a fragment")
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new OAuthError("invalid_request", "redirect_uri may not contain credentials")
  }

  const isLoopback =
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1")
  const isCustomScheme = parsed.protocol !== "http:" && parsed.protocol !== "https:"

  if (parsed.protocol === "https:" || isLoopback || isCustomScheme) return

  // Explicitly not localhost-by-name: it resolves through the host's resolver, which another
  // process can influence. RFC 8252 §7.3 says use the literal loopback address.
  throw new OAuthError(
    "invalid_request",
    "redirect_uri must use https, a custom scheme, or the literal loopback address",
  )
}

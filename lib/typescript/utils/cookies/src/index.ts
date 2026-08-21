/**
 * Where the session cookie is scoped.
 *
 * The website sets the cookie and the API reads and clears it, and they are served from different
 * hosts. That makes the `Domain` attribute load-bearing in both directions: too narrow and the API
 * never receives the cookie, so every signed-in request is anonymous; too wide and the cookie is
 * offered to hosts that are not ours.
 *
 * It lived in two files — `apps/website/src/lib/auth.ts` and `apps/internal-api/src/utils/env.ts` —
 * with the same body copied into each. Two copies of the value a cookie is keyed on is a bug
 * waiting for one of them to be edited: a cookie set with one `Domain` and cleared with another is
 * not cleared, and the user stays signed in after pressing sign out.
 */

/**
 * The `Domain` attribute for the session cookie, or `undefined` for a host-only cookie.
 *
 * `SESSION_COOKIE_DOMAIN` wins when set, and it is the only correct answer for a deployment whose
 * website is not on the apex. The derivation below takes the host of `NEXT_PUBLIC_HOST_URL` and
 * prefixes a dot, which is right for `https://example.com` + `api.example.com` and **wrong** for
 * `https://app.example.com`: it yields `.app.example.com`, which `api.example.com` is not under, so
 * the API sees no cookie and every request is anonymous. That is not a hypothetical — it is what
 * the first real-domain deploy of this platform did, on `app.selloutjobs.com`.
 *
 * Deriving the registrable domain instead is not possible without the Public Suffix List: `.co.uk`
 * and `.github.io` are two labels deep, `.com` is one, and there is no rule that separates them.
 * Shipping a copy of that list to decide a cookie scope is worse than asking the operator, so the
 * variable is the mechanism and the derivation is the convenience for the apex case.
 *
 * Local hosts get `undefined` deliberately: the website (:3000) and the API (:3001) share the host
 * `localhost`, cookies ignore ports, and Chrome rejects a `Domain=localhost` attribute outright.
 */
export function cookieDomain(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.SESSION_COOKIE_DOMAIN
  if (explicit !== undefined && explicit !== "") return explicit

  const hostUrl = env.NEXT_PUBLIC_HOST_URL
  if (hostUrl === undefined || hostUrl === "") return undefined

  const { hostname } = new URL(hostUrl)
  if (hostname === "localhost" || hostname === "127.0.0.1") return undefined
  return `.${hostname}`
}

/**
 * The hostname the browser apps are served from, used to build the API's CORS allowlist.
 *
 * Separate from the cookie scope on purpose. CORS names exact origins; a cookie names a subtree.
 */
export function apexDomain(env: Record<string, string | undefined>): string | undefined {
  const hostUrl = env.NEXT_PUBLIC_HOST_URL
  if (hostUrl === undefined || hostUrl === "") return undefined
  return new URL(hostUrl).hostname
}

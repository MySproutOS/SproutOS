import { apexDomain as sharedApexDomain, cookieDomain as sharedCookieDomain } from "@utils/cookies"

/** Registrable domain the browser apps are served from, used to build the CORS allowlist.
 *
 *  Read lazily rather than as a module-level constant: `packages/db` loads the repo-root `.env`
 *  via dotenv when it is first imported, which happens *after* this module is evaluated. A
 *  constant here would capture `undefined` on any deploy that relies on a `.env` file. */
export function apexDomain(): string | undefined {
  return sharedApexDomain(process.env)
}

/** Cookie `Domain` for the session cookie.
 *
 *  The body lives in `@utils/cookies` because the website sets this cookie and this API clears it;
 *  a copy in each would let the two drift, and a cookie cleared with the wrong `Domain` is a cookie
 *  that is not cleared. See that package for why a subdomain deployment must set
 *  `SESSION_COOKIE_DOMAIN` rather than rely on the derivation. */
export function cookieDomain(): string | undefined {
  return sharedCookieDomain(process.env)
}

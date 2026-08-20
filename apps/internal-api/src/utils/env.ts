/** Hostname of the origin the browser apps are served from, e.g. `example.com`.
 *
 *  Read lazily rather than as a module-level constant: `packages/db` loads the repo-root `.env`
 *  via dotenv when it is first imported, which happens *after* this module is evaluated. A
 *  constant here would capture `undefined` on any deploy that relies on a `.env` file. */
function hostname(): string | undefined {
  const hostUrl = process.env.NEXT_PUBLIC_HOST_URL
  return hostUrl === undefined || hostUrl === "" ? undefined : new URL(hostUrl).hostname
}

/** Registrable domain the browser apps are served from, used to build the CORS allowlist. */
export function apexDomain(): string | undefined {
  return hostname()
}

/** Cookie `Domain` for the session cookie, derived from NEXT_PUBLIC_HOST_URL as `.example.com`.
 *
 *  Deliberately undefined for local hosts: the website (:3000) and this API (:3001) share the
 *  `localhost` host, and cookies ignore ports, so a host-only cookie already reaches both.
 *  In production the two live on different hosts (`example.com` and `api.example.com`), so the
 *  cookie needs the parent domain — with the leading dot — to be sent to the API.
 *
 *  Note this assumes the website is on the apex domain. If it were served from `www.example.com`
 *  this would yield `.www.example.com`, which `api.example.com` would not receive. */
export function cookieDomain(): string | undefined {
  const host = hostname()
  if (host === undefined || host === "localhost" || host === "127.0.0.1") return undefined
  return `.${host}`
}

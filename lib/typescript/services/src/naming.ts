import { encodeShortId } from "./tenant-auth"

/**
 * Real Postgres identifiers, derived from ids rather than from anything a customer typed.
 *
 * A customer's service name goes in `backend_service.name` and stays there. What reaches a `CREATE
 * ROLE` statement is derived from the service's UUID, so the identifier is bounded, unique, and
 * contains nothing that has to be escaped. Interpolating a customer string into DDL — which cannot
 * be parameterized — is how this goes wrong.
 *
 * **The short id, not the UUID's hex.** These names are half of a cross-language contract: this side
 * creates the database and the role, and `lib/rust/tenant-auth` — which all three proxies route
 * with — derives the same names to connect a tenant to them. The proxy only ever sees the short id,
 * because that is what a username carries; a name built from the full UUID is one the proxy cannot
 * reconstruct.
 *
 * It was built from the full UUID. Both sides had tests, both passed, and each asserted its own
 * answer: `sprout_db_01a022cb93bf74f9969791423c4b0b72` here against
 * `sprout_db_01j4pm0000e008000000000051` there. `fixtures/naming-vectors.json` is now the single
 * set of vectors both assert, which is what `AGENTS.md` says all three contracts have and this one
 * did not.
 */
const PREFIX = "sprout"

/** Postgres truncates identifiers at 63 bytes; both of these are 36, well inside it. */
export function databaseNameFor(backendServiceId: string): string {
  return `${PREFIX}_db_${encodeShortId(backendServiceId)}`
}

export function roleNameFor(backendServiceId: string): string {
  return `${PREFIX}_r_${encodeShortId(backendServiceId)}`
}

/**
 * Crockford base32 has no quote, semicolon, newline or space in its alphabet, so an identifier
 * built from one cannot carry anything that changes the meaning of a statement. Asserted rather
 * than assumed, because the value ends up in DDL.
 */
export function assertSafeIdentifier(identifier: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new RangeError(`Refusing to use ${JSON.stringify(identifier)} as a SQL identifier`)
  }
}

/**
 * Build a connection URI.
 *
 * The password is percent-encoded because a generated password can contain characters that mean
 * something in a URI — `@` ends the userinfo, `/` starts the path, `#` starts a fragment — and a
 * URI that parses to the wrong host is worse than one that fails to parse.
 */
export function postgresUri(parts: {
  host: string
  port: number
  database: string
  username: string
  password: string
  sslmode?: string
}): string {
  const auth = `${encodeURIComponent(parts.username)}:${encodeURIComponent(parts.password)}`
  const query = parts.sslmode === undefined ? "" : `?sslmode=${parts.sslmode}`
  return `postgresql://${auth}@${parts.host}:${parts.port}/${parts.database}${query}`
}

/**
 * Real Postgres identifiers, derived from ids rather than from anything a customer typed.
 *
 * A customer's service name goes in `backend_service.name` and stays there. What reaches a `CREATE
 * ROLE` statement is derived from the service's UUID, so the identifier is bounded, unique, and
 * contains nothing that has to be escaped. Interpolating a customer string into DDL — which cannot
 * be parameterized — is how this goes wrong.
 */
const PREFIX = "sprout"

/** Postgres truncates identifiers at 63 bytes; both of these are 39, well inside it. */
export function databaseNameFor(backendServiceId: string): string {
  return `${PREFIX}_db_${compact(backendServiceId)}`
}

export function roleNameFor(backendServiceId: string): string {
  return `${PREFIX}_r_${compact(backendServiceId)}`
}

function compact(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase()
}

/**
 * A UUID with the dashes stripped is 32 hex characters and nothing else, so an identifier built
 * from one cannot carry a quote, a semicolon, or a newline. Asserted rather than assumed, because
 * the value ends up in DDL.
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

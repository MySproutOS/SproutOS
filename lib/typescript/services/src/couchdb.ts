import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import { encodeShortId, generateSecret, hashGeneratedSecret, lastFour } from "./tenant-auth"
import { SecretNotRecoverableError } from "./valkey"
import type { ConnectionDetails, ProvisionInput, ProvisionResult, ServiceDriver } from "./types"

/**
 * CouchDB as a backend service.
 *
 * Added for a request that names the shape exactly: deploying `vrtmrz/obsidian-livesync`, whose
 * repository is an Obsidian plugin and whose deployable half is a CouchDB the plugin replicates
 * against. There is nothing to build and nothing to serve — what the customer needs is a database
 * and a URI, which is what `backend_service` has been for since TASK 37.
 *
 * ## No proxy, and that is a decision rather than an omission
 *
 * The other three kinds each sit behind one: `pg-proxy`, `valkey-proxy`, `search-proxy`. They exist
 * because Postgres roles, Valkey keyspaces and OpenSearch's OSS tier cannot enforce one customer's
 * boundary on their own — for OpenSearch the proxy *is* the security boundary, because
 * document-level security is a paid feature.
 *
 * CouchDB does not have that problem. A database carries a `_security` object naming its members,
 * `require_valid_user` refuses everything that is not one, and `_users` holds real per-user
 * credentials. The boundary is the server's own, and interposing a proxy would add a component that
 * can be wrong about a decision CouchDB is already making correctly.
 *
 * The consequence is that the username here is an ordinary CouchDB user, not the `db_x.y` tenant
 * username the proxied kinds use. That form exists so a proxy can read the tenant out of a startup
 * packet; nothing parses this one.
 *
 * ## What the client needs from the server
 *
 * Obsidian sends `Origin: app://obsidian.md` — a browser-shaped runtime that is not a web page — so
 * the instance has to answer CORS for it. That is server configuration, not something a driver can
 * paper over, and it lives in `deploy/standalone-db/couchdb.yaml` beside the reasons.
 */

export type CouchDbServiceConfig = {
  /** Where the control plane administers CouchDB. Not what a customer connects to. */
  adminUrl: string
  /** The host in a customer's URI. Public, because their client connects to it directly. */
  publicHost: string
  publicPort: number
  scheme: "http" | "https"
}

export function couchDbServiceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CouchDbServiceConfig {
  const adminUrl = env.SERVICE_COUCHDB_ADMIN_URL
  if (adminUrl === undefined || adminUrl === "") {
    throw new Error("SERVICE_COUCHDB_ADMIN_URL is not set; there is no CouchDB to provision on")
  }

  const publicHost = env.SERVICE_COUCHDB_PUBLIC_HOST
  if (publicHost === undefined || publicHost === "") {
    /*
      Refused rather than defaulted to the admin host.

      The same refusal `sproutPostgresConfigFromEnv` makes, for a reason that is sharper here: the
      admin URL carries CouchDB's *server administrator* credentials in its userinfo. Falling back
      to it would not merely bypass a boundary, it would hand the customer the keys to every other
      customer's database in their connection string.
    */
    throw new Error(
      "SERVICE_COUCHDB_PUBLIC_HOST is not set. It is the host a customer connects to; " +
        "defaulting it to the admin URL would put server-admin credentials in a tenant's URI.",
    )
  }

  return {
    adminUrl,
    publicHost,
    publicPort: Number(env.SERVICE_COUCHDB_PUBLIC_PORT ?? 443),
    // `https` unless told otherwise. Obsidian will not replicate against plaintext from a phone,
    // and a default of `http` is the kind that survives into production unnoticed.
    scheme: env.SERVICE_COUCHDB_SCHEME === "http" ? "http" : "https",
  }
}

/**
 * The database name for a service.
 *
 * CouchDB names must start with a lowercase letter and may contain only `a-z0-9_$()+/-`, so the
 * short id gets a prefix rather than being used bare — a ULID can begin with a digit, and CouchDB
 * rejects that with `illegal_database_name`, which reads like a bug in the caller.
 */
export function databaseNameFor(backendServiceId: string): string {
  return `db_${encodeShortId(backendServiceId)}`
}

/** The CouchDB user for a service. `_users` documents are keyed `org.couchdb.user:<name>`. */
export function userNameFor(backendServiceId: string): string {
  return `u_${encodeShortId(backendServiceId)}`
}

function userDocId(username: string): string {
  return `org.couchdb.user:${username}`
}

export class CouchDbError extends Error {
  override readonly name = "CouchDbError"

  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`CouchDB answered ${status} for ${path}: ${body.slice(0, 300)}`)
  }
}

export type CouchFetch = typeof fetch

/**
 * The role a suspended database is restricted to, which no account is ever granted.
 *
 * It exists because CouchDB has no "nobody": a `_security` block with an empty `members.names` and
 * an empty `members.roles` means *public to every authenticated user*, not private. Naming a role
 * that is never issued is how a database is closed to everyone while its data and its owner's
 * account stay exactly as they were.
 *
 * No leading underscore: CouchDB reserves that prefix, and a role it rejects would leave the
 * `_security` write failing on a path whose whole job is locking the database.
 */
export const SUSPENDED_ROLE = "sproutos_suspended"

/**
 * One request to CouchDB's admin interface.
 *
 * `404` is passed back rather than thrown for the callers that treat "already gone" as success —
 * `destroy` must be idempotent, because a retried teardown that throws on the second attempt leaves
 * a `backend_service` row nobody can delete.
 */
async function admin<T>(
  config: CouchDbServiceConfig,
  doFetch: CouchFetch,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T | undefined }> {
  const url = new URL(config.adminUrl)
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  url.username = ""
  url.password = ""

  const response = await doFetch(`${url.origin}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const text = await response.text()

  if (!response.ok && response.status !== 404) {
    throw new CouchDbError(response.status, path, text)
  }

  return {
    status: response.status,
    data: text === "" ? undefined : (JSON.parse(text) as T),
  }
}

export function couchDbDriver(
  db: Kysely<DB>,
  config: CouchDbServiceConfig,
  doFetch: CouchFetch = fetch,
): ServiceDriver {
  function details(backendServiceId: string): ConnectionDetails {
    return {
      host: config.publicHost,
      port: config.publicPort,
      database: databaseNameFor(backendServiceId),
      username: userNameFor(backendServiceId),
    }
  }

  function uriFor(backendServiceId: string, secret: string): string {
    const { host, port, database, username } = details(backendServiceId)
    // The port is omitted when it is the scheme's default, because a URI carrying `:443` is one a
    // customer will paste into a client that then fails to match a certificate.
    const authority =
      (config.scheme === "https" && port === 443) || (config.scheme === "http" && port === 80)
        ? host
        : `${host}:${port}`

    return `${config.scheme}://${encodeURIComponent(username)}:${encodeURIComponent(secret)}@${authority}/${database}`
  }

  /**
   * Write the user, the database, and the database's `_security` — in that order.
   *
   * The order is the isolation. A database created before its owner exists is, for the moment
   * between the two calls, a database with no `_security` object — and CouchDB treats that as
   * readable by any authenticated user. Creating the user first means the very first thing that
   * happens to the database is being locked to them.
   */
  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    const database = databaseNameFor(input.backendServiceId)
    const username = userNameFor(input.backendServiceId)
    const secret = generateSecret()

    await admin(config, doFetch, "PUT", `/_users/${encodeURIComponent(userDocId(username))}`, {
      name: username,
      password: secret,
      roles: [],
      type: "user",
    })

    await admin(config, doFetch, "PUT", `/${database}`)

    await admin(config, doFetch, "PUT", `/${database}/_security`, {
      // Members, not admins. A database admin can rewrite `_security` — including removing itself
      // or adding anyone else — which is not a power a tenant needs over their own database and is
      // exactly the power that would let one tenant open theirs to another.
      admins: { names: [], roles: [] },
      members: { names: [username], roles: [] },
    })

    await db
      .insertInto("serviceCredential")
      .values({
        id: v7(),
        backendServiceId: input.backendServiceId,
        username,
        secretHash: await hashGeneratedSecret(secret),
        lastFour: lastFour(secret),
        purpose: "tenant",
      })
      .execute()

    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", input.backendServiceId)
      .execute()

    return {
      ...details(input.backendServiceId),
      connectionUri: uriFor(input.backendServiceId, secret),
    }
  }

  /** Always throws: the secret is stored as a one-way hash. See `SecretNotRecoverableError`. */
  function connectionUri(backendServiceId: string): Promise<string> {
    return Promise.reject(new SecretNotRecoverableError(backendServiceId))
  }

  async function rotateCredentials(backendServiceId: string): Promise<string> {
    const username = userNameFor(backendServiceId)
    const secret = generateSecret()
    const docPath = `/_users/${encodeURIComponent(userDocId(username))}`

    // `_rev` is required to update a document, and reading it first is the only way to have one.
    // A blind PUT answers 409, which reads as a conflict with another writer rather than as a
    // missing revision.
    const existing = await admin<{ _rev?: string }>(config, doFetch, "GET", docPath)

    await admin(config, doFetch, "PUT", docPath, {
      name: username,
      password: secret,
      roles: [],
      type: "user",
      ...(existing.data?._rev === undefined ? {} : { _rev: existing.data._rev }),
    })

    await db
      .updateTable("serviceCredential")
      .set({ revokedAt: new Date() })
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .execute()

    await db
      .insertInto("serviceCredential")
      .values({
        id: v7(),
        backendServiceId,
        username,
        secretHash: await hashGeneratedSecret(secret),
        lastFour: lastFour(secret),
        purpose: "tenant",
      })
      .execute()

    return uriFor(backendServiceId, secret)
  }

  /**
   * Suspend by replacing the member list with a role nobody holds.
   *
   * **Not by emptying it**, which was the first attempt and is the opposite of a suspension.
   * CouchDB treats a database whose `members.names` *and* `members.roles` are both empty as public
   * to every authenticated user — the same rule that makes the ordering in `provision` matter. So
   * emptying the list did not lock the database, it opened it to every other tenant on the server,
   * and the integration test caught it by finding the owner could still read after being suspended.
   *
   * A non-empty `members` makes CouchDB enforce membership, and no account is ever granted
   * `SUSPENDED_ROLE`, so the answer is 403 for everyone including the owner. The user document and
   * the data are untouched, which is what makes `resume` a single call.
   *
   * Not by deleting the user or changing their password: both destroy the thing `resume` restores,
   * and the customer's URI has to keep working afterwards.
   *
   * `backend_service.status` is set too, because that is the column the rest of the platform reads —
   * the Postgres driver set only its own detail table and its suspensions did nothing at all.
   */
  async function suspend(backendServiceId: string): Promise<void> {
    await admin(config, doFetch, "PUT", `/${databaseNameFor(backendServiceId)}/_security`, {
      admins: { names: [], roles: [] },
      members: { names: [], roles: [SUSPENDED_ROLE] },
    })

    await db
      .updateTable("backendService")
      .set({ status: "suspended", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function resume(backendServiceId: string): Promise<void> {
    await admin(config, doFetch, "PUT", `/${databaseNameFor(backendServiceId)}/_security`, {
      admins: { names: [], roles: [] },
      members: { names: [userNameFor(backendServiceId)], roles: [] },
    })

    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function destroy(backendServiceId: string): Promise<void> {
    const username = userNameFor(backendServiceId)
    const docPath = `/_users/${encodeURIComponent(userDocId(username))}`

    await admin(config, doFetch, "DELETE", `/${databaseNameFor(backendServiceId)}`)

    const existing = await admin<{ _rev?: string }>(config, doFetch, "GET", docPath)
    if (existing.data?._rev !== undefined) {
      await admin(config, doFetch, "DELETE", `${docPath}?rev=${existing.data._rev}`)
    }

    await db
      .updateTable("serviceCredential")
      .set({ revokedAt: new Date() })
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .execute()
  }

  return {
    kind: "couchdb",
    connectionUri,
    destroy,
    details: (id) => Promise.resolve(details(id)),
    provision,
    resume,
    rotateCredentials,
    suspend,
  }
}

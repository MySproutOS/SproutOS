import type { DB } from "@sproutos/db"
import type { Kysely, Transaction } from "kysely"
import { v7 } from "uuid"
import {
  encodeShortId,
  generateSecret,
  hashGeneratedSecret,
  lastFour,
  tenantUsername,
} from "./tenant-auth"
import {
  type ConnectionDetails,
  type CredentialOwner,
  type ProvisionInput,
  type ProvisionResult,
  ServiceNotProvisionedError,
  type ServiceDriver,
  ServiceNotConfiguredError,
} from "./types"
import {
  deleteValkeyAclUser,
  enqueueValkeyAclRevocation,
  lockValkeyAclUser,
  type ValkeyAclRevocation,
} from "./valkey-revocation"

/**
 * A Valkey service, which is a credential and nothing else.
 *
 * There is no server to create. Every tenant shares one Valkey instance and is separated by a
 * hash-tagged key prefix that `services/valkey-proxy` applies to every command — so provisioning is
 * exactly: mint a username, mint a secret, store the hash the proxy will check against. The first
 * command the tenant sends creates their first key, and nothing existed before it.
 *
 * That is the whole cost argument for TASK 20. A Valkey per project would be a container per
 * project sitting idle between jobs; a prefix per project is a few dozen bytes.
 *
 * **The stored secret is one-way**, unlike `database_role.password_ciphertext`. Postgres needs the
 * plaintext to create a real role on a real server. Nothing outside our process needs a Valkey
 * secret: the proxy *is* the authenticator, so it only ever answers "does this match".
 *
 * The consequence is that `connectionUri` cannot exist as written — see below.
 */

export type ValkeyServiceConfig = {
  /** What goes in the tenant's URI: the proxy, never the shared Valkey behind it. */
  publicHost: string
  publicPort: number
  /** `rediss` where the proxy terminates TLS. Local development is plain `redis`. */
  scheme?: "redis" | "rediss"
  /** Administrator endpoint used only to remove derived ACL users during credential revocation. */
  adminUrl: string
}

export function valkeyServiceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ValkeyServiceConfig {
  const host = env.SERVICE_VALKEY_PUBLIC_HOST
  if (host === undefined || host === "") {
    throw new ServiceNotConfiguredError("SERVICE_VALKEY_PUBLIC_HOST", "valkey")
  }
  const adminUrl = env.SERVICE_VALKEY_ADMIN_URL
  if (adminUrl === undefined || adminUrl === "") {
    throw new ServiceNotConfiguredError("SERVICE_VALKEY_ADMIN_URL", "valkey")
  }
  return {
    adminUrl,
    publicHost: host,
    publicPort: Number(env.SERVICE_VALKEY_PUBLIC_PORT ?? 6379),
    scheme: env.SERVICE_VALKEY_SCHEME === "redis" ? "redis" : "rediss",
  }
}

/**
 * Thrown by `connectionUri`, always.
 *
 * A caller reaching for it wants to show a tenant their URI again, and that is not something this
 * driver can do: the secret was hashed, so it is not recoverable by us or by anyone who steals the
 * table. `rotateCredentials` is the answer, and it is a different answer — the old URI stops
 * working — which is why this is an error the caller has to handle rather than a silent rotation.
 */
export class SecretNotRecoverableError extends Error {
  override readonly name = "SecretNotRecoverableError"

  constructor(readonly backendServiceId: string) {
    super(
      `The secret for backend service ${backendServiceId} is stored as a one-way hash and cannot be revealed. Rotate it to get a new connection URI.`,
    )
  }
}

/**
 * Build a Valkey connection URI.
 *
 * The username and secret are percent-encoded even though neither can contain a character that
 * means anything in a URI — both are drawn from a 32-character alphabet with no `@`, `/` or `#`.
 * Encoding them anyway costs nothing and means a future change to either alphabet cannot silently
 * produce a URI that parses to the wrong host.
 */
export function valkeyUri(parts: {
  scheme: "redis" | "rediss"
  host: string
  port: number
  username: string
  secret: string
}): string {
  const auth = `${encodeURIComponent(parts.username)}:${encodeURIComponent(parts.secret)}`
  return `${parts.scheme}://${auth}@${parts.host}:${parts.port}`
}

/** The prefix BullMQ must receive so keys constructed inside Lua remain tenant-scoped. */
export function valkeyKeyPrefix(backendServiceId: string): string {
  return `{kv:${encodeShortId(backendServiceId)}}:bull`
}

async function valkeyCredentialGeneration(trx: Transaction<DB>, username: string): Promise<string> {
  return (
    await trx
      .selectFrom("serviceCredential")
      .select("id")
      .where("username", "=", username)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow()
  ).id
}

async function finishRevocation(
  trx: Transaction<DB>,
  revocation: ValkeyAclRevocation,
): Promise<void> {
  await trx
    .updateTable("backgroundJob")
    .set({ finishedAt: new Date(), state: "succeeded", updatedAt: new Date() })
    .where("id", "=", revocation.jobId)
    .execute()
}

function revocationError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Valkey ACL deletion failed", { cause })
}

/**
 * The Valkey driver, and one capability beyond `ServiceDriver`.
 *
 * Returned as an intersection rather than as `ServiceDriver` so `issueWorkerCredential` survives to
 * callers. Widening the interface instead would mean the Postgres and search drivers implementing a
 * method for workers they do not have.
 */
export function valkeyDriver(
  db: Kysely<DB>,
  config: ValkeyServiceConfig,
): ServiceDriver & { issueWorkerCredential: (backendServiceId: string) => Promise<string> } {
  const scheme = config.scheme ?? "rediss"

  async function locate(backendServiceId: string) {
    const row = await db
      .selectFrom("serviceCredential")
      .innerJoin("backendService", "backendService.id", "serviceCredential.backendServiceId")
      .select([
        "serviceCredential.id as id",
        "serviceCredential.username as username",
        "serviceCredential.lastFour as lastFour",
        "backendService.organizationId as organizationId",
      ])
      .where("backendServiceId", "=", backendServiceId)
      .where("purpose", "=", "tenant")
      .where("revokedAt", "is", null)
      .executeTakeFirst()

    if (row === undefined) throw new ServiceNotProvisionedError(backendServiceId)
    return row
  }

  async function latestTenantCredential(backendServiceId: string) {
    const row = await db
      .selectFrom("serviceCredential")
      .innerJoin("backendService", "backendService.id", "serviceCredential.backendServiceId")
      .select([
        "serviceCredential.id as id",
        "serviceCredential.username as username",
        "backendService.organizationId as organizationId",
      ])
      .where("backendServiceId", "=", backendServiceId)
      .where("purpose", "=", "tenant")
      .orderBy("serviceCredential.id", "desc")
      .executeTakeFirst()
    if (row === undefined) throw new ServiceNotProvisionedError(backendServiceId)
    return row
  }

  function detailsFor(backendServiceId: string, username: string): ConnectionDetails {
    return {
      host: config.publicHost,
      port: config.publicPort,
      // Valkey Cluster has database 0 and nothing else, which is why tenancy here is a key prefix
      // rather than a numbered database. `0` is the only honest answer.
      database: "0",
      username,
      keyPrefix: valkeyKeyPrefix(backendServiceId),
    }
  }

  async function issue(
    backendServiceId: string,
    username: string,
    purpose: "tenant" | "worker" = "tenant",
    owner?: CredentialOwner,
  ): Promise<string> {
    const secret = generateSecret()

    await db
      .insertInto("serviceCredential")
      .values({
        id: v7(),
        backendServiceId,
        username,
        purpose,
        secretHash: await hashGeneratedSecret(secret),
        lastFour: lastFour(secret),
        oauthGrantId: owner?.oauthGrantId ?? null,
      })
      .execute()

    return secret
  }

  /**
   * A credential for a worker the platform runs on the customer's behalf.
   *
   * Distinct from the customer's, and the distinction is the whole point. The platform cannot reuse
   * the customer's — `service_credential` stores a hash, so there is nothing to reuse — and until
   * `purpose` existed it could not issue a second one either, because one live credential per
   * username was the constraint.
   *
   * So a worker gets its own: revocable without touching the customer's application, attributable in
   * `last_used_at`, and issued at the moment a worker is needed rather than captured in passing.
   *
   * Returns the URI once, like `provision` does, because the secret is hashed on the way in and this
   * is the only moment it exists. The caller writes it where the worker will read it.
   */
  async function issueWorkerCredential(backendServiceId: string): Promise<string> {
    const service = await db
      .selectFrom("backendService")
      .select(["organizationId"])
      .where("id", "=", backendServiceId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (service === undefined) throw new ServiceNotProvisionedError(backendServiceId)

    const username = tenantUsername({
      organizationId: service.organizationId,
      kind: "queue",
      resourceId: backendServiceId,
    })

    /*
      Revoke the previous worker credential first.

      `service_credential_live_username_purpose_key` permits one live row per purpose, so leaving the
      old one would fail the insert. Revoking rather than deleting keeps the audit trail, and the
      order matters: a worker whose pod is still running loses its connection the moment this
      commits, which is why the caller restarts it with the new URI.
    */
    const secret = generateSecret()
    const secretHash = await hashGeneratedSecret(secret)
    const outcome = await db.transaction().execute(async (trx) => {
      await lockValkeyAclUser(trx, username)
      const previous = await trx
        .selectFrom("serviceCredential")
        .select("id")
        .where("backendServiceId", "=", backendServiceId)
        .where("purpose", "=", "worker")
        .where("revokedAt", "is", null)
        .executeTakeFirst()

      if (previous !== undefined) {
        const cutoff = await valkeyCredentialGeneration(trx, username)
        await trx
          .updateTable("serviceCredential")
          .set({ revokedAt: new Date() })
          .where("id", "=", previous.id)
          .execute()
        const revocation = await enqueueValkeyAclRevocation(trx, {
          generationId: cutoff,
          organizationId: service.organizationId,
          username,
        })
        try {
          await deleteValkeyAclUser(config.adminUrl, username)
          await finishRevocation(trx, revocation)
        } catch (error) {
          return { error }
        }
      }

      await trx
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId,
          username,
          purpose: "worker",
          secretHash,
          lastFour: lastFour(secret),
        })
        .execute()
      return {}
    })
    if (outcome.error !== undefined) throw revocationError(outcome.error)

    return valkeyUri({
      scheme,
      host: config.publicHost,
      port: config.publicPort,
      username,
      secret,
    })
  }

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    const username = tenantUsername({
      organizationId: input.organizationId,
      kind: "queue",
      resourceId: input.backendServiceId,
    })
    const secret = await issue(input.backendServiceId, username, "tenant", input.credentialOwner)

    return {
      ...detailsFor(input.backendServiceId, username),
      connectionUri: valkeyUri({
        scheme,
        host: config.publicHost,
        port: config.publicPort,
        username,
        secret,
      }),
    }
  }

  async function connectionUri(backendServiceId: string): Promise<string> {
    // Not a stub: revealing it is impossible by construction, and saying so is the correct
    // behaviour. See SecretNotRecoverableError.
    await locate(backendServiceId)
    throw new SecretNotRecoverableError(backendServiceId)
  }

  async function details(backendServiceId: string): Promise<ConnectionDetails> {
    return detailsFor(backendServiceId, (await locate(backendServiceId)).username)
  }

  async function rotateCredentials(backendServiceId: string, owner?: CredentialOwner) {
    const existing = await latestTenantCredential(backendServiceId)

    /*
      Revoke the old credential, then insert the new one, in one transaction.

      There is no window: a concurrent proxy lookup runs outside this transaction and by MVCC sees
      either the state before it or the state after it, never the moment in between. The order is
      forced rather than chosen — `service_credential_live_username_key` is a *partial* unique
      index, so Postgres evaluates it per statement and cannot defer it to commit (DEFERRABLE needs
      a constraint, and a constraint cannot be partial). Inserting first raises a duplicate key on
      the spot.

      The old secret therefore stops working the instant this commits, with no grace period. That
      is the intended behaviour and not a limitation to work around: rotation exists to recover
      from a leaked credential, and a leaked credential that keeps working for another ten minutes
      has not been recovered from.
    */
    const fresh = generateSecret()
    const freshHash = await hashGeneratedSecret(fresh)
    const outcome = await db.transaction().execute(async (trx) => {
      await lockValkeyAclUser(trx, existing.username)
      const cutoff = await valkeyCredentialGeneration(trx, existing.username)
      let revoke = trx
        .updateTable("serviceCredential")
        .set({ revokedAt: new Date() })
        .where("backendServiceId", "=", backendServiceId)
        .where("purpose", "=", "tenant")
        .where("revokedAt", "is", null)
      revoke =
        owner?.oauthGrantId == null
          ? revoke.where("oauthGrantId", "is", null)
          : revoke.where("oauthGrantId", "=", owner.oauthGrantId)
      await revoke.execute()
      const revocation = await enqueueValkeyAclRevocation(trx, {
        generationId: cutoff,
        organizationId: existing.organizationId,
        username: existing.username,
      })
      try {
        await deleteValkeyAclUser(config.adminUrl, existing.username)
      } catch (error) {
        return { error }
      }
      await trx
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId,
          // Deliberately the same username: it encodes which tenant this is, so changing it would
          // change which keyspace the connection lands in.
          username: existing.username,
          secretHash: freshHash,
          lastFour: lastFour(fresh),
          oauthGrantId: owner?.oauthGrantId ?? null,
        })
        .execute()
      await finishRevocation(trx, revocation)
      return {}
    })
    if (outcome.error !== undefined) throw revocationError(outcome.error)

    return {
      connectionUri: valkeyUri({
        scheme,
        host: config.publicHost,
        port: config.publicPort,
        username: existing.username,
        secret: fresh,
      }),
      keyPrefix: valkeyKeyPrefix(backendServiceId),
    }
  }

  async function suspend(backendServiceId: string): Promise<void> {
    // Revoking the credential is the whole suspension: the proxy refuses the next connection, and
    // the tenant's keys are untouched. There is no server to stop.
    const outcome = await db.transaction().execute(async (trx) => {
      const credentials = await trx
        .selectFrom("serviceCredential")
        .innerJoin("backendService", "backendService.id", "serviceCredential.backendServiceId")
        .select([
          "serviceCredential.id as id",
          "serviceCredential.username as username",
          "backendService.organizationId as organizationId",
        ])
        .where("serviceCredential.backendServiceId", "=", backendServiceId)
        .where("serviceCredential.revokedAt", "is", null)
        .orderBy("serviceCredential.id", "desc")
        .execute()

      let error: unknown
      const newest = credentials[0]
      if (newest !== undefined) {
        await lockValkeyAclUser(trx, newest.username)
        await trx
          .updateTable("serviceCredential")
          .set({ revokedAt: new Date() })
          .where("backendServiceId", "=", backendServiceId)
          .where("revokedAt", "is", null)
          .execute()
        const revocation = await enqueueValkeyAclRevocation(trx, {
          generationId: newest.id,
          organizationId: newest.organizationId,
          username: newest.username,
        })
        try {
          await deleteValkeyAclUser(config.adminUrl, newest.username)
          await finishRevocation(trx, revocation)
        } catch (cause) {
          error = cause
        }
      }

      await trx
        .updateTable("backendService")
        .set({ status: "suspended", updatedAt: new Date() })
        .where("id", "=", backendServiceId)
        .execute()
      return { error }
    })
    if (outcome.error !== undefined) {
      console.error("[valkey] ACL deletion failed; durable retry queued", outcome.error)
    }
  }

  async function destroy(backendServiceId: string): Promise<void> {
    await suspend(backendServiceId)

    /*
      The keys themselves are not deleted here.

      Everything under `{kv:<short-id>}:` is unreachable the moment the credential is revoked — the
      prefix is derived from the service id and no other tenant can name it. Scanning a shared
      instance to delete them would mean `SCAN` over every tenant's keyspace, which is the one
      operation this proxy refuses on principle. A reaper job walks the prefix out of band; that is
      TASK 20's dispatcher work, and this driver marking the service deleted is what tells it to.
    */
    await db
      .updateTable("backendService")
      .set({ status: "deleting", deletedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function recoverProvision(input: ProvisionInput): Promise<ProvisionResult> {
    try {
      const service = await details(input.backendServiceId)
      return {
        ...service,
        ...(await rotateCredentials(input.backendServiceId, input.credentialOwner)),
      }
    } catch (error) {
      // A Valkey service has no provider mutation: the durable credential row is the resource.
      if (!(error instanceof ServiceNotProvisionedError)) throw error
      return await provision(input)
    }
  }

  return {
    kind: "valkey",
    connectionUri,
    destroy,
    details,
    /*
      Not part of `ServiceDriver`.

      Only a queue has workers the platform runs, so this is on the Valkey driver rather than in the
      interface every kind implements. Putting it in the interface would mean two drivers throwing
      "not supported" for a capability their kind does not have — the shape that makes an interface
      describe nothing.
    */
    issueWorkerCredential,
    provision,
    recoverProvision,
    rotateCredentials,
    suspend,
  }
}

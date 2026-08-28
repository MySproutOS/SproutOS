import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import { generateSecret, hashGeneratedSecret, lastFour, tenantUsername } from "./tenant-auth"
import {
  type ConnectionDetails,
  type CredentialOwner,
  type ProvisionInput,
  type ProvisionResult,
  ServiceNotProvisionedError,
  type ServiceDriver,
  ServiceNotConfiguredError,
} from "./types"
import { SecretNotRecoverableError } from "./valkey"

/**
 * A search service, which — like Valkey — is a credential and nothing else.
 *
 * > TASK 33: we can also utilize Elasticsearch as an offering, and make it tenant split such that
 * > an Elasticsearch database shares resources with others.
 *
 * There is no cluster to create. Every tenant shares one OpenSearch cluster and is separated by an
 * index-name prefix that `services/search-proxy` applies to every request, so provisioning is: mint
 * a username, mint a secret, store the hash the proxy checks against. The tenant's first
 * `PUT /products` creates their first index, and nothing existed before it.
 *
 * **No index is created up front.** OpenSearch creates one on first write, and creating an empty
 * index per customer would cost a shard — the resource that actually runs out on a shared cluster —
 * for a customer who may never index a document.
 */

export type SearchServiceConfig = {
  /** What goes in the tenant's URI: the proxy, never the cluster behind it. */
  publicHost: string
  publicPort: number
  scheme?: "http" | "https"
}

export function searchServiceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SearchServiceConfig {
  const host = env.SERVICE_SEARCH_PUBLIC_HOST
  if (host === undefined || host === "") {
    throw new ServiceNotConfiguredError("SERVICE_SEARCH_PUBLIC_HOST", "elasticsearch")
  }
  return {
    publicHost: host,
    publicPort: Number(env.SERVICE_SEARCH_PUBLIC_PORT ?? 9200),
    scheme: env.SERVICE_SEARCH_SCHEME === "http" ? "http" : "https",
  }
}

/**
 * Build a search connection URI.
 *
 * The username and secret go in the userinfo because that is what every Elasticsearch and
 * OpenSearch client reads out of a URL — `new Client({ node: uri })` in the JS client, `hosts=[uri]`
 * in Python. Both are percent-encoded even though neither can contain a character that means
 * anything in a URI, so a future change to either alphabet cannot silently produce a URI that
 * parses to the wrong host.
 */
export function searchUri(parts: {
  scheme: "http" | "https"
  host: string
  port: number
  username: string
  secret: string
}): string {
  const auth = `${encodeURIComponent(parts.username)}:${encodeURIComponent(parts.secret)}`
  return `${parts.scheme}://${auth}@${parts.host}:${parts.port}`
}

export function searchDriver(db: Kysely<DB>, config: SearchServiceConfig): ServiceDriver {
  const scheme = config.scheme ?? "https"

  async function locate(backendServiceId: string, owner?: CredentialOwner) {
    const row = await db
      .selectFrom("serviceCredential")
      .select(["id", "username", "lastFour"])
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .$if(owner !== undefined, (query) =>
        owner?.oauthGrantId === null
          ? query.where("oauthGrantId", "is", null)
          : query.where("oauthGrantId", "=", owner!.oauthGrantId),
      )
      .executeTakeFirst()

    if (row === undefined) throw new ServiceNotProvisionedError(backendServiceId)
    return row
  }

  function detailsFor(username: string): ConnectionDetails {
    return {
      host: config.publicHost,
      port: config.publicPort,
      /*
        There is no "database" in OpenSearch, and inventing one would be a field a customer tries to
        use. The empty string says so; the index namespace is applied by the proxy and is not
        something the tenant configures.
      */
      database: "",
      username,
    }
  }

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    const username = tenantUsername({
      organizationId: input.organizationId,
      kind: "searchIndex",
      resourceId: input.backendServiceId,
    })
    const secret = generateSecret()

    await db
      .insertInto("serviceCredential")
      .values({
        id: v7(),
        backendServiceId: input.backendServiceId,
        username,
        secretHash: await hashGeneratedSecret(secret),
        lastFour: lastFour(secret),
        oauthGrantId: input.credentialOwner?.oauthGrantId ?? null,
      })
      .execute()

    return {
      ...detailsFor(username),
      connectionUri: searchUri({
        scheme,
        host: config.publicHost,
        port: config.publicPort,
        username,
        secret,
      }),
    }
  }

  async function connectionUri(backendServiceId: string): Promise<string> {
    // Impossible by construction, not unimplemented: the secret is a one-way hash. See
    // SecretNotRecoverableError.
    await locate(backendServiceId)
    throw new SecretNotRecoverableError(backendServiceId)
  }

  async function details(backendServiceId: string): Promise<ConnectionDetails> {
    return detailsFor((await locate(backendServiceId)).username)
  }

  async function rotateCredentials(backendServiceId: string, owner?: CredentialOwner) {
    const existing = await locate(backendServiceId)

    /*
      Revoke, then insert, in one transaction — the same order and the same reason as the Valkey
      driver: `service_credential_live_username_key` is a *partial* unique index, so Postgres
      evaluates it per statement and cannot defer it to commit. Inside one transaction there is no
      window a concurrent lookup can observe.

      The username does not change. It encodes which index namespace the connection lands in, so a
      rotation that changed it would hand the tenant a URI pointing at an empty cluster.
    */
    const secret = await db.transaction().execute(async (trx) => {
      const fresh = generateSecret()
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
      await trx
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId,
          username: existing.username,
          secretHash: await hashGeneratedSecret(fresh),
          lastFour: lastFour(fresh),
          oauthGrantId: owner?.oauthGrantId ?? null,
        })
        .execute()
      return fresh
    })

    return {
      connectionUri: searchUri({
        scheme,
        host: config.publicHost,
        port: config.publicPort,
        username: existing.username,
        secret,
      }),
    }
  }

  async function suspend(backendServiceId: string): Promise<void> {
    // Revoking the credential is the whole suspension: the proxy refuses the next request and the
    // tenant's indices are untouched.
    await db
      .updateTable("serviceCredential")
      .set({ revokedAt: new Date() })
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .execute()

    await db
      .updateTable("backendService")
      .set({ status: "suspended", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function destroy(backendServiceId: string): Promise<void> {
    await suspend(backendServiceId)

    /*
      The indices themselves are not deleted here.

      Everything under the tenant's prefix is unreachable the moment the credential is revoked — the
      prefix derives from the service id and no other tenant can name it. Deleting them is a
      `DELETE <prefix>*` against the cluster, which is a real operation the reaper does out of band:
      doing it inline would make a delete request wait on shard removal, and a failure halfway would
      leave the service marked deleted with data still on disk and nothing scheduled to notice.

      Unlike Valkey, this one genuinely must happen: an abandoned index holds shards, and shards are
      the resource a shared cluster runs out of.
    */
    await db
      .updateTable("backendService")
      .set({ status: "deleting", deletedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  return {
    kind: "elasticsearch",
    connectionUri,
    destroy,
    details,
    provision,
    rotateCredentials,
    suspend,
  }
}

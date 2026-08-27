import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import {
  ACCESS_KEY_PREFIX,
  deriveObjectStorageSecret,
  encodeShortId,
  hashGeneratedSecret,
  lastFour,
  objectStorageAccessKeyId,
} from "./tenant-auth"
import type { ConnectionDetails, ProvisionInput, ProvisionResult, ServiceDriver } from "./types"

/**
 * S3-compatible object storage as a backend service.
 *
 * The second way to run `obsidian-livesync`: it replicates against either a CouchDB or a bucket, and
 * a bucket is nobody's server to run. For a customer syncing a vault between a laptop and a phone
 * that is the cheaper and duller option, which is usually the right one.
 *
 * ## The customer never receives a cloud credential
 *
 * This is the rule every backend service here follows and object storage is not an exception:
 * **a tenant reaches their data through a proxy that knows who they are, never through the
 * underlying system directly.** `pg-proxy` does it for Postgres, `valkey-proxy` for queues,
 * `search-proxy` for OpenSearch, and `services/storage-proxy` does it here.
 *
 * The earlier version of this file handed the customer a real AWS access key scoped by an IAM policy
 * to one bucket. That works, and it was wrong for the same reason a per-tenant CouchDB admin was
 * wrong: the boundary was a policy document on somebody else's system, so every question about
 * whether one customer can see another's vault became a question about whether that policy was
 * written correctly — and about whether the platform still agrees with what IAM was told months ago.
 * A credential this platform issued, checked by a process this platform runs, against a row in this
 * platform's database, is a boundary that can be reasoned about in one place.
 *
 * It also removes a ceiling nobody would have found until it hit: an AWS account allows 5,000 IAM
 * users, so the previous design supported 5,000 object-storage services and then stopped.
 *
 * ## What the customer gets
 *
 * An endpoint pointing at the storage proxy, a bucket name, and a `SPROUT…` access key with a
 * derived secret. Their client signs SigV4 exactly as it would against AWS — `livesync` cannot tell
 * the difference, which is the point — and the proxy verifies that signature, checks the service is
 * active and the bucket is theirs, and re-signs the request with the platform's own credential
 * before forwarding it.
 *
 * The secret is *derived*, not stored: see {@link deriveObjectStorageSecret} for why that leaves
 * `service_credential` with nothing reversible in it.
 *
 * ## The protocol is portable; the backing store is not
 *
 * AWS S3, GCS's XML API, MinIO, R2 and LocalStack all speak S3, and `S3Client` talks to all of them
 * given an endpoint. Because the customer now talks to the proxy rather than to any of those, moving
 * a service between clouds no longer means reissuing the customer's credential.
 */

export type ObjectStorageConfig = {
  /** The S3 endpoint *this process* uses. Omitted for real AWS, where the SDK derives it. */
  endpoint?: string
  region: string
  /**
   * The endpoint a *customer* is given: `services/storage-proxy`.
   *
   * Never the bucket's own address. A customer pointed at S3 directly would be authenticating to
   * AWS with a key AWS has never heard of, and the failure would look like a wrong password rather
   * than like a misconfiguration.
   */
  publicEndpoint: string
  /**
   * Path-style addressing, i.e. `endpoint/bucket` rather than `bucket.endpoint`.
   *
   * Always true for the proxy — it is one hostname serving every tenant, and virtual-host style
   * would ask the resolver for `v-01abc….storage.example.com`, a name nobody created. `livesync`
   * exposes the same switch as `force_path_style`, and the value handed to the customer has to
   * match what the endpoint actually answers on.
   */
  forcePathStyle: boolean
  /**
   * The root key the tenant secret is derived from. Shared with the proxy and nothing else.
   *
   * Held here rather than per-tenant in the database on purpose — {@link deriveObjectStorageSecret}
   * explains the trade.
   */
  rootKey: string
}

export function objectStorageConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorageConfig {
  const region = env.SERVICE_OBJECT_STORAGE_REGION ?? env.AWS_REGION
  if (region === undefined || region === "") {
    throw new Error("SERVICE_OBJECT_STORAGE_REGION is not set; S3 needs a region")
  }

  const endpoint = env.SERVICE_OBJECT_STORAGE_ENDPOINT ?? env.AWS_ENDPOINT_URL
  const publicEndpoint = env.SERVICE_OBJECT_STORAGE_PUBLIC_ENDPOINT

  if (publicEndpoint === undefined || publicEndpoint === "") {
    throw new Error(
      "SERVICE_OBJECT_STORAGE_PUBLIC_ENDPOINT is not set. It is the address of the storage proxy, " +
        "which is the only thing a customer is ever given; it has no sensible default, and " +
        "falling back to the bucket's own endpoint would hand out a credential AWS will reject.",
    )
  }

  const rootKey = env.SERVICE_OBJECT_STORAGE_ROOT_KEY
  if (rootKey === undefined || rootKey === "") {
    throw new Error(
      "SERVICE_OBJECT_STORAGE_ROOT_KEY is not set. Every tenant's S3 secret is derived from it, " +
        "so a default would make every deployment's credentials identical and guessable.",
    )
  }

  return {
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
    region,
    publicEndpoint,
    rootKey,
    // Defaults on, and off is almost certainly a mistake now that the endpoint is the proxy.
    forcePathStyle: env.SERVICE_OBJECT_STORAGE_PATH_STYLE !== "false",
  }
}

/**
 * The bucket for a service.
 *
 * S3 bucket names are DNS labels: lowercase, 3–63 characters, no underscores, and they may not
 * start with a digit under strict validation. The short id is 26 characters of lowercase base32, so
 * `v-` plus it is 28 and always starts with a letter.
 *
 * The proxy computes this name from the service it resolved the access key to, and compares it with
 * the bucket in the request path. That comparison is the tenant boundary.
 */
export function bucketNameFor(backendServiceId: string): string {
  return `v-${encodeShortId(backendServiceId)}`
}

/**
 * The origins a vault client sends.
 *
 * Obsidian is not a web page: desktop sends `app://obsidian.md` and mobile sends
 * `capacitor://localhost`. An endpoint that does not name them refuses the preflight, and the plugin
 * reports a failure the customer cannot tell from a wrong key.
 *
 * Set on the bucket *and* answered by the proxy. The bucket's own CORS configuration is no longer
 * what a browser sees — the proxy is the origin now — but leaving it correct means a bucket stays
 * usable if it is ever addressed directly by an operator.
 */
export const VAULT_ORIGINS = ["app://obsidian.md", "capacitor://localhost", "http://localhost"]

/**
 * What the platform's own credential may do to a tenant bucket.
 *
 * No longer attached to a per-tenant IAM user — there are none. It is kept because it is the exact
 * set of operations the proxy is allowed to perform on a customer's behalf, and `tofu/` attaches it
 * to the proxy's role scoped to the bucket prefix. Two statements because the bucket and its
 * contents are different ARNs: `ListBucket` on `bucket/*` silently matches nothing.
 */
export function bucketPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetBucketLocation", "s3:ListBucket"],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  })
}

/** A credential the customer uses against the proxy. */
export type BucketCredential = { accessKeyId: string; secretAccessKey: string }

/**
 * The credential for one service at one version.
 *
 * Pure. There is nothing to call and nothing to fail: the identity is the service id, the secret
 * falls out of the root key, and the only durable record is the `service_credential` row the driver
 * writes so that a revoked version can be told from a live one.
 */
export async function tenantCredential(
  rootKey: string,
  backendServiceId: string,
  version: number,
): Promise<BucketCredential> {
  const accessKeyId = objectStorageAccessKeyId(backendServiceId, version)
  return { accessKeyId, secretAccessKey: await deriveObjectStorageSecret(rootKey, accessKeyId) }
}

/** The version encoded in an access key id, or 0 if it is not one of ours. */
export function versionOf(accessKeyId: string): number {
  if (!accessKeyId.startsWith(ACCESS_KEY_PREFIX)) return 0
  const version = Number(accessKeyId.slice(-2))
  return Number.isInteger(version) ? version : 0
}

/**
 * The connection string for a vault.
 *
 * `sls+s3://<key>:<secret>@<host>?endpoint=&bucket=&region=&pathStyle=` — **not a shape this
 * platform invented.** It is `obsidian-livesync`'s own `ConnectionStringParser` grammar, which its
 * settings dialog and its CLI's `remote-add` both accept, so a customer copies one string out of the
 * dashboard and pastes it into one field.
 *
 * The first version of this emitted an ad-hoc `https://host?accessKeyId=…&secretAccessKey=…`. It
 * carried the same information and no client could read it, so setting a vault up meant taking the
 * URI apart by hand into five settings — for a product whose premise is that people should not have
 * to know how any of this works. That was found by driving the real CLI: assembling the string it
 * wanted, by hand, was the step that should not have existed.
 *
 * Verified against the real client, not against a reading of its source: `livesync-vault.test.ts`
 * builds this string, hands it to the CLI's `remote-add`, and syncs a note between two vaults.
 *
 * Every field is still named and legible, so somebody pointing `rclone` at it can read the endpoint,
 * bucket and keys straight out — the scheme prefix is the only part specific to one client.
 *
 * `pathStyle` is written only when *false*, because the parser defaults it to true
 * (`get("pathStyle") !== "false"`), and a redundant parameter is one more thing to get wrong.
 */
export function objectStorageUri(input: {
  publicEndpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}): string {
  const endpoint = new URL(input.publicEndpoint)
  // Built on the endpoint's own host so the credentials land in the userinfo the parser reads them
  // from, then the endpoint is repeated as a parameter — which is the grammar, not a redundancy:
  // the parser falls back to `https://<host>` when `endpoint` is absent, and would turn a plain
  // `http` endpoint into an `https` one nothing is listening on.
  const url = new URL(`sls+s3://${endpoint.host}`)
  url.username = encodeURIComponent(input.accessKeyId)
  url.password = encodeURIComponent(input.secretAccessKey)
  url.searchParams.set("endpoint", input.publicEndpoint)
  url.searchParams.set("bucket", input.bucket)
  url.searchParams.set("region", input.region)
  if (!input.forcePathStyle) url.searchParams.set("pathStyle", "false")
  return url.toString()
}

/**
 * The fields inside an {@link objectStorageUri}, for a caller that needs them apart.
 *
 * `new URL()` handles `sls+s3:` — it is a valid scheme — but treats it as opaque, so the host and
 * userinfo are not parsed out. This does what the plugin's parser does: swap in a hierarchical
 * scheme, read the parts, and put nothing back.
 */
export function parseObjectStorageUri(uri: string): {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
} {
  const url = new URL(uri.replace(/^sls\+s3:/, "https:"))
  return {
    endpoint: url.searchParams.get("endpoint") ?? `https://${url.host}`,
    bucket: url.searchParams.get("bucket") ?? "",
    region: url.searchParams.get("region") ?? "auto",
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
    forcePathStyle: url.searchParams.get("pathStyle") !== "false",
  }
}

export function objectStorageDriver(
  db: Kysely<DB>,
  config: ObjectStorageConfig,
  s3: S3Client,
): ServiceDriver {
  function details(backendServiceId: string, accessKeyId: string): ConnectionDetails {
    const endpoint = new URL(config.publicEndpoint)
    return {
      host: endpoint.host,
      port: Number(
        endpoint.port === "" ? (endpoint.protocol === "https:" ? 443 : 80) : endpoint.port,
      ),
      database: bucketNameFor(backendServiceId),
      username: accessKeyId,
    }
  }

  /**
   * The next credential version for a service.
   *
   * Read from the highest version ever issued, including revoked ones, so a rotation never reuses an
   * identifier a client might still be retrying with — which would silently make a revoked key work
   * again.
   */
  async function nextVersion(backendServiceId: string): Promise<number> {
    const issued = await db
      .selectFrom("serviceCredential")
      .select("username")
      .where("backendServiceId", "=", backendServiceId)
      .execute()

    return Math.max(0, ...issued.map((row) => versionOf(row.username))) + 1
  }

  async function issue(backendServiceId: string): Promise<BucketCredential> {
    const credential = await tenantCredential(
      config.rootKey,
      backendServiceId,
      await nextVersion(backendServiceId),
    )

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
        username: credential.accessKeyId,
        // Hashed, not sealed. The proxy re-derives the secret from the root key; this row exists so
        // that a *revoked* version can be recognised, and so the stored shape matches every other
        // credential kind.
        secretHash: await hashGeneratedSecret(credential.secretAccessKey),
        lastFour: lastFour(credential.secretAccessKey),
        purpose: "tenant",
      })
      .execute()

    return credential
  }

  function uriFor(backendServiceId: string, credential: BucketCredential): string {
    return objectStorageUri({
      publicEndpoint: config.publicEndpoint,
      bucket: bucketNameFor(backendServiceId),
      region: config.region,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
    })
  }

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    const bucket = bucketNameFor(input.backendServiceId)

    await s3.send(new CreateBucketCommand({ Bucket: bucket }))

    /*
      CORS before the credential, so the bucket is never briefly usable and unreachable.

      Obsidian is a browser-shaped runtime: without these origins its preflight fails inside the
      plugin's own fetch, and the customer sees "cannot connect" with nothing in any log. Upstream's
      MinIO script carries the same rule, commented out, with their test harness's localhost ports.
    */
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: VAULT_ORIGINS,
              AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
              AllowedHeaders: ["*"],
              // The plugin reads `ETag` to decide what changed. Without it the header is stripped
              // from the cross-origin response and every object looks new.
              ExposeHeaders: ["ETag", "Content-Length"],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      }),
    )

    const credential = await issue(input.backendServiceId)

    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", input.backendServiceId)
      .execute()

    return {
      ...details(input.backendServiceId, credential.accessKeyId),
      connectionUri: uriFor(input.backendServiceId, credential),
    }
  }

  /**
   * The live connection URI, reconstructed rather than stored.
   *
   * The one place where deriving the secret buys something beyond safety: every other driver here
   * has to answer this with {@link SecretNotRecoverableError}, because it only ever held a hash. A
   * customer who loses their key can be shown it again without a rotation that breaks the device
   * still holding the old one.
   */
  async function connectionUri(backendServiceId: string): Promise<string> {
    const live = await db
      .selectFrom("serviceCredential")
      .select("username")
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .orderBy("createdAt", "desc")
      .executeTakeFirst()

    if (live === undefined) {
      throw new Error(`${backendServiceId} has no live object-storage credential`)
    }

    return uriFor(backendServiceId, {
      accessKeyId: live.username,
      secretAccessKey: await deriveObjectStorageSecret(config.rootKey, live.username),
    })
  }

  async function rotateCredentials(backendServiceId: string) {
    return { connectionUri: uriFor(backendServiceId, await issue(backendServiceId)) }
  }

  /**
   * Suspension is a row, not a permission change.
   *
   * The same correction Postgres needed. Revoking access at the cloud provider means the platform's
   * belief about a service and the provider's belief are two facts that can disagree, and the one
   * the customer experiences is the provider's. The proxy reads `backend_service.status` on the way
   * through, so this is the only place the answer lives.
   */
  async function suspend(backendServiceId: string): Promise<void> {
    await db
      .updateTable("backendService")
      .set({ status: "suspended", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function resume(backendServiceId: string): Promise<void> {
    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  /**
   * Empty the bucket, then delete it.
   *
   * S3 refuses to delete a bucket with anything in it, so a teardown that skips the emptying leaves
   * a bucket the customer is still billed for and a `backend_service` row nobody can delete. The
   * listing is paged because a vault is thousands of objects and `ListObjectsV2` returns a thousand.
   */
  async function destroy(backendServiceId: string): Promise<void> {
    const bucket = bucketNameFor(backendServiceId)

    for (;;) {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }))
      const keys = (listed.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [{ Key: object.Key }],
      )
      if (keys.length === 0) break

      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }))
      if (listed.IsTruncated !== true) break
    }

    await s3.send(new DeleteBucketCommand({ Bucket: bucket }))

    /*
      Revoking the rows is what actually ends access.

      A derived secret cannot be deleted — it is a function of the root key and an identifier that
      still exists. So the proxy's lookup is the revocation: no live `service_credential` row means
      no tenant to resolve, whatever the customer's client still has saved.
    */
    await db
      .updateTable("serviceCredential")
      .set({ revokedAt: new Date() })
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .execute()
  }

  return {
    kind: "object_storage",
    connectionUri,
    destroy,
    details: async (id) => {
      const live = await db
        .selectFrom("serviceCredential")
        .select("username")
        .where("backendServiceId", "=", id)
        .where("revokedAt", "is", null)
        .orderBy("createdAt", "desc")
        .executeTakeFirst()

      return details(id, live?.username ?? objectStorageAccessKeyId(id, 1))
    },
    provision,
    resume,
    rotateCredentials,
    suspend,
  }
}

/** The driver, wired from the environment. */
export function objectStorageDriverFromEnv(db: Kysely<DB>): ServiceDriver {
  const config = objectStorageConfigFromEnv()

  return objectStorageDriver(
    db,
    config,
    new S3Client({
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      forcePathStyle: true,
    }),
  )
}

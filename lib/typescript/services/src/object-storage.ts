import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  IAMClient,
  ListAccessKeysCommand,
  PutUserPolicyCommand,
} from "@aws-sdk/client-iam"
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
import { encodeShortId, hashGeneratedSecret, lastFour } from "./tenant-auth"
import { SecretNotRecoverableError } from "./valkey"
import type { ConnectionDetails, ProvisionInput, ProvisionResult, ServiceDriver } from "./types"

/**
 * S3-compatible object storage as a backend service.
 *
 * The second way to run `obsidian-livesync`: it replicates against either a CouchDB or a bucket, and
 * a bucket is nobody's server to run. For a customer syncing a vault between a laptop and a phone
 * that is the cheaper and duller option, which is usually the right one.
 *
 * ## One bucket per service, not one prefix per tenant
 *
 * A shared bucket with a per-tenant prefix needs every credential to carry a prefix condition, and
 * a policy that is one `Condition` block away from letting one customer list another's vault. A
 * bucket is the boundary S3 was built around: the policy below is scoped to a bucket ARN and cannot
 * name another one.
 *
 * It is also exactly the policy upstream's own MinIO setup script writes — `GetBucketLocation` and
 * `ListBucket` on the bucket, `GetObject`/`PutObject`/`DeleteObject` on its contents — so a
 * credential issued here grants what the plugin needs and nothing else.
 *
 * ## The protocol is portable; the credential is not
 *
 * AWS S3, GCS's XML API, MinIO, R2 and LocalStack all speak S3, and `S3Client` talks to all of them
 * given an endpoint. What differs per cloud is *issuing a scoped credential*: IAM users and access
 * keys on AWS, HMAC keys on a service account for GCS, `mc admin user add` for MinIO. That is why
 * issuance is behind an interface and the storage half is not.
 */

export type ObjectStorageConfig = {
  /** The S3 endpoint. Omitted for real AWS, where the SDK derives it from the region. */
  endpoint?: string
  region: string
  /**
   * The endpoint a *customer* is given, which is not always the one this process uses.
   *
   * Inside a cluster the control plane may reach MinIO at `http://minio.sproutos-system:9000` while
   * the customer's Obsidian reaches it at `https://storage.example.com`. Defaulting the second to
   * the first is how a customer receives a URL that resolves only from inside the platform.
   */
  publicEndpoint: string
  /**
   * Path-style addressing, i.e. `endpoint/bucket` rather than `bucket.endpoint`.
   *
   * Required for MinIO and LocalStack, and required for *any* endpoint without a wildcard DNS
   * record — virtual-host style asks the resolver for a hostname nobody created. `livesync` exposes
   * the same switch as `force_path_style`, and the value handed to the customer has to match what
   * the bucket actually answers on.
   */
  forcePathStyle: boolean
}

export function objectStorageConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ObjectStorageConfig {
  const region = env.SERVICE_OBJECT_STORAGE_REGION ?? env.AWS_REGION
  if (region === undefined || region === "") {
    throw new Error("SERVICE_OBJECT_STORAGE_REGION is not set; S3 needs a region")
  }

  const endpoint = env.SERVICE_OBJECT_STORAGE_ENDPOINT ?? env.AWS_ENDPOINT_URL
  const publicEndpoint = env.SERVICE_OBJECT_STORAGE_PUBLIC_ENDPOINT ?? endpoint

  if (publicEndpoint === undefined || publicEndpoint === "") {
    throw new Error(
      "SERVICE_OBJECT_STORAGE_PUBLIC_ENDPOINT is not set. It is the endpoint a customer's client " +
        "connects to; defaulting it to the one this process uses hands out an in-cluster address.",
    )
  }

  return {
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
    region,
    publicEndpoint,
    // Defaults on. Off is correct only for real AWS S3 with its wildcard DNS, and getting it wrong
    // in that direction produces a hostname that does not resolve rather than a 403 — a failure the
    // customer reads as "the platform is down".
    forcePathStyle: env.SERVICE_OBJECT_STORAGE_PATH_STYLE !== "false",
  }
}

/**
 * The bucket for a service.
 *
 * S3 bucket names are DNS labels: lowercase, 3–63 characters, no underscores, and they may not
 * start with a digit under strict validation. The short id is 26 characters of lowercase base32, so
 * `v-` plus it is 28 and always starts with a letter.
 */
export function bucketNameFor(backendServiceId: string): string {
  return `v-${encodeShortId(backendServiceId)}`
}

/** The IAM user for a service. Distinct from the bucket so neither name constrains the other. */
export function principalNameFor(backendServiceId: string): string {
  return `sproutos-${encodeShortId(backendServiceId)}`
}

/**
 * The origins a vault client sends.
 *
 * Obsidian is not a web page: desktop sends `app://obsidian.md` and mobile sends
 * `capacitor://localhost`. A bucket that does not name them refuses the preflight, and the plugin
 * reports a failure the customer cannot tell from a wrong key.
 */
export const VAULT_ORIGINS = ["app://obsidian.md", "capacitor://localhost", "http://localhost"]

/**
 * What a bucket-scoped credential may do.
 *
 * Copied from upstream's own MinIO policy rather than invented, so a credential issued here grants
 * what the plugin uses and nothing more. Two statements because the bucket and its contents are
 * different ARNs — `ListBucket` on `bucket/*` silently matches nothing.
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

/** A credential scoped to one bucket. The half that differs per cloud. */
export type BucketCredential = { accessKeyId: string; secretAccessKey: string }

export type CredentialIssuer = {
  issue: (input: { principal: string; bucket: string }) => Promise<BucketCredential>
  /** Replace the credential, invalidating the previous one. */
  rotate: (input: { principal: string; bucket: string }) => Promise<BucketCredential>
  /** Take access away without destroying the bucket. */
  revoke: (input: { principal: string }) => Promise<void>
  /** Give it back. */
  restore: (input: { principal: string; bucket: string }) => Promise<void>
  destroy: (input: { principal: string }) => Promise<void>
}

/**
 * Credentials as IAM users with an inline bucket policy.
 *
 * Works against real AWS and against LocalStack, which is how it is tested. **It does not scale
 * without bound and that is worth saying here rather than discovering it**: an AWS account allows
 * 5,000 IAM users, so this supports 5,000 buckets and then stops. The replacement when that matters
 * is one role plus `AssumeRole` with a session policy, which issues short-lived credentials instead
 * — a different shape, because the customer's key would then expire and `livesync` stores a static
 * one.
 */
export function iamCredentialIssuer(client: IAMClient): CredentialIssuer {
  async function freshKey(principal: string): Promise<BucketCredential> {
    // Two keys per user is the IAM limit, so the old one goes before the new one is asked for.
    const existing = await client.send(new ListAccessKeysCommand({ UserName: principal }))
    for (const key of existing.AccessKeyMetadata ?? []) {
      if (key.AccessKeyId !== undefined) {
        await client.send(
          new DeleteAccessKeyCommand({ UserName: principal, AccessKeyId: key.AccessKeyId }),
        )
      }
    }

    const created = await client.send(new CreateAccessKeyCommand({ UserName: principal }))
    const key = created.AccessKey

    if (key?.AccessKeyId === undefined || key.SecretAccessKey === undefined) {
      throw new Error(`IAM returned no access key for ${principal}`)
    }

    return { accessKeyId: key.AccessKeyId, secretAccessKey: key.SecretAccessKey }
  }

  async function attach(principal: string, bucket: string): Promise<void> {
    await client.send(
      new PutUserPolicyCommand({
        UserName: principal,
        PolicyName: "sproutos-bucket",
        PolicyDocument: bucketPolicy(bucket),
      }),
    )
  }

  return {
    issue: async ({ principal, bucket }) => {
      await client.send(new CreateUserCommand({ UserName: principal }))
      await attach(principal, bucket)
      return await freshKey(principal)
    },
    rotate: async ({ principal, bucket }) => {
      await attach(principal, bucket)
      return await freshKey(principal)
    },
    /*
      Revoke by removing the policy, not by deleting the key.

      The customer's URI carries the key, and `resume` has to leave that URI working — the same
      constraint the CouchDB driver has. A user with no policy can authenticate and do nothing,
      which is a suspension; a user with no key cannot authenticate, which is a rotation the
      customer was not told about.
    */
    revoke: async ({ principal }) => {
      await client.send(
        new DeleteUserPolicyCommand({ UserName: principal, PolicyName: "sproutos-bucket" }),
      )
    },
    restore: async ({ principal, bucket }) => {
      await attach(principal, bucket)
    },
    destroy: async ({ principal }) => {
      const existing = await client.send(new ListAccessKeysCommand({ UserName: principal }))
      for (const key of existing.AccessKeyMetadata ?? []) {
        if (key.AccessKeyId !== undefined) {
          await client.send(
            new DeleteAccessKeyCommand({ UserName: principal, AccessKeyId: key.AccessKeyId }),
          )
        }
      }
      await client
        .send(new DeleteUserPolicyCommand({ UserName: principal, PolicyName: "sproutos-bucket" }))
        .catch(() => undefined)
      await client.send(new DeleteUserCommand({ UserName: principal }))
    },
  }
}

/**
 * The connection details a vault client needs.
 *
 * Not a URI. `livesync` takes an endpoint, a region, a bucket and a key pair as separate fields, and
 * an `s3://key:secret@host/bucket` string would be a shape this platform invented for one screen to
 * immediately take apart again. `connectionUri` still exists because `ServiceDriver` has it, and it
 * returns the one form that is unambiguous.
 */
export function objectStorageUri(input: {
  publicEndpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}): string {
  const url = new URL(input.publicEndpoint)
  url.searchParams.set("bucket", input.bucket)
  url.searchParams.set("region", input.region)
  url.searchParams.set("accessKeyId", input.accessKeyId)
  url.searchParams.set("secretAccessKey", input.secretAccessKey)
  url.searchParams.set("forcePathStyle", String(input.forcePathStyle))
  return url.toString()
}

export function objectStorageDriver(
  db: Kysely<DB>,
  config: ObjectStorageConfig,
  issuer: CredentialIssuer,
  s3: S3Client,
): ServiceDriver {
  function details(backendServiceId: string): ConnectionDetails {
    const endpoint = new URL(config.publicEndpoint)
    return {
      host: endpoint.host,
      port: Number(
        endpoint.port === "" ? (endpoint.protocol === "https:" ? 443 : 80) : endpoint.port,
      ),
      database: bucketNameFor(backendServiceId),
      username: principalNameFor(backendServiceId),
    }
  }

  async function recordCredential(
    backendServiceId: string,
    credential: BucketCredential,
  ): Promise<void> {
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
        secretHash: await hashGeneratedSecret(credential.secretAccessKey),
        lastFour: lastFour(credential.secretAccessKey),
        purpose: "tenant",
      })
      .execute()
  }

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    const bucket = bucketNameFor(input.backendServiceId)
    const principal = principalNameFor(input.backendServiceId)

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

    const credential = await issuer.issue({ principal, bucket })
    await recordCredential(input.backendServiceId, credential)

    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", input.backendServiceId)
      .execute()

    return {
      ...details(input.backendServiceId),
      connectionUri: objectStorageUri({
        publicEndpoint: config.publicEndpoint,
        bucket,
        region: config.region,
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        forcePathStyle: config.forcePathStyle,
      }),
    }
  }

  function connectionUri(backendServiceId: string): Promise<string> {
    return Promise.reject(new SecretNotRecoverableError(backendServiceId))
  }

  async function rotateCredentials(backendServiceId: string): Promise<string> {
    const bucket = bucketNameFor(backendServiceId)
    const credential = await issuer.rotate({
      principal: principalNameFor(backendServiceId),
      bucket,
    })
    await recordCredential(backendServiceId, credential)

    return objectStorageUri({
      publicEndpoint: config.publicEndpoint,
      bucket,
      region: config.region,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      forcePathStyle: config.forcePathStyle,
    })
  }

  async function suspend(backendServiceId: string): Promise<void> {
    await issuer.revoke({ principal: principalNameFor(backendServiceId) })
    await db
      .updateTable("backendService")
      .set({ status: "suspended", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function resume(backendServiceId: string): Promise<void> {
    await issuer.restore({
      principal: principalNameFor(backendServiceId),
      bucket: bucketNameFor(backendServiceId),
    })
    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  /**
   * Empty the bucket, then delete it, then the principal.
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
    await issuer.destroy({ principal: principalNameFor(backendServiceId) })

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
    details: (id) => Promise.resolve(details(id)),
    provision,
    resume,
    rotateCredentials,
    suspend,
  }
}

/** The driver, wired from the environment. */
export function objectStorageDriverFromEnv(db: Kysely<DB>): ServiceDriver {
  const config = objectStorageConfigFromEnv()
  const shared = {
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
  }

  return objectStorageDriver(
    db,
    config,
    iamCredentialIssuer(new IAMClient(shared)),
    new S3Client({ ...shared, forcePathStyle: config.forcePathStyle }),
  )
}

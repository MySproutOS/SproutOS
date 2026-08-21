import { S3Client } from "@aws-sdk/client-s3"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import {
  bucketNameFor,
  bucketPolicy,
  objectStorageConfigFromEnv,
  objectStorageDriver,
  objectStorageUri,
  tenantCredential,
  VAULT_ORIGINS,
  versionOf,
} from "./object-storage"
import { deriveObjectStorageSecret } from "./tenant-auth"

/**
 * Object storage for a vault, against LocalStack's real S3.
 *
 * **What is deliberately not asserted here: that one tenant cannot read another's bucket.** That is
 * now `services/storage-proxy`'s job rather than an IAM policy's, and it is asserted where it is
 * enforced — `storage-proxy`'s own tests, which run the real binary against this same LocalStack.
 *
 * The previous version of this file had two isolation tests gated behind
 * `SERVICE_OBJECT_STORAGE_ENFORCES_IAM`, because IAM policy *evaluation* is a LocalStack Pro
 * feature and the free image accepts every IAM call while enforcing none of them. Those tests could
 * not run anywhere this project can afford to run, which meant the most important property of the
 * design was the one thing never checked. Moving the boundary into a process we own is what makes
 * it checkable.
 */
const config = (() => {
  try {
    return objectStorageConfigFromEnv()
  } catch {
    return undefined
  }
})()

const reachable = await (async () => {
  if (config?.endpoint === undefined) return false
  try {
    await sql`select 1`.execute(db)
    const response = await fetch(`${config.endpoint}/_localstack/health`)
    return response.ok
  } catch {
    return false
  }
})()

function s3Client() {
  return new S3Client({
    region: config!.region,
    endpoint: config!.endpoint,
    forcePathStyle: true,
  })
}

const fixtures: { organizations: string[]; users: string[]; services: string[] } = {
  organizations: [],
  users: [],
  services: [],
}

async function service() {
  const userId = v7()
  const organizationId = v7()
  const backendServiceId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `obj-${userId}@test.invalid` })
    .execute()
  fixtures.users.push(userId)
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Obj",
      slug: `obj-${organizationId}`,
      kind: "personal",
      ownerUserId: userId,
    })
    .execute()
  fixtures.organizations.push(organizationId)

  const region = await db.selectFrom("region").select("id").executeTakeFirstOrThrow()
  await db
    .insertInto("backendService")
    .values({
      id: backendServiceId,
      organizationId,
      projectId: null,
      regionId: region.id,
      name: "Vault",
      kind: "object_storage",
      status: "provisioning",
    })
    .execute()
  fixtures.services.push(backendServiceId)

  return { backendServiceId, organizationId }
}

afterAll(async () => {
  if (!reachable) return
  const driver = objectStorageDriver(db, config!, s3Client())
  for (const id of fixtures.services) await driver.destroy(id).catch(() => undefined)
  if (fixtures.services.length > 0) {
    await db.deleteFrom("backendService").where("id", "in", fixtures.services).execute()
  }
  if (fixtures.organizations.length > 0) {
    await db.deleteFrom("organization").where("id", "in", fixtures.organizations).execute()
  }
  if (fixtures.users.length > 0) {
    await db.deleteFrom("user").where("id", "in", fixtures.users).execute()
  }
  await db.destroy()
})

describe("naming and policy", () => {
  it("produces a bucket name S3 will accept", () => {
    // Bucket names are DNS labels: lowercase, 3–63 characters, no underscores, and strict
    // validation refuses a leading digit. A bare ULID can start with one.
    const name = bucketNameFor("01a02486-be04-776f-a9e2-c655b19e16b7")
    expect(name).toMatch(/^[a-z][a-z0-9-]{2,62}$/)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it("scopes the proxy's own policy to one bucket, in two statements", () => {
    /*
      Two, because the bucket and its contents are different ARNs — `ListBucket` on `bucket/*`
      silently matches nothing, and a policy that looks right then lists nothing at all.

      This is no longer attached to a per-tenant IAM user; there are none. It is the set of
      operations the proxy may perform on a customer's behalf, and `tofu/` grants it to the proxy's
      role. Keeping it narrow means a compromised proxy still cannot delete a vault wholesale.
    */
    const policy = JSON.parse(bucketPolicy("v-abc")) as {
      Statement: { Action: string[]; Resource: string[] }[]
    }

    expect(policy.Statement).toHaveLength(2)
    expect(policy.Statement[0]?.Resource).toEqual(["arn:aws:s3:::v-abc"])
    expect(policy.Statement[1]?.Resource).toEqual(["arn:aws:s3:::v-abc/*"])
    expect(policy.Statement.flatMap((s) => s.Action)).not.toContain("s3:*")
    expect(policy.Statement.flatMap((s) => s.Action)).not.toContain("s3:DeleteBucket")
  })

  it("carries every field the plugin asks for", () => {
    // `livesync` takes endpoint, region, bucket, keys and `force_path_style` as separate settings.
    // A URI missing one is a URI the customer has to guess the rest of.
    const uri = new URL(
      objectStorageUri({
        publicEndpoint: "https://storage.example.com",
        bucket: "v-abc",
        region: "us-east-1",
        accessKeyId: "SPROUT01",
        secretAccessKey: "shh",
        forcePathStyle: true,
      }),
    )

    expect(Object.fromEntries(uri.searchParams)).toEqual({
      bucket: "v-abc",
      region: "us-east-1",
      accessKeyId: "SPROUT01",
      secretAccessKey: "shh",
      forcePathStyle: "true",
    })
  })
})

describe("objectStorageConfigFromEnv", () => {
  it("refuses rather than pointing a customer at the bucket itself", () => {
    // The endpoint a customer receives is the proxy. Falling back to the one this process uses
    // would hand out a credential AWS has never heard of, and the failure would read as a wrong
    // password rather than as a misconfiguration.
    expect(() =>
      objectStorageConfigFromEnv({
        SERVICE_OBJECT_STORAGE_REGION: "us-east-1",
        SERVICE_OBJECT_STORAGE_ENDPOINT: "http://localhost:4566",
        SERVICE_OBJECT_STORAGE_ROOT_KEY: "k",
      }),
    ).toThrow(/PUBLIC_ENDPOINT/)
  })

  it("refuses to run without a root key rather than defaulting one", () => {
    // A default would make every deployment's tenant secrets identical, and derivable by anyone who
    // has read this repository.
    expect(() =>
      objectStorageConfigFromEnv({
        SERVICE_OBJECT_STORAGE_REGION: "us-east-1",
        SERVICE_OBJECT_STORAGE_PUBLIC_ENDPOINT: "https://storage.example.com",
      }),
    ).toThrow(/ROOT_KEY/)
  })
})

describe("derived credentials", () => {
  const serviceId = "01a02486-be04-776f-a9e2-c655b19e16b7"

  it("gives the platform back the same secret without having stored it", async () => {
    // The property the whole design rests on: the proxy can verify a SigV4 signature, and
    // `service_credential` still holds nothing reversible.
    const first = await tenantCredential("root", serviceId, 1)
    const second = await tenantCredential("root", serviceId, 1)

    expect(second).toEqual(first)
    expect(first.secretAccessKey).toBe(await deriveObjectStorageSecret("root", first.accessKeyId))
  })

  it("reads the version back out of an access key id", async () => {
    const seventh = await tenantCredential("root", serviceId, 7)

    expect(versionOf(seventh.accessKeyId)).toBe(7)
  })

  it("treats a foreign access key id as version zero", () => {
    // An `AKIA…` key belongs to AWS, not to us. Parsing a version out of it would place a stranger
    // in this service's rotation sequence.
    expect(versionOf("AKIAIOSFODNN7EXAMPLE")).toBe(0)
  })
})

describe.runIf(reachable)("a provisioned bucket", () => {
  it("names Obsidian's own origins in the bucket's CORS rules", async () => {
    /*
      Obsidian is not a web page: desktop sends `app://obsidian.md` and mobile
      `capacitor://localhost`. An endpoint that does not name them refuses the preflight, and the
      plugin reports a failure the customer cannot tell from a wrong key.

      The proxy answers CORS itself now — it is the origin the browser sees. This stays because a
      bucket addressed directly by an operator should still behave.
    */
    const driver = objectStorageDriver(db, config!, s3Client())
    const { backendServiceId, organizationId } = await service()

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "Vault" })

    const { GetBucketCorsCommand } = await import("@aws-sdk/client-s3")
    const cors = await s3Client().send(
      new GetBucketCorsCommand({ Bucket: bucketNameFor(backendServiceId) }),
    )

    const rule = cors.CORSRules?.[0]
    expect(rule?.AllowedOrigins).toEqual(VAULT_ORIGINS)
    // The plugin reads `ETag` to decide what changed; stripped, every object looks new.
    expect(rule?.ExposeHeaders).toContain("ETag")
  }, 90_000)

  it("points the customer at the proxy and never at the bucket", async () => {
    // The single assertion that says this is tenant-based. A customer holding the storage
    // endpoint holds a key that only the proxy can make sense of.
    const driver = objectStorageDriver(db, config!, s3Client())
    const { backendServiceId, organizationId } = await service()

    const provisioned = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })
    const uri = new URL(provisioned.connectionUri)

    expect(uri.origin).toBe(new URL(config!.publicEndpoint).origin)
    expect(uri.origin).not.toBe(new URL(config!.endpoint!).origin)
    expect(uri.searchParams.get("accessKeyId")).toMatch(/^SPROUT/)
  }, 90_000)

  it("stores a hash of a secret it never has to store", async () => {
    const driver = objectStorageDriver(db, config!, s3Client())
    const { backendServiceId, organizationId } = await service()

    const provisioned = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })
    const secret = new URL(provisioned.connectionUri).searchParams.get("secretAccessKey")!

    const stored = await db
      .selectFrom("serviceCredential")
      .select(["secretHash", "username"])
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .executeTakeFirstOrThrow()

    expect(stored.secretHash).not.toContain(secret)
    expect(stored.username).toBe(new URL(provisioned.connectionUri).searchParams.get("accessKeyId"))
  }, 90_000)

  it("shows the customer their key again without rotating it", async () => {
    /*
      The one capability deriving the secret buys beyond safety.

      Every other driver here answers `connectionUri` with `SecretNotRecoverableError`, because it
      only ever held a hash — so a customer who lost their key had to rotate, which breaks whatever
      device still had the old one. A vault synced across a laptop and a phone is exactly the case
      where that hurts.
    */
    const driver = objectStorageDriver(db, config!, s3Client())
    const { backendServiceId, organizationId } = await service()

    const provisioned = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })

    expect(await driver.connectionUri(backendServiceId)).toBe(provisioned.connectionUri)
  }, 90_000)

  it("rotates to a new version and revokes the old row", async () => {
    // Revocation is the row, because a derived secret cannot be deleted — it is a function of a key
    // and an identifier that both still exist. The proxy's lookup is what ends access.
    const driver = objectStorageDriver(db, config!, s3Client())
    const { backendServiceId, organizationId } = await service()

    const first = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })
    const second = await driver.rotateCredentials(backendServiceId)

    const before = new URL(first.connectionUri).searchParams.get("accessKeyId")!
    const after = new URL(second).searchParams.get("accessKeyId")!

    expect(versionOf(after)).toBe(versionOf(before) + 1)

    const rows = await db
      .selectFrom("serviceCredential")
      .select(["username", "revokedAt"])
      .where("backendServiceId", "=", backendServiceId)
      .execute()

    expect(rows.find((row) => row.username === before)?.revokedAt).not.toBeNull()
    expect(rows.find((row) => row.username === after)?.revokedAt).toBeNull()
  }, 90_000)

  it("never reissues an identifier a client might still be retrying with", async () => {
    // Reuse would silently make a revoked key work again, because the secret is a function of the
    // identifier. So the sequence is read from every version ever issued, not from the live one.
    const driver = objectStorageDriver(db, config!, s3Client())
    const { backendServiceId, organizationId } = await service()

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "Vault" })
    await driver.rotateCredentials(backendServiceId)
    await driver.rotateCredentials(backendServiceId)

    const usernames = await db
      .selectFrom("serviceCredential")
      .select("username")
      .where("backendServiceId", "=", backendServiceId)
      .execute()

    expect(new Set(usernames.map((row) => row.username)).size).toBe(usernames.length)
  }, 120_000)

  it("suspends by writing a row, not by asking the cloud to forget", async () => {
    /*
      The same correction Postgres needed. Revoking access at the provider means the platform's
      belief about a service and the provider's belief are two facts that can disagree, and the one
      the customer experiences is the provider's. The proxy reads `backend_service.status`.
    */
    const driver = objectStorageDriver(db, config!, s3Client())
    const { backendServiceId, organizationId } = await service()

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "Vault" })
    await driver.suspend(backendServiceId)

    const suspended = await db
      .selectFrom("backendService")
      .select("status")
      .where("id", "=", backendServiceId)
      .executeTakeFirstOrThrow()
    expect(suspended.status).toBe("suspended")

    // And the credential is untouched, so resuming leaves the customer's saved settings working.
    const live = await db
      .selectFrom("serviceCredential")
      .select("username")
      .where("backendServiceId", "=", backendServiceId)
      .where("revokedAt", "is", null)
      .executeTakeFirst()
    expect(live).toBeDefined()

    await driver.resume?.(backendServiceId)
    const resumed = await db
      .selectFrom("backendService")
      .select("status")
      .where("id", "=", backendServiceId)
      .executeTakeFirstOrThrow()
    expect(resumed.status).toBe("active")
  }, 120_000)

  it("empties the bucket before deleting it", async () => {
    // S3 refuses to delete a bucket with anything in it, so a teardown that skips this leaves a
    // bucket the customer is billed for and a row nobody can delete.
    const driver = objectStorageDriver(db, config!, s3Client())
    const { backendServiceId, organizationId } = await service()

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "Vault" })

    const { PutObjectCommand } = await import("@aws-sdk/client-s3")
    const bucket = bucketNameFor(backendServiceId)
    await s3Client().send(
      new PutObjectCommand({ Bucket: bucket, Key: "notes/left-behind.md", Body: "x" }),
    )

    await driver.destroy(backendServiceId)

    /*
      Asserted by listing, not by a failed HEAD.

      S3 answers `HeadBucket` on a missing bucket with a 404 carrying no body, so the SDK surfaces
      it as `UnknownError` — matching on that would be asserting how the SDK reports an empty
      response rather than that the bucket is gone.
    */
    const { ListBucketsCommand } = await import("@aws-sdk/client-s3")
    const remaining = await s3Client().send(new ListBucketsCommand({}))
    expect((remaining.Buckets ?? []).map((entry) => entry.Name)).not.toContain(bucket)
  }, 120_000)
})

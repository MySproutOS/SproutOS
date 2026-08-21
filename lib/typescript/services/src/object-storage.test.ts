import { S3Client } from "@aws-sdk/client-s3"
import { IAMClient } from "@aws-sdk/client-iam"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import {
  bucketNameFor,
  bucketPolicy,
  iamCredentialIssuer,
  objectStorageConfigFromEnv,
  objectStorageDriver,
  objectStorageUri,
  principalNameFor,
  VAULT_ORIGINS,
} from "./object-storage"
import { SecretNotRecoverableError } from "./valkey"

/**
 * Object storage for a vault, against LocalStack's real S3 and IAM.
 *
 * The interesting assertions are the two that decide whether this is usable and safe: the credential
 * is scoped to one bucket and cannot touch another, and the bucket answers Obsidian's preflight.
 * Both are things a fake would agree with whatever the code did.
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

function clients() {
  const shared = { region: config!.region, endpoint: config!.endpoint }
  return {
    s3: new S3Client({ ...shared, forcePathStyle: true }),
    iam: new IAMClient(shared),
  }
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
  const { s3, iam } = clients()
  const driver = objectStorageDriver(db, config!, iamCredentialIssuer(iam), s3)
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

  it("scopes the policy to one bucket, in two statements", () => {
    /*
      Two, because the bucket and its contents are different ARNs — `ListBucket` on `bucket/*`
      silently matches nothing, and a policy that looks right then lists nothing at all.

      Copied from upstream's own MinIO script so a credential grants what the plugin uses.
    */
    const policy = JSON.parse(bucketPolicy("v-abc")) as {
      Statement: { Action: string[]; Resource: string[] }[]
    }

    expect(policy.Statement).toHaveLength(2)
    expect(policy.Statement[0]?.Resource).toEqual(["arn:aws:s3:::v-abc"])
    expect(policy.Statement[1]?.Resource).toEqual(["arn:aws:s3:::v-abc/*"])
    expect(policy.Statement.flatMap((s) => s.Action)).not.toContain("s3:*")
    // No bucket-level destruction: a leaked key must not be able to delete the vault wholesale.
    expect(policy.Statement.flatMap((s) => s.Action)).not.toContain("s3:DeleteBucket")
  })

  it("carries every field the plugin asks for", () => {
    // `livesync` takes endpoint, region, bucket, keys and `force_path_style` as separate settings.
    // A URI missing one is a URI the customer has to guess the rest of.
    const uri = new URL(
      objectStorageUri({
        publicEndpoint: "https://s3.example.com",
        bucket: "v-abc",
        region: "us-east-1",
        accessKeyId: "AKIA",
        secretAccessKey: "shh",
        forcePathStyle: true,
      }),
    )

    expect(Object.fromEntries(uri.searchParams)).toEqual({
      bucket: "v-abc",
      region: "us-east-1",
      accessKeyId: "AKIA",
      secretAccessKey: "shh",
      forcePathStyle: "true",
    })
  })
})

describe("objectStorageConfigFromEnv", () => {
  it("refuses rather than handing out an in-cluster endpoint", () => {
    // The control plane may reach storage on a service DNS name a customer's laptop cannot resolve.
    expect(() =>
      objectStorageConfigFromEnv({ SERVICE_OBJECT_STORAGE_REGION: "us-east-1" }),
    ).toThrow(/PUBLIC_ENDPOINT/)
  })

  it("defaults to path style, which is wrong only for real AWS", () => {
    const resolved = objectStorageConfigFromEnv({
      SERVICE_OBJECT_STORAGE_REGION: "us-east-1",
      SERVICE_OBJECT_STORAGE_PUBLIC_ENDPOINT: "https://s3.example.com",
    })
    expect(resolved.forcePathStyle).toBe(true)
  })
})

describe.runIf(reachable)("a provisioned bucket", () => {
  it("hands back a credential that can write and read the vault", async () => {
    const { s3, iam } = clients()
    const driver = objectStorageDriver(db, config!, iamCredentialIssuer(iam), s3)
    const { backendServiceId, organizationId } = await service()

    const provisioned = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })

    const uri = new URL(provisioned.connectionUri)
    const tenant = new S3Client({
      region: config!.region,
      endpoint: config!.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: uri.searchParams.get("accessKeyId")!,
        secretAccessKey: uri.searchParams.get("secretAccessKey")!,
      },
    })

    const { PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3")
    const bucket = bucketNameFor(backendServiceId)

    await tenant.send(
      new PutObjectCommand({ Bucket: bucket, Key: "notes/one.md", Body: "# hello" }),
    )
    const read = await tenant.send(new GetObjectCommand({ Bucket: bucket, Key: "notes/one.md" }))

    expect(await read.Body?.transformToString()).toBe("# hello")
  }, 90_000)

  it("names Obsidian's own origins in the bucket's CORS rules", async () => {
    /*
      Obsidian is not a web page: desktop sends `app://obsidian.md` and mobile
      `capacitor://localhost`. A bucket that does not name them refuses the preflight, and the
      plugin reports a failure the customer cannot tell from a wrong key.
    */
    const { s3, iam } = clients()
    const driver = objectStorageDriver(db, config!, iamCredentialIssuer(iam), s3)
    const { backendServiceId, organizationId } = await service()

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "Vault" })

    const { GetBucketCorsCommand } = await import("@aws-sdk/client-s3")
    const cors = await s3.send(
      new GetBucketCorsCommand({ Bucket: bucketNameFor(backendServiceId) }),
    )

    const rule = cors.CORSRules?.[0]
    expect(rule?.AllowedOrigins).toEqual(VAULT_ORIGINS)
    // The plugin reads `ETag` to decide what changed; stripped, every object looks new.
    expect(rule?.ExposeHeaders).toContain("ETag")
  }, 90_000)

  it("gives each vault a policy naming only its own bucket", async () => {
    /*
      The whole argument for a bucket per service rather than a shared bucket with prefixes.

      **Asserted on the policy document, not by attempting a cross-tenant read**, and the reason is
      worth knowing: LocalStack's free tier accepts IAM calls and does not evaluate policies, so
      every credential behaves as root there. A test that tried the read would pass on AWS and fail
      here — and one weakened until it passed here would assert nothing at all. Enforcement is AWS's
      and is covered by the skipped suite below; what this checks is that the policy we hand IAM
      names one bucket and cannot name another.
    */
    const { s3, iam } = clients()
    const driver = objectStorageDriver(db, config!, iamCredentialIssuer(iam), s3)

    const mine = await service()
    const theirs = await service()

    await driver.provision({ ...mine, projectId: null, name: "Mine" })
    await driver.provision({ ...theirs, projectId: null, name: "Theirs" })

    const { GetUserPolicyCommand } = await import("@aws-sdk/client-iam")
    const attached = await iam.send(
      new GetUserPolicyCommand({
        UserName: principalNameFor(theirs.backendServiceId),
        PolicyName: "sproutos-bucket",
      }),
    )

    const document = JSON.parse(decodeURIComponent(attached.PolicyDocument ?? "{}")) as {
      Statement: { Resource: string[] }[]
    }
    const resources = document.Statement.flatMap((statement) => statement.Resource)

    expect(resources.every((arn) => arn.includes(bucketNameFor(theirs.backendServiceId)))).toBe(
      true,
    )
    expect(resources.some((arn) => arn.includes(bucketNameFor(mine.backendServiceId)))).toBe(false)
  }, 90_000)

  it("stores a hash, and refuses to reveal the secret afterwards", async () => {
    const { s3, iam } = clients()
    const driver = objectStorageDriver(db, config!, iamCredentialIssuer(iam), s3)
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
    // The access key id, not the IAM user name: it is what identifies the credential to S3.
    expect(stored.username).toBe(new URL(provisioned.connectionUri).searchParams.get("accessKeyId"))
    await expect(driver.connectionUri(backendServiceId)).rejects.toBeInstanceOf(
      SecretNotRecoverableError,
    )
  }, 90_000)

  it("suspends by removing the policy, leaving the customer's key intact", async () => {
    /*
      Revoked by removing the policy, not by deleting the key.

      The customer's URI carries the key and `resume` has to leave that URI working — the same
      constraint the CouchDB driver has. Deleting the key would be a rotation nobody was told about.

      Asserted on IAM's own state rather than by attempting a request, for the reason given above:
      the free LocalStack does not evaluate policies, so a suspended credential still works there.
    */
    const { s3, iam } = clients()
    const driver = objectStorageDriver(db, config!, iamCredentialIssuer(iam), s3)
    const { backendServiceId, organizationId } = await service()

    const provisioned = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })
    const keyBefore = new URL(provisioned.connectionUri).searchParams.get("accessKeyId")

    const { GetUserPolicyCommand, ListAccessKeysCommand } = await import("@aws-sdk/client-iam")
    const principal = principalNameFor(backendServiceId)

    await driver.suspend(backendServiceId)

    await expect(
      iam.send(new GetUserPolicyCommand({ UserName: principal, PolicyName: "sproutos-bucket" })),
    ).rejects.toThrow(/NoSuchEntity|cannot be found/)

    // The key survives, which is what makes the customer's URI still theirs afterwards.
    const keys = await iam.send(new ListAccessKeysCommand({ UserName: principal }))
    expect(keys.AccessKeyMetadata?.[0]?.AccessKeyId).toBe(keyBefore)

    await driver.resume?.(backendServiceId)
    const restored = await iam.send(
      new GetUserPolicyCommand({ UserName: principal, PolicyName: "sproutos-bucket" }),
    )
    expect(decodeURIComponent(restored.PolicyDocument ?? "")).toContain(
      bucketNameFor(backendServiceId),
    )
  }, 120_000)

  it("empties the bucket before deleting it", async () => {
    // S3 refuses to delete a bucket with anything in it, so a teardown that skips this leaves a
    // bucket the customer is billed for and a row nobody can delete.
    const { s3, iam } = clients()
    const driver = objectStorageDriver(db, config!, iamCredentialIssuer(iam), s3)
    const { backendServiceId, organizationId } = await service()

    await driver.provision({ backendServiceId, organizationId, projectId: null, name: "Vault" })

    const { PutObjectCommand } = await import("@aws-sdk/client-s3")
    const bucket = bucketNameFor(backendServiceId)
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "notes/left-behind.md", Body: "x" }))

    await driver.destroy(backendServiceId)

    /*
      Asserted by listing, not by a failed HEAD.

      S3 answers `HeadBucket` on a missing bucket with a 404 carrying no body, so the SDK surfaces
      it as `UnknownError` — matching on that would be asserting how the SDK reports an empty
      response rather than that the bucket is gone.
    */
    const { ListBucketsCommand } = await import("@aws-sdk/client-s3")
    const remaining = await s3.send(new ListBucketsCommand({}))
    expect((remaining.Buckets ?? []).map((entry) => entry.Name)).not.toContain(bucket)
  }, 120_000)
})

/**
 * What only a real policy engine can answer.
 *
 * IAM policy *enforcement* is a LocalStack Pro feature — the free image accepts every IAM call and
 * evaluates no policy, so every credential behaves as root. These are the two assertions that would
 * prove isolation rather than describe it, and they are gated rather than rewritten until they
 * pass, because a test that passes for the wrong reason is worse than one that does not run.
 *
 * Set `SERVICE_OBJECT_STORAGE_ENFORCES_IAM=true` where the endpoint does enforce — real AWS, or
 * LocalStack Pro — and they run. `bin/check-skipped-tests.mjs` carries the count and the reason, so
 * a green suite here is never read as evidence that a tenant cannot reach another tenant's bucket.
 */
const enforces = reachable && process.env.SERVICE_OBJECT_STORAGE_ENFORCES_IAM === "true"

describe.runIf(enforces)("isolation, where policies are enforced", () => {
  function tenantClient(uri: string) {
    const parsed = new URL(uri)
    return new S3Client({
      region: config!.region,
      ...(config!.endpoint === undefined ? {} : { endpoint: config!.endpoint }),
      forcePathStyle: config!.forcePathStyle,
      credentials: {
        accessKeyId: parsed.searchParams.get("accessKeyId") ?? "",
        secretAccessKey: parsed.searchParams.get("secretAccessKey") ?? "",
      },
    })
  }

  it("refuses one vault's credential against another vault's bucket", async () => {
    const { s3, iam } = clients()
    const driver = objectStorageDriver(db, config!, iamCredentialIssuer(iam), s3)

    const mine = await service()
    const theirs = await service()
    await driver.provision({ ...mine, projectId: null, name: "Mine" })
    const intruder = await driver.provision({ ...theirs, projectId: null, name: "Theirs" })

    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3")
    const asIntruder = tenantClient(intruder.connectionUri)

    await expect(
      asIntruder.send(new ListObjectsV2Command({ Bucket: bucketNameFor(mine.backendServiceId) })),
    ).rejects.toThrow(/AccessDenied|Forbidden/)
  }, 120_000)

  it("refuses a suspended credential", async () => {
    const { s3, iam } = clients()
    const driver = objectStorageDriver(db, config!, iamCredentialIssuer(iam), s3)
    const { backendServiceId, organizationId } = await service()

    const provisioned = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })
    const tenant = tenantClient(provisioned.connectionUri)
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3")

    await driver.suspend(backendServiceId)
    await expect(
      tenant.send(new ListObjectsV2Command({ Bucket: bucketNameFor(backendServiceId) })),
    ).rejects.toThrow(/AccessDenied|Forbidden/)

    // And the same key works again afterwards, unchanged.
    await driver.resume?.(backendServiceId)
    await expect(
      tenant.send(new ListObjectsV2Command({ Bucket: bucketNameFor(backendServiceId) })),
    ).resolves.toBeDefined()
  }, 120_000)
})

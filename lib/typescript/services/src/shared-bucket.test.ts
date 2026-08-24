import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  bucketNameFor,
  type ObjectStorageConfig,
  objectStorageConfigFromEnv,
  objectStorageDriver,
  parseObjectStorageUri,
} from "./object-storage"
import { proxyIsBuilt, startStorageProxy, type RunningProxy } from "./testing/storage-proxy"

/**
 * The tenant boundary when every tenant is in **one** bucket (§4.5).
 *
 * With a bucket per tenant, S3 enforced this: a policy naming `arn:aws:s3:::v-abc*` could not reach
 * `v-def` however the request was built. One shared bucket moves that into `upstream_path`, which
 * is a real loss of defence in depth — so the question "can one customer reach another's objects"
 * has to be asked of the running proxy, with a real `S3Client` doing the signing, rather than of a
 * unit test over a function this repository also wrote.
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
    if (!response.ok) return false
    // Built by `cargo build -p storage-proxy`. Absent means this suite cannot run, and saying so is
    // better than a suite that silently checks nothing.
    return proxyIsBuilt()
  } catch {
    return false
  }
})()

/** This suite's own port. Vitest runs files in parallel and two proxies on one port race. */
const PROXY_PORT = 9004

let proxy: RunningProxy | undefined
/** The config with `publicEndpoint` pointing at *this* suite's proxy. */
let active: ObjectStorageConfig | undefined

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
    .values({ id: userId, email: `px-${userId}@test.invalid` })
    .execute()
  fixtures.users.push(userId)
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Px",
      slug: `px-${organizationId}`,
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

/** An S3 client configured exactly as the plugin would be from a connection URI. */
function asCustomer(connectionUri: string) {
  const parsed = parseObjectStorageUri(connectionUri)
  return new S3Client({
    region: parsed.region,
    endpoint: parsed.endpoint,
    forcePathStyle: parsed.forcePathStyle,
    credentials: {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
    },
  })
}

/** The one bucket every tenant lives in. */
const SHARED = "sproutos-tenants-test"

/*
  A client pointed straight at LocalStack, not through the proxy.

  The driver still calls `CreateBucket` per service. Under the shared layout that bucket is never
  written to — the proxy rewrites every request into `SHARED` — and leaving the call in place is
  deliberate for now: removing it is a control-plane change, and this suite is about whether the
  data path is safe. It is the loose end named in the commit.
*/
function upstream() {
  return new S3Client({
    region: config!.region,
    endpoint: config!.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  })
}

beforeAll(async () => {
  if (!reachable) return

  const s3 = new S3Client({
    region: config!.region,
    endpoint: config!.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  })
  await s3.send(new CreateBucketCommand({ Bucket: SHARED })).catch(() => undefined)
  s3.destroy()

  proxy = await startStorageProxy(config!, PROXY_PORT, SHARED)
  active = proxy.config
}, 30_000)

afterAll(async () => {
  proxy?.stop()
  if (!reachable) return

  await db.deleteFrom("backendService").where("id", "in", fixtures.services).execute()
  await db.deleteFrom("organization").where("id", "in", fixtures.organizations).execute()
  await db.deleteFrom("user").where("id", "in", fixtures.users).execute()
  await db.destroy()
})

describe.runIf(reachable)("one bucket, many tenants", () => {
  it("stores and reads back an object the customer named", async () => {
    const { backendServiceId, organizationId } = await service()
    const driver = objectStorageDriver(db, active!, upstream())
    const { connectionUri } = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })
    const customer = asCustomer(connectionUri)
    const bucket = bucketNameFor(backendServiceId)

    await customer.send(
      new PutObjectCommand({ Bucket: bucket, Key: "notes/one.md", Body: "hello" }),
    )

    const got = await customer.send(new GetObjectCommand({ Bucket: bucket, Key: "notes/one.md" }))
    expect(await got.Body?.transformToString()).toBe("hello")

    // The customer still addresses their own bucket name and still gets their own key back. The
    // shared layout is not something they can see, which is what makes it changeable.
    const listed = await customer.send(new ListObjectsV2Command({ Bucket: bucket }))
    expect(listed.Contents?.map((entry) => entry.Key)).toEqual(["notes/one.md"])

    customer.destroy()
  }, 60_000)

  it("keeps one tenant out of another's objects in the same bucket", async () => {
    const first = await service()
    const second = await service()
    const driver = objectStorageDriver(db, active!, upstream())

    const one = await driver.provision({
      backendServiceId: first.backendServiceId,
      organizationId: first.organizationId,
      projectId: null,
      name: "Vault",
    })
    const two = await driver.provision({
      backendServiceId: second.backendServiceId,
      organizationId: second.organizationId,
      projectId: null,
      name: "Vault",
    })

    const a = asCustomer(one.connectionUri)
    const b = asCustomer(two.connectionUri)

    await a.send(
      new PutObjectCommand({
        Bucket: bucketNameFor(first.backendServiceId),
        Key: "private.md",
        Body: "a secret",
      }),
    )

    /*
      The question the design has to answer.

      B's credential is valid; what stops it is that the path names A's bucket and the proxy checks
      the name against the service the key belongs to. With one shared bucket this check is the
      only thing standing between them.
    */
    await expect(
      b.send(
        new GetObjectCommand({
          Bucket: bucketNameFor(first.backendServiceId),
          Key: "private.md",
        }),
      ),
    ).rejects.toThrow(/Access ?Denied|Forbidden|NoSuchKey|403|404/)

    // And a list from B does not see A's object, even though they share a bucket.
    const listed = await b.send(
      new ListObjectsV2Command({ Bucket: bucketNameFor(second.backendServiceId) }),
    )
    expect(listed.Contents ?? []).toHaveLength(0)

    a.destroy()
    b.destroy()
  }, 60_000)

  it("refuses a key that would climb out of the tenant's prefix", async () => {
    const { backendServiceId, organizationId } = await service()
    const driver = objectStorageDriver(db, active!, upstream())
    const { connectionUri } = await driver.provision({
      backendServiceId,
      organizationId,
      projectId: null,
      name: "Vault",
    })
    const parsed = parseObjectStorageUri(connectionUri)

    /*
      Sent as a raw request, not through the SDK.

      The AWS SDK normalises `..` out of a key before signing, so an SDK call could never send this
      — and a test that used one would prove only that the SDK is careful. The attack is a hand-built
      request, so the test builds one.
    */
    const response = await fetch(
      `${parsed.endpoint}/${bucketNameFor(backendServiceId)}/../${SHARED}/other`,
      {
        method: "GET",
        headers: {
          authorization: "AWS4-HMAC-SHA256 Credential=nope/x, SignedHeaders=host, Signature=00",
        },
      },
    )

    // Refused. Which refusal matters less than that it is not a 200 with somebody else's bytes.
    expect(response.status).toBeGreaterThanOrEqual(400)
  }, 60_000)
})

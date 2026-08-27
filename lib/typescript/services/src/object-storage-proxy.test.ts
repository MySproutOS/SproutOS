import {
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
 * The tenant boundary, exercised end to end against the real proxy.
 *
 * **This is the test the previous design could not have.** Isolation used to be an IAM policy, and
 * IAM policy *evaluation* is a LocalStack Pro feature — so the two assertions that would have proved
 * one customer cannot read another's vault were gated behind an environment variable nobody could
 * set, and the most important property of the design was the one thing never checked.
 *
 * Now the boundary is a process in this repository. It can be started, pointed at LocalStack, and
 * asked the question directly — with a real `S3Client` doing the signing, so what is verified is the
 * signature an actual AWS SDK produces rather than one this repository also wrote.
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

/**
 * This suite's own port, distinct from `livesync-vault.test.ts`'s.
 *
 * Vitest runs test files in parallel; two suites on one port means the second proxy exits while the
 * first still answers, and the second suite asserts against a process it did not configure.
 */
const PROXY_PORT = 9002

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

beforeAll(async () => {
  if (!reachable) return

  proxy = await startStorageProxy(config!, PROXY_PORT)
  active = proxy.config
}, 30_000)

afterAll(async () => {
  proxy?.stop()
  if (!reachable) return

  const s3 = new S3Client({
    region: config!.region,
    endpoint: config!.endpoint,
    forcePathStyle: true,
  })
  const driver = objectStorageDriver(db, active ?? config!, s3)
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

describe.runIf(reachable)("through the storage proxy", () => {
  function driver() {
    return objectStorageDriver(
      db,
      active!,
      new S3Client({ region: config!.region, endpoint: config!.endpoint, forcePathStyle: true }),
    )
  }

  async function vault(name: string) {
    const created = await service()
    const provisioned = await driver().provision({ ...created, projectId: null, name })
    return { ...created, uri: provisioned.connectionUri }
  }

  it("refuses an unsigned request before admitting its oversized body", async () => {
    /*
      The body ceiling is 16 MiB. If the handler buffers before parsing Authorization this returns
      EntityTooLarge after allocating the entire ceiling; a 403 proves the refusal happened from the
      headers first. That ordering is what prevents an anonymous caller from buying 16 MiB of the
      router's 1 GiB host on every concurrent request.
    */
    let outcome: string
    try {
      const response = await fetch(`${active!.publicEndpoint}/v-not-a-service/large`, {
        method: "PUT",
        body: new Uint8Array(16 * 1024 * 1024 + 1),
      })

      outcome = `response:${response.status}:${(await response.text()).includes("AccessDenied")}`
    } catch (error) {
      // Undici can still be writing the request body when the proxy rejects from the headers and
      // closes the connection. EPIPE is therefore the transport-level form of the same proof: the
      // peer refused the request before the client could finish sending the oversized body.
      outcome = `error:${(error as { cause?: { code?: string } }).cause?.code}`
    }
    expect(["response:403:true", "error:EPIPE"]).toContain(outcome)
  }, 30_000)

  it("lets a customer write and read their own vault", async () => {
    // The whole thing working: the AWS SDK signs with a key AWS has never heard of, the proxy
    // verifies it against a derived secret, re-signs, and LocalStack answers.
    const mine = await vault("Mine")
    const client = asCustomer(mine.uri)
    const bucket = bucketNameFor(mine.backendServiceId)

    await client.send(new PutObjectCommand({ Bucket: bucket, Key: "notes/one.md", Body: "# hi" }))
    const read = await client.send(new GetObjectCommand({ Bucket: bucket, Key: "notes/one.md" }))

    expect(await read.Body?.transformToString()).toBe("# hi")
  }, 60_000)

  it("refuses one customer's credential against another customer's bucket", async () => {
    /*
      The assertion the IAM design could never make locally, and the reason the boundary moved into
      a process this repository owns.
    */
    const mine = await vault("Mine")
    const theirs = await vault("Theirs")

    await asCustomer(mine.uri).send(
      new PutObjectCommand({
        Bucket: bucketNameFor(mine.backendServiceId),
        Key: "secret.md",
        Body: "private",
      }),
    )

    await expect(
      asCustomer(theirs.uri).send(
        new ListObjectsV2Command({ Bucket: bucketNameFor(mine.backendServiceId) }),
      ),
    ).rejects.toMatchObject({ name: "AccessDenied" })
  }, 60_000)

  it("tells a stranger nothing about which keys or buckets exist", async () => {
    /*
      Asserted on the bytes a client receives, not on the status code.

      The first version of this proxy answered all three refusals with `403 AccessDenied` and three
      *different* messages — "unknown access key", "the signature does not match", "that bucket does
      not belong to this credential". That is an oracle: it confirms a key exists, and then that a
      bucket does. A unit test comparing status codes passed on it, which is why this compares the
      response body of one real request against another.
    */
    const mine = await vault("Mine")
    const theirs = await vault("Theirs")
    const bucket = bucketNameFor(mine.backendServiceId)

    async function refusal(client: S3Client) {
      try {
        await client.send(new ListObjectsV2Command({ Bucket: bucket }))
        throw new Error("expected a refusal")
      } catch (cause) {
        const error = cause as { name?: string; message?: string }
        return `${error.name}|${error.message}`
      }
    }

    const wrongTenant = await refusal(asCustomer(theirs.uri))
    const unknownKey = await refusal(
      new S3Client({
        region: config!.region,
        endpoint: active!.publicEndpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: "SPROUTNOTAREALKEY01", secretAccessKey: "nope" },
      }),
    )
    const wrongSecret = await refusal(
      new S3Client({
        region: config!.region,
        endpoint: active!.publicEndpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: parseObjectStorageUri(mine.uri).accessKeyId,
          secretAccessKey: "not-the-derived-secret",
        },
      }),
    )

    expect(unknownKey).toBe(wrongTenant)
    expect(wrongSecret).toBe(wrongTenant)
    expect(wrongTenant).toContain("AccessDenied")
  }, 60_000)

  it("refuses a suspended service without touching the customer's key", async () => {
    // Suspension is `backend_service.status`, read on the way through — not a permission removed at
    // the cloud provider, where the platform's belief and the provider's can disagree.
    const mine = await vault("Mine")
    const client = asCustomer(mine.uri)
    const bucket = bucketNameFor(mine.backendServiceId)

    await client.send(new PutObjectCommand({ Bucket: bucket, Key: "one.md", Body: "x" }))

    await driver().suspend(mine.backendServiceId)
    await expect(client.send(new ListObjectsV2Command({ Bucket: bucket }))).rejects.toMatchObject({
      name: "AccessDenied",
    })

    // The same saved settings work again afterwards, which is the point of not rotating.
    await driver().resume?.(mine.backendServiceId)
    await expect(client.send(new ListObjectsV2Command({ Bucket: bucket }))).resolves.toBeDefined()
  }, 60_000)

  it("refuses a rotated-away credential", async () => {
    // A derived secret cannot be deleted — it is a function of a root key and an identifier that
    // both still exist. The proxy's lookup against the live row is the revocation.
    const mine = await vault("Mine")
    const stale = asCustomer(mine.uri)

    await driver().rotateCredentials(mine.backendServiceId)

    await expect(
      stale.send(new ListObjectsV2Command({ Bucket: bucketNameFor(mine.backendServiceId) })),
    ).rejects.toMatchObject({ name: "AccessDenied" })
  }, 60_000)

  it("answers Obsidian's preflight, which carries no credential at all", async () => {
    // A browser sends OPTIONS with no Authorization — that is what a preflight is — so it cannot be
    // authenticated and must be answered here rather than forwarded.
    const response = await fetch(`${active!.publicEndpoint}/v-anything/notes/one.md`, {
      method: "OPTIONS",
      headers: {
        Origin: "app://obsidian.md",
        "Access-Control-Request-Method": "PUT",
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("app://obsidian.md")
    // `livesync` reads ETag to decide what changed; without it every object looks new.
    expect(response.headers.get("access-control-expose-headers")).toContain("ETag")
  }, 30_000)

  it("does not reflect an origin it does not serve", async () => {
    // Echoing whatever arrives would let any site the customer visits read their vault.
    const response = await fetch(`${active!.publicEndpoint}/v-anything/notes/one.md`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    })

    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  }, 30_000)
})

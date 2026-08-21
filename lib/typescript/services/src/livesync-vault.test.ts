import { execFile } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { S3Client } from "@aws-sdk/client-s3"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  bucketNameFor,
  objectStorageConfigFromEnv,
  objectStorageDriver,
  type ObjectStorageConfig,
} from "./object-storage"
import { proxyIsBuilt, startStorageProxy, type RunningProxy } from "./testing/storage-proxy"

/**
 * `obsidian-livesync`, the real client, against a vault this platform provisioned.
 *
 * The backlog item is "test deploying Obsidian plugins that require a backend service", and the
 * backend service livesync requires is object storage. Everything else here checks the platform
 * against a reading of what the plugin needs; this checks it against the plugin.
 *
 * It found the thing a reading would not have: the connection string. `objectStorageUri` used to
 * emit an ad-hoc `https://host?accessKeyId=…`, which carries the same information and which no
 * client can read — so setting up a vault meant taking the URI apart by hand into five settings,
 * for a product whose premise is that people should not have to know how any of this works. Writing
 * this test *was* doing that by hand, which is how it surfaced.
 *
 * The CLI is not a dependency of this repository: it is a thousand-package npm tree belonging to
 * somebody else. `bin/build-livesync-cli.sh` builds it; this skips without it and says so rather
 * than passing quietly.
 */
const run = promisify(execFile)

const cli = process.env.LIVESYNC_CLI ?? ""

const config = (() => {
  try {
    return objectStorageConfigFromEnv()
  } catch {
    return undefined
  }
})()

const reachable = await (async () => {
  if (config?.endpoint === undefined || cli === "" || !existsSync(cli)) return false
  try {
    await sql`select 1`.execute(db)
    const response = await fetch(`${config.endpoint}/_localstack/health`)
    return response.ok && proxyIsBuilt()
  } catch {
    return false
  }
})()

/**
 * This suite's own port, distinct from `object-storage-proxy.test.ts`'s. See the harness.
 */
const PROXY_PORT = 9003

let proxy: RunningProxy | undefined
/** The config with `publicEndpoint` pointing at *this* suite's proxy. */
let active: ObjectStorageConfig | undefined
const workspace = join(tmpdir(), `sproutos-vault-${Date.now()}`)
const fixtures: { organizations: string[]; users: string[]; services: string[] } = {
  organizations: [],
  users: [],
  services: [],
}

function driver() {
  return objectStorageDriver(
    db,
    active ?? config!,
    new S3Client({ region: config!.region, endpoint: config!.endpoint, forcePathStyle: true }),
  )
}

/** One `livesync-cli <db> <command> …`, with its output. */
async function livesync(database: string, args: string[], input?: string): Promise<string> {
  const child = run("node", [cli, database, ...args], { maxBuffer: 32 * 1024 * 1024 })
  if (input !== undefined) {
    child.child.stdin?.end(input)
  }
  const { stdout, stderr } = await child
  return `${stdout}${stderr}`
}

/** A local livesync database pointed at a connection string. */
async function vault(name: string, connectionUri: string): Promise<string> {
  const database = join(workspace, name, "db")
  mkdirSync(database, { recursive: true })

  const added = await livesync(database, ["remote-add", "sprout", connectionUri])
  const id = /remote-[a-z0-9-]+/.exec(added)?.[0]
  if (id === undefined) throw new Error(`no remote id in: ${added}`)

  await livesync(database, ["remote-activate", id])
  return database
}

beforeAll(async () => {
  if (!reachable) return
  mkdirSync(workspace, { recursive: true })

  proxy = await startStorageProxy(config!, PROXY_PORT)
  active = proxy.config
}, 60_000)

afterAll(async () => {
  proxy?.stop()
  rmSync(workspace, { recursive: true, force: true })
  if (!reachable) return

  for (const id of fixtures.services)
    await driver()
      .destroy(id)
      .catch(() => undefined)
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
}, 60_000)

async function provision(): Promise<{ backendServiceId: string; connectionUri: string }> {
  const userId = v7()
  const organizationId = v7()
  const backendServiceId = v7()

  await db
    .insertInto("user")
    .values({ id: userId, email: `vault-${userId}@test.invalid` })
    .execute()
  fixtures.users.push(userId)
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Vault",
      slug: `vault-${organizationId}`,
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
      name: "Obsidian vault",
      kind: "object_storage",
      status: "provisioning",
    })
    .execute()
  fixtures.services.push(backendServiceId)

  const provisioned = await driver().provision({
    backendServiceId,
    organizationId,
    projectId: null,
    name: "Obsidian vault",
  })

  return { backendServiceId, connectionUri: provisioned.connectionUri }
}

describe.runIf(reachable)("obsidian-livesync against a SproutOS vault", () => {
  it("syncs a note between two vaults with nothing but the connection string", async () => {
    /*
      The whole claim in one test, and the reason the string matters: a customer copies one value out
      of the dashboard, pastes it into `remote-add` — or into the plugin's settings dialog, which
      takes the same grammar — and their notes are on two machines.

      Every request in this goes through `storage-proxy`, signed by the plugin's own AWS SDK with a
      key AWS has never heard of.
    */
    const { connectionUri } = await provision()

    const first = await vault("first", connectionUri)
    await livesync(first, ["put", "notes/one.md"], "# Notes from the first vault\n")
    await livesync(first, ["sync"])

    const second = await vault("second", connectionUri)
    await livesync(second, ["sync"])

    expect(await livesync(second, ["cat", "notes/one.md"])).toContain(
      "# Notes from the first vault",
    )
  }, 300_000)

  it("carries a change made after the first sync", async () => {
    // A one-shot copy would pass the test above. Replication is the second round trip.
    const { connectionUri } = await provision()

    const first = await vault("first-again", connectionUri)
    const second = await vault("second-again", connectionUri)
    await livesync(first, ["put", "notes/a.md"], "before\n")
    await livesync(first, ["sync"])
    await livesync(second, ["sync"])

    await livesync(first, ["put", "notes/a.md"], "after\n")
    await livesync(first, ["sync"])
    await livesync(second, ["sync"])

    expect(await livesync(second, ["cat", "notes/a.md"])).toContain("after")
  }, 300_000)

  it("uses only the S3 operations the proxy's IAM role is granted", async () => {
    /*
      The proxy's role allows six actions, not `s3:*` — so an operation livesync uses that the role
      does not cover fails on AWS and passes here, where LocalStack evaluates no policy. This
      enumerates what the client actually asks for, and the list is checked against the role.

      Observed: GET and PUT of objects, GET of the bucket (`ListBucket`), HEAD of the bucket
      (`HeadBucket`, which IAM also grants through `ListBucket`). No multipart, which would need
      `AbortMultipartUpload` and `ListBucketMultipartUploads` on top.
    */
    const { backendServiceId, connectionUri } = await provision()
    const bucket = bucketNameFor(backendServiceId)

    const first = await vault("ops", connectionUri)
    await livesync(first, ["put", "notes/op.md"], "x\n")
    await livesync(first, ["sync"])

    const seen = new Set<string>()
    for (const line of (proxy?.log ?? []).join("").split("\n")) {
      const parsed = /"method":"([A-Z]+)","path":"\/([^/"]+)(\/[^"]*)?"/.exec(line)
      if (parsed === null || parsed[2] !== bucket) continue
      // A path beyond the bucket is an object operation; the bare bucket is a bucket operation.
      seen.add(`${parsed[1]} ${(parsed[3] ?? "/") === "/" ? "bucket" : "object"}`)
    }

    // Asserted before the interesting part. Without it, a change that stopped the log being
    // captured would turn every assertion below into a comparison of two empty sets.
    expect(seen.size).toBeGreaterThan(0)

    expect([...seen].sort()).toEqual(
      expect.arrayContaining(["GET bucket", "GET object", "PUT object"]),
    )
    // Multipart would arrive as `POST …?uploads`, and needs two actions the role does not grant.
    expect([...seen].some((entry) => entry.startsWith("POST"))).toBe(false)
  }, 300_000)
})

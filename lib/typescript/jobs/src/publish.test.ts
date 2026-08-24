import { LambdaClient } from "@aws-sdk/client-lambda"
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { readRoute } from "@lib/lambda"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { sql } from "kysely"
import { deflateRawSync } from "node:zlib"
import { v7 } from "uuid"
import { afterAll, describe, expect, it } from "vitest"
import { hostnameFor, publishRelease } from "./publish"
import type { Job } from "./queue"

/**
 * Against LocalStack's Lambda, the compose Valkey and the compose Postgres — all three, because the
 * thing being tested is that a row becomes a function and a route, and any one of them faked would
 * let the other two agree with a fiction.
 */
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566"
const BUCKET = "sproutos-test-lambda"
const ROLE = "arn:aws:iam::000000000000:role/lambda-exec"

const local = {
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
}

const lambda = new LambdaClient(local)
const s3 = new S3Client({ ...local, forcePathStyle: true })
const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
})

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    await valkey.connect()
    const health = await fetch(`${ENDPOINT}/_localstack/health`)
    if (!health.ok) return false
    const services = ((await health.json()) as { services?: Record<string, string> }).services
    return services?.lambda === "available" || services?.lambda === "running"
  } catch {
    return false
  }
})()

/** The smallest valid zip holding one handler. */
function zip(content: string): Buffer {
  const name = Buffer.from("index.mjs", "utf8")
  const body = Buffer.from(content, "utf8")
  const deflated = deflateRawSync(body)
  let crc = 0xffff_ffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1
  }
  crc = (crc ^ 0xffff_ffff) >>> 0

  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x0403_4b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(8, 8)
  localHeader.writeUInt32LE(crc, 14)
  localHeader.writeUInt32LE(deflated.length, 18)
  localHeader.writeUInt32LE(body.length, 22)
  localHeader.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x0201_4b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(body.length, 24)
  central.writeUInt16LE(name.length, 28)
  // `<< 16` overflows into a negative int32 in JS, so it is coerced back to unsigned.
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  central.writeUInt32LE(0, 42)

  const centralBuffer = Buffer.concat([central, name])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x0605_4b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(localHeader.length + name.length + deflated.length, 16)

  return Buffer.concat([localHeader, name, deflated, centralBuffer, end])
}

const HANDLER = `export const handler = async () => ({ statusCode: 200, body: process.env.GREETING ?? "" })\n`

const created: {
  table: "deployment" | "project" | "repository" | "organization" | "user"
  id: string
}[] = []
const hostnames: string[] = []

async function seed(
  overrides: { artifactKey?: string | null } = {},
): Promise<{ deploymentId: string; projectId: string; organizationId: string }> {
  const userId = v7()
  const orgId = v7()
  const repoId = v7()
  const projectId = v7()
  const deploymentId = v7()
  const suffix = repoId.slice(-12)

  await db
    .insertInto("user")
    .values({ id: userId, email: `pub-${suffix}@example.test` })
    .execute()
  created.push({ table: "user", id: userId })
  await db
    .insertInto("organization")
    .values({ id: orgId, slug: `pub-${suffix}`, name: "Pub", kind: "team", ownerUserId: userId })
    .execute()
  created.push({ table: "organization", id: orgId })
  await db
    .insertInto("repository")
    .values({
      id: repoId,
      organizationId: orgId,
      githubRepoId: BigInt(`0x${suffix}`),
      ownerLogin: "acme",
      name: `repo-${suffix}`,
      provenance: "new",
    })
    .execute()
  created.push({ table: "repository", id: repoId })
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId: orgId,
      repositoryId: repoId,
      name: "App",
      slug: `pub${suffix.slice(0, 6)}`,
    })
    .execute()
  created.push({ table: "project", id: projectId })
  await db
    .insertInto("deployment")
    .values({
      id: deploymentId,
      projectId,
      kind: "production",
      gitSha: "e".repeat(40),
      status: "queued",
      artifactKey:
        overrides.artifactKey === undefined ? `builds/${projectId}/app.zip` : overrides.artifactKey,
    })
    .execute()
  created.push({ table: "deployment", id: deploymentId })

  return { deploymentId, projectId, organizationId: orgId }
}

const context = { db, keepAlive: () => Promise.resolve(true), signal: new AbortController().signal }

function jobFor(deploymentId: string): Job {
  return {
    id: v7(),
    kind: "deploy.release",
    organizationId: null,
    payload: { deploymentId },
    attempt: 1,
  } as unknown as Job
}

function deploymentRow(id: string) {
  return db
    .selectFrom("deployment")
    .select(["status", "url", "hostname", "lambdaVersion", "failureReason"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow()
}

if (reachable) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }))
  } catch {
    // Already there from an earlier run in the same container session.
  }
}

afterAll(async () => {
  if (!reachable) return

  for (const hostname of hostnames) await valkey.del(`route:${hostname}`)
  for (const row of [...created].reverse()) {
    await db.deleteFrom(row.table).where("id", "=", row.id).execute()
  }
  valkey.disconnect()
  lambda.destroy()
  s3.destroy()
  await db.destroy()
})

describe.runIf(reachable)("publishing a release", () => {
  it("publishes the function, then the route, and records both", async () => {
    const { deploymentId, projectId, organizationId } = await seed()

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `builds/${projectId}/app.zip`,
        Body: zip(HANDLER),
      }),
    )

    const handler = publishRelease({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })
    await handler(jobFor(deploymentId), context)

    const row = await deploymentRow(deploymentId)
    expect(row.status).toBe("ready")
    expect(row.lambdaVersion).not.toBeNull()
    expect(row.hostname).not.toBeNull()

    hostnames.push(row.hostname ?? "")

    // The route the Rust router will read. Recorded on the row *and* in Valkey, because teardown
    // withdraws by the stored hostname — recomputing it would miss a project since renamed.
    const route = await readRoute(valkey, row.hostname ?? "")
    expect(route?.projectId).toBe(projectId)
    expect(route?.organizationId).toBe(organizationId)
    expect(route?.deploymentId).toBe(deploymentId)
    // The alias, not a bare version: the router invokes whatever `live` points at, so a rollback
    // takes effect without touching Valkey at all.
    expect(route?.arn).toContain(":live")

    expect(row.url).toBe(`https://${row.hostname}`)
  }, 180_000)

  it("fails the deployment rather than publishing nothing when the artifact never arrived", async () => {
    const { deploymentId } = await seed({ artifactKey: null })

    const handler = publishRelease({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })
    await handler(jobFor(deploymentId), context)

    const row = await deploymentRow(deploymentId)
    expect(row.status).toBe("error")
    // The reason lands on the row, not only in the job's last_error — a table no customer can read.
    expect(row.failureReason).toContain("No build artifact")
    expect(row.hostname).toBeNull()
  })

  it("refuses a project with config files instead of dropping them silently", async () => {
    const { deploymentId, projectId } = await seed()

    await db
      .insertInto("projectFile")
      .values({
        id: v7(),
        projectId,
        path: "/app/config/glance.yml",
        target: "production",
        contentsCiphertext: "x",
        contentsWrappedDek: "x",
        contentsKmsKeyId: "alias/test",
      })
      .execute()

    const handler = publishRelease({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })
    await handler(jobFor(deploymentId), context)

    const row = await deploymentRow(deploymentId)
    // A Lambda's filesystem is its zip plus /tmp, so there is nowhere to put these. Deploying
    // anyway would look to the owner exactly like their application being broken.
    expect(row.status).toBe("error")
    expect(row.failureReason).toContain("configuration file")
  })

  it("gives a preview its own hostname, distinct from production", () => {
    const project = {
      id: "01a03600-0000-7000-8000-0000000abcde",
      slug: "myapp",
      organizationId: "o",
    }

    const production = hostnameFor(project, { kind: "production", prNumber: null })
    const preview = hostnameFor(project, { kind: "preview", prNumber: 42 })

    expect(preview).not.toBe(production)
    expect(preview.startsWith("pr-42--")).toBe(true)
    // Both are single-label under the tenant domain: an ACM wildcard covers exactly one label, so a
    // preview host with a second one would have no certificate.
    expect(production.split(".").length).toBe(preview.split(".").length)
  })
})

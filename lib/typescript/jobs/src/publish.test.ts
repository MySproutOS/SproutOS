import {
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda"
import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import {
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
  type CloudFrontKeyValueStoreClient,
} from "@aws-sdk/client-cloudfront-keyvaluestore"
import { ChangeResourceRecordSetsCommand, type Route53Client } from "@aws-sdk/client-route-53"
import { createHash } from "node:crypto"
import { publishQueue, readQueue, readRoute } from "@lib/lambda"
import { encodeShortId } from "@lib/services"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { sql } from "kysely"
import { deflateRawSync } from "node:zlib"
import { v7 } from "uuid"
import { afterAll, describe, expect, it, vi } from "vitest"
import { cleanUpStaticPreview, hostnameFor, publishRelease, tearDownPreview } from "./publish"
import type { Job } from "./queue"
import { runOne } from "./worker"

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
function zip(content: string, path = "index.mjs"): Buffer {
  const name = Buffer.from(path, "utf8")
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
  table: "backendService" | "deployment" | "project" | "repository" | "organization" | "user"
  id: string
}[] = []
const hostnames: string[] = []
const queueResources: string[] = []

async function seed(
  overrides: {
    artifactKey?: string | null
    preset?: string
    staticArtifactKey?: string | null
    staticDigest?: string | null
  } = {},
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
      preset: overrides.preset ?? "unknown",
      staticArtifactKey: overrides.staticArtifactKey ?? null,
      staticDigest: overrides.staticDigest ?? null,
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
    .select([
      "status",
      "url",
      "hostname",
      "lambdaVersion",
      "failureReason",
      "preset",
      "staticArtifactKey",
      "staticDigest",
    ])
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
  for (const resource of queueResources) await valkey.del(`queue:${resource}`)
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
    const region = await db
      .selectFrom("region")
      .select("id")
      .where("isActive", "=", true)
      .executeTakeFirstOrThrow()
    const backendServiceId = v7()
    await db
      .insertInto("backendService")
      .values({
        id: backendServiceId,
        organizationId,
        projectId,
        regionId: region.id,
        kind: "valkey",
        name: "Celery queue",
        status: "active",
      })
      .execute()
    created.push({ table: "backendService", id: backendServiceId })
    const queueResource = encodeShortId(backendServiceId)
    queueResources.push(queueResource)
    await publishQueue(valkey, queueResource, {
      uri: "rediss://tenant:one-time-secret@queue.example.test:6379/0",
      backendServiceId,
      projectId,
      organizationId,
    })

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

    // The real queue binding carries the same validated production alias as HTTP. The credential
    // is preserved byte-for-byte; deployment publication cannot recover or replace it.
    expect(await readQueue(valkey, queueResource)).toEqual({
      uri: "rediss://tenant:one-time-secret@queue.example.test:6379/0",
      backendServiceId,
      projectId,
      organizationId,
      functionArn: route?.arn,
    })

    expect(row.url).toBe(`https://${row.hostname}`)

    /*
      The extension is told whose function it is in.

      It runs inside the customer's execution environment and Lambda tells it nothing about the
      project — without these two, every log line arrives unattributable and the viewer shows an
      empty project. Asserted against the deployed function rather than the input, because the
      value that matters is the one Lambda holds.
    */
    const deployed = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: `sproutos-app-${projectId}` }),
    )
    expect(deployed.Environment?.Variables?.SPROUTOS_PROJECT_ID).toBe(projectId)
    expect(deployed.Environment?.Variables?.SPROUTOS_DEPLOYMENT_ID).toBe(deploymentId)
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

  it("projects a terminal publisher failure onto the deployment row", async () => {
    const { deploymentId } = await seed({ artifactKey: "builds/missing/app.zip" })
    const handler = publishRelease({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })

    await expect(handler(jobFor(deploymentId), context)).rejects.toBeInstanceOf(Error)
    const row = await deploymentRow(deploymentId)
    expect(row.status).toBe("error")
    expect(row.failureReason).not.toBeNull()
  })

  it("publishes a static preset without inventing a Lambda", async () => {
    const archive = zip("<h1>static release</h1>", "index.html")
    const digest = createHash("sha256").update(archive).digest("hex")
    const staticKey = `static/pending/${digest}.zip`
    const seeded = await seed({
      artifactKey: null,
      preset: "static",
      staticArtifactKey: staticKey,
      staticDigest: digest,
    })
    // The route validates this before insertion in production. The integration seed writes rows
    // directly, so make its key match the generated project now that the id is known.
    const projectStaticKey = `static/${seeded.projectId}/${digest}.zip`
    await db
      .updateTable("deployment")
      .set({ staticArtifactKey: projectStaticKey })
      .where("id", "=", seeded.deploymentId)
      .execute()
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: projectStaticKey, Body: archive }))

    const edgeValues: string[] = []
    const keyValueStore = {
      send: (command: unknown) => {
        if (command instanceof DescribeKeyValueStoreCommand) return Promise.resolve({ ETag: "v1" })
        if (command instanceof PutKeyCommand) {
          edgeValues.push(command.input.Value ?? "")
          return Promise.resolve({})
        }
        throw new Error("unexpected key-value-store command")
      },
    } as unknown as CloudFrontKeyValueStoreClient
    let dnsChanges = 0
    const route53 = {
      send: (command: unknown) => {
        expect(command).toBeInstanceOf(ChangeResourceRecordSetsCommand)
        dnsChanges += 1
        return Promise.resolve({})
      },
    } as unknown as Route53Client

    await publishRelease({
      lambda,
      valkey,
      bucket: BUCKET,
      roleArn: ROLE,
      static: {
        s3,
        route53,
        keyValueStore,
        bucket: BUCKET,
        tenantZoneId: "zone",
        distributionDomain: "static.cloudfront.test",
        keyValueStoreArn: "arn:kvs",
      },
    })(jobFor(seeded.deploymentId), context)

    const row = await deploymentRow(seeded.deploymentId)
    expect(row.status).toBe("ready")
    expect(row.lambdaVersion).toBeNull()
    expect(row.hostname).not.toBeNull()
    hostnames.push(row.hostname ?? "")
    expect(edgeValues).toEqual([`${seeded.projectId}/${digest}`])
    expect(dnsChanges).toBe(1)

    const published = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: `sites/${seeded.projectId}/${digest}/index.html`,
      }),
    )
    expect(await published.Body?.transformToString()).toBe("<h1>static release</h1>")
    // An exact DNS record, not a Valkey route to a nonexistent function, serves a static project.
    expect(await readRoute(valkey, row.hostname ?? "")).toBeUndefined()
  })

  it("waits for another project operation without consuming a job attempt", async () => {
    const { deploymentId, projectId } = await seed({ artifactKey: null })
    await db.connection().execute(async (connection) => {
      const key = `sproutos:project:${projectId}`
      await sql`select pg_advisory_lock(hashtextextended(${key}, 0))`.execute(connection)
      const handler = publishRelease({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })
      const publishing = handler(jobFor(deploymentId), context)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection)
      await publishing
      expect((await deploymentRow(deploymentId)).status).toBe("error")
    })
  }, 10_000)

  it("restores the prior Lambda alias and route after a post-alias failure", async () => {
    const first = await seed()
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `builds/${first.projectId}/app.zip`,
        Body: zip(HANDLER),
      }),
    )
    const handler = publishRelease({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })
    await handler(jobFor(first.deploymentId), context)
    const firstRow = await deploymentRow(first.deploymentId)
    const secondId = v7()
    const secondKey = `builds/${first.projectId}/second.zip`
    await db
      .insertInto("deployment")
      .values({
        id: secondId,
        projectId: first.projectId,
        kind: "production",
        gitSha: "c".repeat(40),
        status: "queued",
        preset: "unknown",
        artifactKey: secondKey,
      })
      .execute()
    created.push({ table: "deployment", id: secondId })
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: secondKey, Body: zip(`${HANDLER}\n// second`) }),
    )

    let refusedNewRoute = false
    const failingValkey = new Proxy(valkey, {
      get(target, property) {
        if (property === "set") {
          return async (...args: Parameters<Redis["set"]>) => {
            if (!refusedNewRoute && String(args[0]).startsWith("route:")) {
              refusedNewRoute = true
              throw new Error("injected route publication failure")
            }
            return target.set(...args)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        // oxlint-disable-next-line typescript/no-unsafe-return -- Reflect loses overloaded signatures.
        return typeof value === "function" ? value.bind(target) : value
      },
    })

    await expect(
      publishRelease({ lambda, valkey: failingValkey, bucket: BUCKET, roleArn: ROLE })(
        jobFor(secondId),
        context,
      ),
    ).rejects.toThrow(/injected route/)

    const alias = await lambda.send(
      new GetAliasCommand({ FunctionName: `sproutos-app-${first.projectId}`, Name: "live" }),
    )
    expect(alias.FunctionVersion).toBe(firstRow.lambdaVersion)
    expect(
      (
        await db
          .selectFrom("project")
          .select("liveDeploymentId")
          .where("id", "=", first.projectId)
          .executeTakeFirstOrThrow()
      ).liveDeploymentId,
    ).toBe(first.deploymentId)
    expect((await readRoute(valkey, firstRow.hostname ?? ""))?.deploymentId).toBe(
      first.deploymentId,
    )
    expect((await deploymentRow(secondId)).status).toBe("error")
  }, 180_000)

  it("publishes a preview without changing any production traffic pointer", async () => {
    const production = await seed()
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `builds/${production.projectId}/app.zip`,
        Body: zip(HANDLER),
      }),
    )
    const handler = publishRelease({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })
    await handler(jobFor(production.deploymentId), context)
    const productionRow = await deploymentRow(production.deploymentId)
    const liveBefore = await lambda.send(
      new GetAliasCommand({ FunctionName: `sproutos-app-${production.projectId}`, Name: "live" }),
    )
    const routeBefore = await readRoute(valkey, productionRow.hostname ?? "")

    const previewId = v7()
    const previewKey = `builds/${production.projectId}/preview.zip`
    await db
      .insertInto("deployment")
      .values({
        id: previewId,
        projectId: production.projectId,
        kind: "preview",
        prNumber: 7,
        gitSha: "b".repeat(40),
        status: "queued",
        preset: "unknown",
        artifactKey: previewKey,
      })
      .execute()
    created.push({ table: "deployment", id: previewId })
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: previewKey,
        Body: zip(`${HANDLER}\n// preview`),
      }),
    )
    await handler(jobFor(previewId), context)

    const previewRow = await deploymentRow(previewId)
    const liveAfter = await lambda.send(
      new GetAliasCommand({ FunctionName: `sproutos-app-${production.projectId}`, Name: "live" }),
    )
    const previewAlias = await lambda.send(
      new GetAliasCommand({
        FunctionName: `sproutos-app-${production.projectId}`,
        Name: "preview-7",
      }),
    )
    expect(liveAfter.FunctionVersion).toBe(liveBefore.FunctionVersion)
    expect(previewAlias.FunctionVersion).toBe(previewRow.lambdaVersion)
    expect(await readRoute(valkey, productionRow.hostname ?? "")).toEqual(routeBefore)
    expect((await readRoute(valkey, previewRow.hostname ?? ""))?.deploymentId).toBe(previewId)
    expect(await valkey.get(`live:${production.projectId}`)).toBe(production.deploymentId)
    expect(
      (
        await db
          .selectFrom("project")
          .select("liveDeploymentId")
          .where("id", "=", production.projectId)
          .executeTakeFirstOrThrow()
      ).liveDeploymentId,
    ).toBe(production.deploymentId)

    const failedReplacementId = v7()
    const failedReplacementKey = `builds/${production.projectId}/preview-failed.zip`
    await db
      .insertInto("deployment")
      .values({
        id: failedReplacementId,
        projectId: production.projectId,
        kind: "preview",
        prNumber: 7,
        gitSha: "8".repeat(40),
        status: "queued",
        preset: "unknown",
        artifactKey: failedReplacementKey,
      })
      .execute()
    created.push({ table: "deployment", id: failedReplacementId })
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: failedReplacementKey,
        Body: zip(`${HANDLER}\n// failed replacement`),
      }),
    )
    let failReplacementRoute = true
    const failingPreviewValkey = new Proxy(valkey, {
      get(target, property) {
        if (property === "set") {
          return async (...args: Parameters<Redis["set"]>) => {
            if (failReplacementRoute && String(args[0]).startsWith("route:")) {
              failReplacementRoute = false
              throw new Error("injected preview replacement failure")
            }
            return target.set(...args)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        // oxlint-disable-next-line typescript/no-unsafe-return -- Reflect loses overloaded signatures.
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    await expect(
      publishRelease({
        lambda,
        valkey: failingPreviewValkey,
        bucket: BUCKET,
        roleArn: ROLE,
      })(jobFor(failedReplacementId), context),
    ).rejects.toThrow(/preview replacement/)
    expect((await deploymentRow(previewId)).status).toBe("ready")
    expect((await deploymentRow(failedReplacementId)).status).toBe("error")
    expect((await readRoute(valkey, previewRow.hostname ?? ""))?.deploymentId).toBe(previewId)

    const replacementId = v7()
    const replacementKey = `builds/${production.projectId}/preview-replacement.zip`
    await db
      .insertInto("deployment")
      .values({
        id: replacementId,
        projectId: production.projectId,
        kind: "preview",
        prNumber: 7,
        gitSha: "9".repeat(40),
        status: "queued",
        preset: "unknown",
        artifactKey: replacementKey,
      })
      .execute()
    created.push({ table: "deployment", id: replacementId })
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: replacementKey,
        Body: zip(`${HANDLER}\n// replacement`),
      }),
    )
    await handler(jobFor(replacementId), context)
    expect((await deploymentRow(previewId)).status).toBe("torn_down")
    expect((await deploymentRow(replacementId)).status).toBe("ready")

    await tearDownPreview({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })(
      jobFor(replacementId),
      context,
    )
    await expect(
      lambda.send(
        new GetAliasCommand({
          FunctionName: `sproutos-app-${production.projectId}`,
          Name: "preview-7",
        }),
      ),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" })
    expect(await readRoute(valkey, previewRow.hostname ?? "")).toBeUndefined()
    expect((await deploymentRow(replacementId)).status).toBe("torn_down")
  }, 180_000)

  it("does not pin serving mode when the first attempted release fails", async () => {
    const failed = await seed({ artifactKey: null })
    await publishRelease({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })(
      jobFor(failed.deploymentId),
      context,
    )
    expect(
      (
        await db
          .selectFrom("project")
          .select("servingMode")
          .where("id", "=", failed.projectId)
          .executeTakeFirstOrThrow()
      ).servingMode,
    ).toBeNull()

    const archive = zip("<h1>static after failure</h1>", "index.html")
    const digest = createHash("sha256").update(archive).digest("hex")
    const staticId = v7()
    const artifactKey = `static/${failed.projectId}/${digest}.zip`
    await db
      .insertInto("deployment")
      .values({
        id: staticId,
        projectId: failed.projectId,
        kind: "preview",
        prNumber: 8,
        gitSha: "a".repeat(40),
        status: "queued",
        preset: "static",
        staticArtifactKey: artifactKey,
        staticDigest: digest,
      })
      .execute()
    created.push({ table: "deployment", id: staticId })
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: artifactKey, Body: archive }))
    const keyValueStoreSend = vi.fn<(command: unknown) => Promise<unknown>>((command: unknown) =>
      Promise.resolve(command instanceof DescribeKeyValueStoreCommand ? { ETag: "v1" } : {}),
    )
    const keyValueStore = { send: keyValueStoreSend } as unknown as CloudFrontKeyValueStoreClient
    const route53 = {
      send: (command: unknown) =>
        Promise.resolve(
          command instanceof ChangeResourceRecordSetsCommand ? {} : { ResourceRecordSets: [] },
        ),
    } as unknown as Route53Client
    const staticOptions = {
      lambda,
      valkey,
      bucket: BUCKET,
      roleArn: ROLE,
      static: {
        s3,
        route53,
        keyValueStore,
        bucket: BUCKET,
        tenantZoneId: "zone",
        distributionDomain: "static.cloudfront.test",
        keyValueStoreArn: "arn:kvs",
      },
    }
    await publishRelease(staticOptions)(jobFor(staticId), context)

    expect((await deploymentRow(staticId)).status).toBe("ready")
    expect(
      (
        await db
          .selectFrom("project")
          .select("servingMode")
          .where("id", "=", failed.projectId)
          .executeTakeFirstOrThrow()
      ).servingMode,
    ).toBe("static")

    const replacementArchive = zip("<h1>replacement</h1>", "index.html")
    const replacementDigest = createHash("sha256").update(replacementArchive).digest("hex")
    const replacementId = v7()
    const replacementArtifactKey = `static/${failed.projectId}/${replacementDigest}.zip`
    await db
      .insertInto("deployment")
      .values({
        id: replacementId,
        projectId: failed.projectId,
        kind: "preview",
        prNumber: 8,
        gitSha: "7".repeat(40),
        status: "queued",
        preset: "static",
        staticArtifactKey: replacementArtifactKey,
        staticDigest: replacementDigest,
      })
      .execute()
    created.push({ table: "deployment", id: replacementId })
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: replacementArtifactKey,
        Body: replacementArchive,
      }),
    )
    await publishRelease(staticOptions)(jobFor(replacementId), context)
    const edgeCallsBeforeCleanup = keyValueStoreSend.mock.calls.length
    const reuseId = v7()
    await db
      .insertInto("deployment")
      .values({
        id: reuseId,
        projectId: failed.projectId,
        kind: "preview",
        prNumber: 9,
        gitSha: "6".repeat(40),
        status: "queued",
        preset: "static",
        staticArtifactKey: artifactKey,
        staticDigest: digest,
      })
      .execute()
    created.push({ table: "deployment", id: reuseId })
    const cleanupJob = await db
      .selectFrom("backgroundJob")
      .select("id")
      .where("idempotencyKey", "=", `deploy.static_preview_cleanup:${staticId}`)
      .executeTakeFirstOrThrow()
    await db
      .updateTable("backgroundJob")
      .set({ priority: 10_000, runAt: sql<Date>`now()` })
      .where("id", "=", cleanupJob.id)
      .execute()
    const cleanupHandlers = {
      "deploy.static_preview_cleanup": cleanUpStaticPreview(staticOptions),
    }
    await runOne(db, { workerId: `cleanup-${v7()}`, handlers: cleanupHandlers })
    expect(
      (
        await db
          .selectFrom("backgroundJob")
          .select("state")
          .where("id", "=", cleanupJob.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("queued")
    expect(
      await (
        await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: artifactKey }))
      ).Body?.transformToByteArray(),
    ).toBeDefined()
    await db.updateTable("deployment").set({ status: "error" }).where("id", "=", reuseId).execute()
    await db
      .updateTable("backgroundJob")
      .set({ runAt: sql<Date>`now()` })
      .where("id", "=", cleanupJob.id)
      .execute()
    await runOne(db, { workerId: `cleanup-${v7()}`, handlers: cleanupHandlers })
    expect(
      (
        await db
          .selectFrom("backgroundJob")
          .select("state")
          .where("id", "=", cleanupJob.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("succeeded")
    expect(keyValueStoreSend).toHaveBeenCalledTimes(edgeCallsBeforeCleanup)
    await expect(
      s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: artifactKey })),
    ).rejects.toBeDefined()
    await expect(
      s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: `sites/${failed.projectId}/${digest}/index.html`,
        }),
      ),
    ).rejects.toBeDefined()
    expect(
      await (
        await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: replacementArtifactKey }))
      ).Body?.transformToByteArray(),
    ).toBeDefined()

    await tearDownPreview(staticOptions)(jobFor(replacementId), context)
    expect((await deploymentRow(replacementId)).status).toBe("torn_down")
  })

  it("refuses serving-mode switches for previews as well as production", async () => {
    const { deploymentId, projectId } = await seed()
    await db
      .updateTable("deployment")
      .set({ kind: "preview", prNumber: 42 })
      .where("id", "=", deploymentId)
      .execute()
    await db
      .updateTable("project")
      .set({ servingMode: "static" })
      .where("id", "=", projectId)
      .execute()

    await publishRelease({ lambda, valkey, bucket: BUCKET, roleArn: ROLE })(
      jobFor(deploymentId),
      context,
    )

    const row = await deploymentRow(deploymentId)
    expect(row.status).toBe("error")
    expect(row.failureReason).toMatch(/cannot switch between static and serverless/)
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

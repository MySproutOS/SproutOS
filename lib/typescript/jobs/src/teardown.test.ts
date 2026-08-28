import { db } from "@sproutos/db"
import {
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore"
import { ListResourceRecordSetsCommand } from "@aws-sdk/client-route-53"
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import { TEARDOWN_KIND, tearDownProject, type TeardownClients } from "./teardown"
import { encodeShortId } from "@lib/services"

/**
 * Against the docker-compose Postgres. What is asserted here is which rows change and which
 * deliberately do not, and both are database facts.
 *
 * Kubernetes is stubbed: the calls this makes there are `get` and `remove` by path, and a fake that
 * records them proves the same thing a cluster would while running in a second.
 */
let reachable = false
let organizationId: string
let ownerUserId: string
let projectId: string
let repositoryId: string

/** Collection deletes, as `path` + the selector — see `removeCollection`. */

/*
  What teardown did to the Lambda side.

  Injected rather than defaulted. Without this the handler builds a real `LambdaClient` and a real
  `Redis` from the environment — so the suite would open a connection it never closes, reach
  LocalStack from a unit test, and assert nothing about either. It passed like that once, which is
  the whole reason the injection is here.
*/
const deletedFunctions: string[] = []
const withdrawn: string[] = []
const staticCleanup: string[] = []
const certificateCleanup: string[] = []
const certificateInvalidations: string[] = []
let certificateVersionPages = 0
const destroyedServices: string[] = []
const destroyedSandboxes: string[] = []

const lambdaClients = {
  lambda: {
    send: (command: { input?: { FunctionName?: string } }) => {
      deletedFunctions.push(command.input?.FunctionName ?? "")
      return Promise.resolve({})
    },
  },
  valkey: {
    del: (key: string) => {
      withdrawn.push(key)
      return Promise.resolve(1)
    },
    publish: (channel: string, payload: string) => {
      certificateInvalidations.push(`${channel}:${payload}`)
      return Promise.resolve(1)
    },
  },
  customDomains: {
    bucket: "tenant-certificates",
    s3: {
      send: (command: unknown) => {
        certificateCleanup.push(command?.constructor.name ?? "unknown")
        if (command instanceof ListObjectVersionsCommand) {
          certificateVersionPages += 1
          return Promise.resolve({
            Versions:
              certificateVersionPages === 1
                ? [{ Key: command.input.Prefix, VersionId: "version-1" }]
                : [],
          })
        }
        if (command instanceof DeleteObjectsCommand) return Promise.resolve({})
        return Promise.resolve({})
      },
    },
  },
  serviceDriver: (_database: typeof db, kind: string, backendServiceId: string) =>
    Promise.resolve({
      destroy: () => {
        destroyedServices.push(`${kind}:${backendServiceId}`)
        return Promise.resolve()
      },
    }),
  sandbox: async (job: { payload: unknown }, context: { db: typeof db }) => {
    const sandboxId = (job.payload as { sandboxId: string }).sandboxId
    destroyedSandboxes.push(sandboxId)
    await context.db.deleteFrom("sandbox").where("id", "=", sandboxId).execute()
  },
  static: {
    bucket: "tenant-static",
    tenantZoneId: "tenant-zone",
    keyValueStoreArn: "arn:kvs",
    s3: {
      send: (command: unknown) => {
        if (command instanceof ListObjectsV2Command) {
          staticCleanup.push(`list:${command.input.Prefix}`)
          return Promise.resolve({ Contents: [], IsTruncated: false })
        }
        return Promise.reject(new Error("unexpected static S3 command"))
      },
    },
    route53: {
      send: (command: unknown) => {
        if (command instanceof ListResourceRecordSetsCommand) {
          staticCleanup.push(`dns:${command.input.StartRecordType}`)
          return Promise.resolve({ ResourceRecordSets: [] })
        }
        return Promise.reject(new Error("unexpected static Route53 command"))
      },
    },
    keyValueStore: {
      send: (command: unknown) => {
        if (command instanceof DescribeKeyValueStoreCommand) return Promise.resolve({ ETag: "v1" })
        if (command instanceof DeleteKeyCommand) {
          staticCleanup.push(`edge:${command.input.Key}`)
          return Promise.resolve({})
        }
        return Promise.reject(new Error("unexpected static KVS command"))
      },
    },
  },
} as unknown as TeardownClients

/** The handler, with the Kubernetes and AWS clients replaced by ones that record what they did. */
function handler() {
  return tearDownProject(lambdaClients)
}

beforeAll(async () => {
  try {
    await sql`select 1`.execute(db)
    reachable = true
  } catch {
    return
  }

  ownerUserId = v7()
  organizationId = v7()
  projectId = v7()
  repositoryId = v7()

  await db
    .insertInto("user")
    .values({ id: ownerUserId, email: `teardown-${ownerUserId}@test.invalid`, name: "Teardown" })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      name: "Teardown Org",
      slug: `teardown-${organizationId.slice(-12)}`,
      kind: "personal",
      ownerUserId,
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Date.now() % 1_000_000_000,
      ownerLogin: "teardown",
      name: `repo-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "Teardown Project",
      slug: `teardown-${projectId.slice(-12)}`,
    })
    .execute()
})

afterAll(async () => {
  if (!reachable || !organizationId) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx.deleteFrom("customDomain").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("sandbox").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("backendService").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("projectEnvVar").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("usageRollup").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("deployment").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("project").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("repository").where("organizationId", "=", organizationId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", ownerUserId).execute()
  })
})

const job = (payload: Record<string, unknown>) => ({ payload }) as never
const context = () => ({ db, keepAlive: () => Promise.resolve(true) }) as never

describe("tearing down a deleted project", () => {
  /*
    The check that makes a misfired job harmless instead of catastrophic.

    A teardown enqueued for a *live* project would destroy a customer's running site, and the only
    thing between the two is a field in a payload. Asserted first because it is the assertion that
    matters most.
  */
  it("refuses a project that is not deleted", async ({ skip }) => {
    if (!reachable) skip()
    await expect(handler()(job({ projectId }), context())).rejects.toThrow(/not deleted/)
  })

  it("does nothing for a project that no longer exists", async ({ skip }) => {
    if (!reachable) skip()
    await expect(handler()(job({ projectId: v7() }), context())).resolves.toBeUndefined()
  })

  it("refuses a payload with no project", async ({ skip }) => {
    if (!reachable) skip()
    await expect(handler()(job({}), context())).rejects.toThrow(/needs a projectId/)
  })

  it("tears down the deployments and the customer's secrets, and keeps the billing history", async ({
    skip,
  }) => {
    if (!reachable) skip()

    await db
      .insertInto("deployment")
      .values({
        id: v7(),
        projectId,
        kind: "production",
        gitSha: "abc",
        status: "ready",
        imageUri: "registry/app:sha",
      })
      .execute()
    await db
      .insertInto("deployment")
      .values({
        id: v7(),
        projectId,
        kind: "production",
        gitSha: "static",
        status: "ready",
        preset: "static",
        staticArtifactKey: `static/${projectId}/${"a".repeat(64)}.zip`,
        staticDigest: "a".repeat(64),
        hostname: "old-static.example.test",
      })
      .execute()
    await db
      .insertInto("projectEnvVar")
      .values({
        id: v7(),
        projectId,
        key: "SECRET",
        target: "production",
        valueCiphertext: "ciphertext",
        valueWrappedDek: "wrapped",
        valueKmsKeyId: "test-key",
      })
      .execute()
    const customDomainId = v7()
    await db
      .insertInto("customDomain")
      .values({
        id: customDomainId,
        organizationId,
        projectId,
        hostname: "deleted.example.test",
        isApex: true,
        verificationToken: "test-token",
        certificateObjectKey: `custom-domains/${customDomainId}/certificate.json`,
        certificateObjectVersion: "version-1",
        status: "active",
      })
      .execute()

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
        kind: "object_storage",
        name: "Teardown storage",
        status: "active",
      })
      .execute()
    const queueServiceId = v7()
    await db
      .insertInto("backendService")
      .values({
        id: queueServiceId,
        organizationId,
        projectId,
        regionId: region.id,
        kind: "valkey",
        name: "Teardown queue",
        status: "active",
      })
      .execute()
    const sandboxId = v7()
    await db
      .insertInto("sandbox")
      .values({
        id: sandboxId,
        projectId,
        userId: ownerUserId,
        externalId: "daytona-teardown-test",
        state: "running",
      })
      .execute()

    // A billing grain, which must survive: a statement has to resolve its line items to a project.
    const rollupId = v7()
    await db
      .insertInto("usageRollup")
      .values({
        id: rollupId,
        organizationId,
        projectId,
        dimension: "site_gib_second",
        quantity: "1",
        bucket: "day",
        bucketStart: new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z"),
      })
      .execute()

    await db
      .updateTable("project")
      .set({ deletedAt: new Date(), state: "deleting" })
      .where("id", "=", projectId)
      .execute()

    await db
      .updateTable("customDomain")
      .set({
        reconcileLeaseToken: v7(),
        reconcileLeaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where("id", "=", customDomainId)
      .execute()
    // Deletion is the fence: it revokes a stale issuer's lease before removing the route and
    // certificate material. Waiting for that lease to expire would leave a deleted project live,
    // while the issuer's conditional writes already prevent it from resurrecting this row.
    await handler()(job({ projectId }), context())
    expect(certificateCleanup).toContain("DeleteObjectsCommand")

    const deployments = await db
      .selectFrom("deployment")
      .select(["status"])
      .where("projectId", "=", projectId)
      .execute()
    expect(deployments.every((d) => d.status === "torn_down")).toBe(true)

    /*
      The compute is actually gone, not merely marked gone.

      A row that says `torn_down` while the function still exists and the hostname still resolves is
      the exact failure this job exists to prevent — a deleted project still serving, and still
      costing money every minute nobody notices.
    */
    expect(deletedFunctions.length).toBeGreaterThan(0)
    expect(deletedFunctions.every((name) => name.startsWith("sproutos-app-"))).toBe(true)
    // Withdrawn by the hostname stored on the deployment, so a project renamed since it deployed
    // does not leave its old host resolving.
    expect(
      withdrawn.every(
        (key) =>
          key.startsWith("route:") ||
          key.startsWith("queue:") ||
          key.startsWith("custom-domain:pending:"),
      ),
    ).toBe(true)
    expect(staticCleanup).toContain("edge:old-static.example.test")
    expect(staticCleanup).toContain(`list:sites/${projectId}/`)
    expect(staticCleanup).toContain(`list:static/${projectId}/`)
    expect(withdrawn).toContain("route:deleted.example.test")
    expect(certificateCleanup).toContain("ListObjectVersionsCommand")
    expect(certificateCleanup).toContain("DeleteObjectsCommand")
    expect(certificateInvalidations.some((entry) => entry.includes("deleted.example.test"))).toBe(
      true,
    )
    const deletedDomain = await db
      .selectFrom("customDomain")
      .select("deletedAt")
      .where("id", "=", customDomainId)
      .executeTakeFirstOrThrow()
    expect(deletedDomain.deletedAt).toBeInstanceOf(Date)
    expect(destroyedServices).toContain(`object_storage:${backendServiceId}`)
    expect(destroyedServices).toContain(`valkey:${queueServiceId}`)
    expect(withdrawn).toContain(`queue:${encodeShortId(queueServiceId)}`)
    expect(destroyedSandboxes).toContain(sandboxId)
    expect(
      await db.selectFrom("sandbox").select("id").where("id", "=", sandboxId).executeTakeFirst(),
    ).toBeUndefined()
    expect(
      (
        await db
          .selectFrom("backendService")
          .select("deletedAt")
          .where("id", "=", backendServiceId)
          .executeTakeFirstOrThrow()
      ).deletedAt,
    ).toBeInstanceOf(Date)

    // The customer's secrets are gone. Nothing references them and the request was to stop holding
    // the project's data.
    const envVars = await db
      .selectFrom("projectEnvVar")
      .select(["id"])
      .where("projectId", "=", projectId)
      .execute()
    expect(envVars).toHaveLength(0)

    /*
      And the billing history is untouched — `RETAINED_ON_DELETE`, ADR 0017.

      `usage_rollup` references `project` with `ON DELETE RESTRICT` so last month's statement can
      still name the project it billed for. A teardown that took the evidence behind a bill with
      it would be worse than one that ran late.
    */
    const rollups = await db
      .selectFrom("usageRollup")
      .select(["id"])
      .where("projectId", "=", projectId)
      .execute()
    expect(rollups).toHaveLength(1)

    const project = await db
      .selectFrom("project")
      .select(["state"])
      .where("id", "=", projectId)
      .executeTakeFirst()
    expect(project?.state).toBe("deleted")

    // A repository is source owned by the customer, not a provisioned SproutOS resource.
    const repository = await db
      .selectFrom("repository")
      .select(["githubRepoId", "ownerLogin", "name"])
      .where("id", "=", repositoryId)
      .executeTakeFirstOrThrow()
    expect(repository.ownerLogin).toBe("teardown")
    expect(repository.name).toBe(`repo-${repositoryId.slice(-12)}`)
  })

  /*
    Retried, because a job is.

    Every step tolerates having been done: a delete of something absent is ignored, and the row
    writes are assignments. A teardown that failed halfway must be safe to run again — the
    alternative is a half-destroyed project nobody dares touch.
  */
  it("is safe to run twice", async ({ skip }) => {
    if (!reachable) skip()
    await expect(handler()(job({ projectId }), context())).resolves.toBeUndefined()
  })

  it("is registered under the kind the route enqueues", () => {
    expect(TEARDOWN_KIND).toBe("project.teardown")
  })
})

describe("the customer's decrypted environment", () => {
  it("leaves no second copy, because the function held the only one", async ({ skip }) => {
    /*
      This used to sweep Kubernetes Secrets by label. A revision's environment was a Secret named
      after its own contents, so a project accumulated one per environment it had ever deployed
      with and there was no list of names to walk — leaving them behind meant a customer who was
      told their data was gone while their *decrypted* values sat in a namespace indefinitely.

      A Lambda's environment lives on the function, and teardown deletes the function. So the check
      that matters is now the one below: the rows are gone, and nothing else ever held a copy.
    */
    if (!reachable) skip()

    await handler()(job({ projectId }), context())

    const remaining = await db
      .selectFrom("projectEnvVar")
      .select("id")
      .where("projectId", "=", projectId)
      .execute()
    expect(remaining).toHaveLength(0)

    // And the function that carried them is gone, not merely dereferenced.
    expect(deletedFunctions).toContain(`sproutos-app-${projectId}`)
  })
})

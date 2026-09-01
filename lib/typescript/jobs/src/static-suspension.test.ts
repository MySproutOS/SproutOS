import {
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} from "@aws-sdk/client-cloudfront-keyvaluestore"
import {
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Job } from "./queue"
import { reconcileStaticAccess } from "./static-suspension"
import type { StaticPlatform } from "./static-publish"

const userId = v7()
const organizationId = v7()
const repositoryId = v7()
const projectId = v7()
const liveDeploymentId = v7()
const previewDeploymentId = v7()
const retiredDeploymentId = v7()
const generation = v7()
const reachable = await (async () => {
  try {
    await sql`select 1 from credit_retention_state limit 0`.execute(db)
    return true
  } catch {
    return false
  }
})()

const keyOperations: string[] = []
const dnsOperations: string[] = []
const platform = {
  bucket: "static-test",
  tenantZoneId: "zone-test",
  distributionDomain: "distribution.example.test",
  keyValueStoreArn: "arn:aws:cloudfront::test:key-value-store/test",
  s3: { send: () => Promise.resolve({}) },
  keyValueStore: {
    send: (command: unknown) => {
      if (command instanceof DescribeKeyValueStoreCommand) return Promise.resolve({ ETag: "v1" })
      if (command instanceof DeleteKeyCommand) {
        keyOperations.push(`delete:${command.input.Key}`)
        return Promise.resolve({})
      }
      if (command instanceof PutKeyCommand) {
        keyOperations.push(`put:${command.input.Key}:${command.input.Value}`)
        return Promise.resolve({})
      }
      return Promise.reject(new Error("unexpected key-value-store command"))
    },
  },
  route53: {
    send: (command: unknown) => {
      if (command instanceof ListResourceRecordSetsCommand) {
        return Promise.resolve({ ResourceRecordSets: [] })
      }
      if (command instanceof ChangeResourceRecordSetsCommand) {
        dnsOperations.push(command.input.ChangeBatch?.Changes?.[0]?.Action ?? "unknown")
        return Promise.resolve({})
      }
      return Promise.reject(new Error("unexpected Route 53 command"))
    },
  },
} as unknown as StaticPlatform

beforeAll(async () => {
  if (!reachable) return
  await db
    .insertInto("user")
    .values({ id: userId, email: `${userId}@test.invalid` })
    .execute()
  await db
    .insertInto("organization")
    .values({
      id: organizationId,
      ownerUserId: userId,
      name: "Static suspension",
      slug: `static-suspension-${organizationId.slice(-12)}`,
      kind: "team",
    })
    .execute()
  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId,
      githubRepoId: Number(BigInt(Date.now()) % 1_000_000_000n),
      ownerLogin: "static-suspension",
      name: `static-${repositoryId.slice(-12)}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId,
      repositoryId,
      name: "Static suspension",
      slug: `static-${projectId.slice(-12)}`,
      servingMode: "static",
    })
    .execute()
  await db
    .insertInto("deployment")
    .values([
      {
        id: liveDeploymentId,
        projectId,
        kind: "production",
        gitSha: "a".repeat(40),
        status: "ready",
        preset: "static",
        staticDigest: "a".repeat(64),
        staticArtifactKey: `static/${projectId}/${"a".repeat(64)}.zip`,
        hostname: "live.static.example.test",
      },
      {
        id: previewDeploymentId,
        projectId,
        kind: "preview",
        prNumber: 42,
        gitSha: "b".repeat(40),
        status: "ready",
        preset: "static",
        staticDigest: "b".repeat(64),
        staticArtifactKey: `static/${projectId}/${"b".repeat(64)}.zip`,
        hostname: "preview.static.example.test",
      },
      {
        id: retiredDeploymentId,
        projectId,
        kind: "production",
        gitSha: "c".repeat(40),
        status: "ready",
        preset: "static",
        staticDigest: "c".repeat(64),
        staticArtifactKey: `static/${projectId}/${"c".repeat(64)}.zip`,
        hostname: "retired.static.example.test",
      },
    ])
    .execute()
  await db.updateTable("project").set({ liveDeploymentId }).where("id", "=", projectId).execute()
  await db
    .insertInto("creditRetentionState")
    .values({
      organizationId,
      generation,
      status: "suspended",
      warningStage: "suspended",
      exhaustedAt: new Date(),
      deleteAfter: new Date(Date.now() + 48 * 60 * 60 * 1000),
    })
    .execute()
})

afterAll(async () => {
  if (!reachable) return
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = 'replica'`.execute(tx)
    await tx
      .deleteFrom("creditRetentionState")
      .where("organizationId", "=", organizationId)
      .execute()
    await tx.deleteFrom("deployment").where("projectId", "=", projectId).execute()
    await tx.deleteFrom("project").where("id", "=", projectId).execute()
    await tx.deleteFrom("repository").where("id", "=", repositoryId).execute()
    await tx.deleteFrom("organization").where("id", "=", organizationId).execute()
    await tx.deleteFrom("user").where("id", "=", userId).execute()
  })
})

describe.skipIf(!reachable)("static access suspension", () => {
  it("withdraws every serving static hostname, restores the same prefixes, and ignores stale jobs", async () => {
    const handler = reconcileStaticAccess(platform)
    const context = {
      db,
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    }
    await handler(
      {
        id: v7(),
        kind: "billing.reconcile_static_access",
        payload: { organizationId, generation, suspended: true },
      } as Job,
      context,
    )
    expect(keyOperations.toSorted()).toEqual(
      ["delete:live.static.example.test", "delete:preview.static.example.test"].toSorted(),
    )

    await db
      .updateTable("creditRetentionState")
      .set({ status: "active", warningStage: "safe", exhaustedAt: null, deleteAfter: null })
      .where("organizationId", "=", organizationId)
      .execute()
    await handler(
      {
        id: v7(),
        kind: "billing.reconcile_static_access",
        payload: { organizationId, generation, suspended: false },
      } as Job,
      context,
    )
    expect(keyOperations.toSorted()).toEqual(
      [
        "delete:live.static.example.test",
        "delete:preview.static.example.test",
        `put:live.static.example.test:${projectId}/${"a".repeat(64)}`,
        `put:preview.static.example.test:${projectId}/${"b".repeat(64)}`,
      ].toSorted(),
    )
    expect(dnsOperations).toEqual(["UPSERT", "UPSERT"])

    await handler(
      {
        id: v7(),
        kind: "billing.reconcile_static_access",
        payload: { organizationId, generation: v7(), suspended: true },
      } as Job,
      context,
    )
    expect(keyOperations).toHaveLength(4)
  })
})

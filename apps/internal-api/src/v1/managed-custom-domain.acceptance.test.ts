import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { readRoute } from "@lib/lambda"
import { reconcileCustomDomain } from "@lib/jobs"
import { db } from "@sproutos/db"
import { Redis } from "ioredis"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"
import { createHash } from "node:crypto"

const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566"
const s3 = new S3Client({
  endpoint,
  forcePathStyle: true,
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
})
const valkey = new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023", {
  lazyConnect: true,
  connectTimeout: 500,
})
const databaseUp = await databaseReachable()
const providersUp = await (async () => {
  if (!databaseUp) return false
  try {
    await valkey.connect()
    const response = await fetch(`${endpoint}/_localstack/health`, {
      signal: AbortSignal.timeout(1_500),
    })
    return response.ok && (await valkey.ping()) === "PONG"
  } catch {
    return false
  }
})()

let owner: TestUser | undefined
let organizationId = ""
let organizationSlug = ""
let policyId = ""
let projectId = ""
let deploymentId = ""
let domainId = ""
const hostname = `provider-${v7().slice(-12)}.sproutos.biz`
const bucket = `managed-domain-${v7()}`

function certificateVersionKey(objectVersion: string): string {
  return createHash("sha256").update(objectVersion).digest("hex")
}

async function emptyVersionedBucket() {
  const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }))
  const objects = [
    ...(listed.Versions ?? []).map(({ Key, VersionId }) => ({ Key, VersionId })),
    ...(listed.DeleteMarkers ?? []).map(({ Key, VersionId }) => ({ Key, VersionId })),
  ].filter(
    (object): object is { Key: string; VersionId: string } =>
      object.Key !== undefined && object.VersionId !== undefined,
  )
  if (objects.length > 0) {
    await s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
    )
  }
}

describe.runIf(providersUp)("managed custom domain provider-shaped acceptance", () => {
  beforeAll(async () => {
    vi.stubEnv("CUSTOM_DOMAINS_ENABLED", "1")
    vi.stubEnv("TENANT_INGRESS_HOST", "ingress.sproutos.run")
    vi.stubEnv("TENANT_CERTIFICATE_BUCKET", bucket)
    vi.stubEnv("TENANT_CERTIFICATE_KMS_KEY_ARN", "alias/sproutos-dev")
    vi.stubEnv("ACME_DIRECTORY_URL", "https://acme.provider-shaped.invalid/directory")
    vi.stubEnv("AWS_ACCOUNT_ID", "123456789012")
    vi.stubEnv("AWS_REGION", "us-east-1")
    vi.stubEnv("VALKEY_URL", process.env.VALKEY_URL ?? "redis://localhost:41023")

    await s3.send(new CreateBucketCommand({ Bucket: bucket }))
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    )

    owner = await createTestUser("managed-domain-provider")
    await db.updateTable("user").set({ isAdmin: true }).where("id", "=", owner.id).execute()
    const organizationResponse = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ name: `Managed Domain ${v7()}` }),
    })
    const organization = (await organizationResponse.json()) as { id: string; slug: string }
    if (organizationResponse.status !== 201) {
      throw new Error(`Organization setup failed with ${organizationResponse.status}`)
    }
    organizationId = trackOrganization(organization.id)
    organizationSlug = organization.slug

    const policyResponse = await app.request("/admin/managed-domain-policies", {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ suffix: "sproutos.biz", organizationId }),
    })
    if (policyResponse.status !== 201) {
      throw new Error(`Policy setup failed with ${policyResponse.status}`)
    }
    policyId = ((await policyResponse.json()) as { id: string }).id

    const repositoryId = v7()
    projectId = v7()
    deploymentId = v7()
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId,
        githubRepoId: BigInt(Date.now()),
        ownerLogin: "provider-shaped",
        name: `managed-${repositoryId}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id: projectId,
        organizationId,
        repositoryId,
        name: "Managed domain acceptance",
        slug: `managed-${projectId.slice(-12)}`,
        servingMode: "serverless",
      })
      .execute()
    await db
      .insertInto("deployment")
      .values({
        id: deploymentId,
        projectId,
        kind: "production",
        gitSha: "a".repeat(40),
        status: "ready",
        preset: "node",
        lambdaVersion: "7",
      })
      .execute()
    await db
      .updateTable("project")
      .set({ liveDeploymentId: deploymentId })
      .where("id", "=", projectId)
      .execute()

    const claimed = await app.request(
      `/v1/orgs/${organization.slug}/projects/${projectId}/domains`,
      {
        method: "POST",
        headers: authHeaders(owner),
        body: JSON.stringify({ hostname }),
      },
    )
    if (claimed.status !== 201) {
      throw new Error(`Managed domain claim failed with ${claimed.status}`)
    }
    const claim = (await claimed.json()) as {
      id: string
      domainKind: string
      instructions: { verification: { required: boolean; name: string | null } }
    }
    domainId = claim.id
    if (
      claim.domainKind !== "managed" ||
      claim.instructions.verification.required ||
      claim.instructions.verification.name !== null
    ) {
      throw new Error("Managed domain claim unexpectedly required ownership TXT verification")
    }

    const otherOrganizationResponse = await app.request("/v1/orgs", {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ name: `Managed Domain Other ${v7()}` }),
    })
    const otherOrganization = (await otherOrganizationResponse.json()) as {
      id: string
      slug: string
    }
    trackOrganization(otherOrganization.id)
    const otherRepositoryId = v7()
    const otherProjectId = v7()
    await db
      .insertInto("repository")
      .values({
        id: otherRepositoryId,
        organizationId: otherOrganization.id,
        githubRepoId: BigInt(Date.now() + 1),
        ownerLogin: "provider-shaped",
        name: `managed-${otherRepositoryId}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id: otherProjectId,
        organizationId: otherOrganization.id,
        repositoryId: otherRepositoryId,
        name: "Other organization",
        slug: `managed-${otherProjectId.slice(-12)}`,
        servingMode: "serverless",
      })
      .execute()
    const isolated = await app.request(
      `/v1/orgs/${otherOrganization.slug}/projects/${otherProjectId}/domains`,
      {
        method: "POST",
        headers: authHeaders(owner),
        body: JSON.stringify({ hostname: `other-${v7().slice(-8)}.sproutos.biz` }),
      },
    )
    if (isolated.status !== 409) {
      throw new Error(`Organization isolation returned ${isolated.status}, expected 409`)
    }
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await valkey.del(`route:${hostname}`, `custom-domain:pending:${hostname}`)
    await valkey.zrem("cert:serving-replicas", "provider-shaped-router")
    await emptyVersionedBucket()
    if (domainId !== "") await db.deleteFrom("customDomain").where("id", "=", domainId).execute()
    if (policyId !== "") {
      await db.deleteFrom("managedCustomDomainPolicy").where("id", "=", policyId).execute()
    }
    await cleanupFixtures()
    const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }))
    if ([...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].length !== 0) {
      throw new Error("Provider-shaped certificate cleanup left S3 object versions behind")
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }))
    valkey.disconnect()
    await db.destroy()
  })

  it("claims, issues, renews, routes, and tears down without an ownership TXT record", async () => {
    const txt = vi.fn<() => Promise<string[][]>>(() => Promise.reject(new Error("no TXT")))
    let issuance = 0
    const now = new Date("2026-09-03T12:00:00Z")
    const handler = reconcileCustomDomain({
      now: () => now,
      resolver: {
        resolveTxt: txt,
        resolveCname: () => Promise.resolve(["ingress.sproutos.run."]),
        resolve4: () => Promise.resolve([]),
        resolve6: () => Promise.resolve([]),
      },
      issue: (_dependencies, requestedHostname) => {
        expect(requestedHostname).toBe(hostname)
        issuance += 1
        return Promise.resolve({
          certificatePem: `certificate-${issuance}`,
          privateKeyPem: `private-key-${issuance}`,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000),
        })
      },
      scheduleIssued: () =>
        Promise.resolve({
          certificateId: `aki.${issuance}`,
          issuer: "CN=Provider-shaped CA",
          nextRenewalAt: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1_000),
          renewalInfoRetryAt: null,
          renewalInfoExplanationUrl: null,
          source: "unsupported",
        }),
      s3,
      valkey,
    })
    const context = {
      db,
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    }

    await handler({ payload: { domainId } } as never, context)
    expect(txt).not.toHaveBeenCalled()
    expect(issuance).toBe(1)
    let domain = await db
      .selectFrom("customDomain")
      .selectAll()
      .where("id", "=", domainId)
      .executeTakeFirstOrThrow()
    expect(domain.status).toBe("propagating")
    const stored = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: domain.certificateObjectKey! }),
    )
    expect(JSON.parse((await stored.Body?.transformToString()) ?? "{}")).toMatchObject({
      hostname,
      certificatePem: "certificate-1",
      privateKeyPem: "private-key-1",
    })

    await valkey.zadd("cert:serving-replicas", Date.now() + 60_000, "provider-shaped-router")
    await valkey.set(
      `cert:loaded:${hostname}:${certificateVersionKey(domain.certificateObjectVersion!)}:provider-shaped-router`,
      "1",
      "EX",
      60,
    )
    await handler({ payload: { domainId } } as never, context)
    expect(await readRoute(valkey, hostname)).toMatchObject({
      projectId,
      organizationId,
      deploymentId,
    })

    await db
      .updateTable("customDomain")
      .set({ nextRenewalAt: new Date(now.getTime() - 1), nextRetryAt: now })
      .where("id", "=", domainId)
      .execute()
    await handler({ payload: { domainId } } as never, context)
    expect(issuance).toBe(2)
    domain = await db
      .selectFrom("customDomain")
      .selectAll()
      .where("id", "=", domainId)
      .executeTakeFirstOrThrow()
    await valkey.set(
      `cert:loaded:${hostname}:${certificateVersionKey(domain.certificateObjectVersion!)}:provider-shaped-router`,
      "1",
      "EX",
      60,
    )
    await handler({ payload: { domainId } } as never, context)
    expect(
      await db
        .selectFrom("customDomain")
        .select("status")
        .where("id", "=", domainId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "active" })

    const deletion = await app.request(
      `/v1/orgs/${organizationSlug}/projects/${projectId}/domains/${domainId}`,
      { method: "DELETE", headers: authHeaders(owner!) },
    )
    expect(deletion.status).toBe(204)
    await handler({ payload: { domainId } } as never, context)
    expect(await readRoute(valkey, hostname)).toBeUndefined()
    const deletedDomain = await db
      .selectFrom("customDomain")
      .select("deletedAt")
      .where("id", "=", domainId)
      .executeTakeFirstOrThrow()
    expect(deletedDomain.deletedAt).toBeInstanceOf(Date)
  })
})

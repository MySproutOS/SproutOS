/* oxlint-disable no-await-in-loop -- teardown follows foreign-key order */
import {
  DeleteObjectCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { db } from "@sproutos/db"
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { v7 } from "uuid"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"

const databaseIsReachable = await databaseReachable()
const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566"
const storageIsReachable = await (async () => {
  try {
    const response = await fetch(`${endpoint}/_localstack/health`, {
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
})()
const bucket = process.env.ANDROID_ARTIFACT_BUCKET ?? "sproutos-dev-artifacts"
const publicApk = Buffer.from("public Android fixture")
const personalizedApk = Buffer.from("personalized Android fixture")
const catalogueImportId = v7()
const catalogueOciDigest = createHash("sha256").update(`oci:${catalogueImportId}`).digest("hex")
const catalogueDigest = createHash("sha256").update(`catalogue:${catalogueImportId}`).digest("hex")

type SeededApp = {
  androidAppId: string
  deploymentId: string
  jobId: string
  objectKey: string
  objectVersion: string
  projectId: string
  repositoryId: string
}

const seededApps: SeededApp[] = []

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function packageName(projectId: string): string {
  return `me.sproutos.app.p${projectId.replaceAll("-", "")}`
}

async function seedInstallableApp(input: {
  bytes: Buffer
  label: string
  organizationId: string
  listingId: string
}): Promise<SeededApp> {
  const repositoryId = v7()
  const projectId = v7()
  const deploymentId = v7()
  const androidAppId = v7()
  const jobId = v7()
  const suffix = projectId.slice(-12)
  const objectKey = `android-route-test/${projectId}.apk`

  await db
    .insertInto("repository")
    .values({
      id: repositoryId,
      organizationId: input.organizationId,
      githubRepoId: BigInt(`0x${suffix}`),
      ownerLogin: "sproutos-test",
      name: `android-${suffix}`,
      provenance: "new",
    })
    .execute()
  await db
    .insertInto("project")
    .values({
      id: projectId,
      organizationId: input.organizationId,
      repositoryId,
      name: input.label,
      slug: `android${suffix.slice(0, 8)}`,
      storeListingId: input.listingId,
    })
    .execute()
  await db
    .insertInto("deployment")
    .values({
      id: deploymentId,
      projectId,
      kind: "production",
      preset: "android",
      gitSha: "d".repeat(40),
      status: "ready",
    })
    .execute()

  const s3 = new S3Client({
    endpoint,
    forcePathStyle: true,
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  })
  const uploaded = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: input.bytes,
      ContentType: "application/vnd.android.package-archive",
    }),
  )
  s3.destroy()
  if (uploaded.VersionId === undefined) throw new Error("fixture upload was not versioned")

  await db
    .insertInto("androidApp")
    .values({
      id: androidAppId,
      projectId,
      packageName: packageName(projectId),
      certificateSha256: "b".repeat(64),
      keyObjectKey: `keys/${androidAppId}.enc`,
      keyObjectVersion: "key-v1",
      developerConsoleState: "registered",
      developerConsoleProviderState: "REGISTERED",
      verifiedSetupCommit: "e".repeat(40),
      latestGoodDeploymentId: deploymentId,
      lastAcceptedVersionCode: 7,
    })
    .execute()
  await db
    .insertInto("androidSignerJob")
    .values({
      id: jobId,
      androidAppId,
      kind: "sign_release",
      state: "succeeded",
      deploymentId,
      projectId,
      unsignedKey: `unsigned/${projectId}.apk`,
      unsignedDigest: "a".repeat(64),
      signedKey: objectKey,
      signedObjectVersion: uploaded.VersionId,
      signedDigest: sha256(input.bytes),
      signedSizeBytes: BigInt(input.bytes.length),
      versionCode: 7,
      versionName: "1.0.0",
      inputMime: "application/vnd.android.package-archive",
    })
    .execute()

  const seeded = {
    androidAppId,
    deploymentId,
    jobId,
    objectKey,
    objectVersion: uploaded.VersionId,
    projectId,
    repositoryId,
  }
  seededApps.push(seeded)
  return seeded
}

async function catalogue(user: TestUser | null) {
  return await app.request("/v1/android/catalogue", {
    headers: user === null ? undefined : authHeaders(user),
  })
}

async function selectCanonicalRelease(
  user: TestUser,
  listingId: string,
  androidAppId: string | null,
) {
  return await app.request(`/admin/store/listings/${listingId}/android-release`, {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify({ androidAppId }),
  })
}

describe.runIf(databaseIsReachable && storageIsReachable)(
  "Android public and personal catalogue",
  () => {
    let owner: TestUser
    let platformAdmin: TestUser
    let stranger: TestUser
    let canonicalApp: SeededApp
    let listingId: string
    let organizationSlug: string
    let personalizedApp: SeededApp

    beforeAll(async () => {
      const s3 = new S3Client({
        endpoint,
        forcePathStyle: true,
        region: process.env.AWS_REGION ?? "us-east-1",
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      })
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      )
      s3.destroy()

      owner = await createTestUser("androidcatalogueowner")
      platformAdmin = await createTestUser("androidcatalogueplatformadmin")
      await db
        .updateTable("user")
        .set({ isAdmin: true })
        .where("id", "=", platformAdmin.id)
        .execute()
      stranger = await createTestUser("androidcataloguestranger")
      const created = await app.request("/v1/orgs", {
        method: "POST",
        headers: authHeaders(owner),
        body: JSON.stringify({ name: "Android Catalogue Owner" }),
      })
      if (created.status !== 201) {
        throw new Error(`fixture setup failed: POST /v1/orgs returned ${created.status}`)
      }
      const organization = (await created.json()) as { id: string; slug: string }
      trackOrganization(organization.id)
      organizationSlug = organization.slug
      listingId = v7()

      await db
        .insertInto("deploymentCatalogueImport")
        .values({
          id: catalogueImportId,
          ociRepository: "ghcr.io/mysproutos/deployment-catalogue",
          ociDigest: `sha256:${catalogueOciDigest}`,
          catalogueDigest: `sha256:${catalogueDigest}`,
          sourceRepository: "MySproutOS/Deployment-Templates",
          workflowRef:
            "MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main",
          sourceRef: "refs/heads/main",
          sourceSha: "3".repeat(40),
          signatureIdentity:
            "https://github.com/MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main",
          signatureIssuer: "https://token.actions.githubusercontent.com",
          provenance: { fixture: true },
        })
        .execute()

      await db
        .insertInto("storeListing")
        .values({
          id: listingId,
          slug: `android-route-${listingId.slice(-12)}`,
          name: "Public Notes",
          tagline: "A public Android fixture",
          descriptionMd: "Public Android fixture used for catalogue acceptance.",
          upstreamOwner: "sproutos-test",
          upstreamRepo: `android-${listingId.slice(-12)}`,
          upstreamRepoUrl: `https://github.com/sproutos-test/android-${listingId.slice(-12)}`,
          platform: "android",
          status: "published",
          catalogueEntryId: `android-route-${listingId}`,
          catalogueImportId,
          catalogueSchemaVersion: 1,
          catalogueManifest: { fixture: true },
          upstreamCommit: "c".repeat(40),
          templatePluginRepository: "ghcr.io/mysproutos/android-route-test",
          templatePluginDigest: `sha256:${"f".repeat(64)}`,
          capabilityVerifiedAt: new Date(),
          e2eVerifiedAt: new Date(),
        })
        .execute()

      canonicalApp = await seedInstallableApp({
        bytes: publicApk,
        label: "Public Notes",
        organizationId: organization.id,
        listingId,
      })
      personalizedApp = await seedInstallableApp({
        bytes: personalizedApk,
        label: "Owner Personalized Fork",
        organizationId: organization.id,
        listingId,
      })
      const selected = await selectCanonicalRelease(
        platformAdmin,
        listingId,
        canonicalApp.androidAppId,
      )
      if (selected.status !== 200) {
        throw new Error(`fixture setup failed: canonical release returned ${selected.status}`)
      }
    })

    afterAll(async () => {
      const s3 = new S3Client({
        endpoint,
        forcePathStyle: true,
        region: process.env.AWS_REGION ?? "us-east-1",
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      })
      for (let index = seededApps.length - 1; index >= 0; index -= 1) {
        const row = seededApps[index]
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: row.objectKey,
            VersionId: row.objectVersion,
          }),
        )
        await db.deleteFrom("androidSignerJob").where("id", "=", row.jobId).execute()
        await db.deleteFrom("androidApp").where("id", "=", row.androidAppId).execute()
        await db.deleteFrom("deployment").where("id", "=", row.deploymentId).execute()
        await db.deleteFrom("project").where("id", "=", row.projectId).execute()
        await db.deleteFrom("repository").where("id", "=", row.repositoryId).execute()
      }
      s3.destroy()
      await db.deleteFrom("storeListing").where("id", "=", listingId).execute()
      await db.deleteFrom("deploymentCatalogueImport").where("id", "=", catalogueImportId).execute()
      await cleanupFixtures()
      await db.destroy()
    })

    it("shows only public apps anonymously and makes the public APK downloadable", async () => {
      const response = await catalogue(null)
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      const body = (await response.json()) as {
        public: { apps: { downloadUrl: string; label: string }[] }
        personal: { apps: unknown[]; sites: unknown[] }
      }
      expect(body.public.apps.map((entry) => entry.label)).toStrictEqual(["Public Notes"])
      expect(body.personal).toStrictEqual({ apps: [], sites: [] })
      const downloaded = await fetch(body.public.apps[0].downloadUrl)
      expect(downloaded.status).toBe(200)
      expect(Buffer.from(await downloaded.arrayBuffer())).toStrictEqual(publicApk)
    })

    it("records platform-admin canonical selection in the global audit trail", async () => {
      const audit = await db
        .selectFrom("auditLog")
        .select(["organizationId", "actorUserId", "action", "after"])
        .where("actorUserId", "=", platformAdmin.id)
        .where("action", "=", "admin:store:android-release")
        .orderBy("createdAt", "asc")
        .executeTakeFirstOrThrow()
      expect(audit.organizationId).toBeNull()
      expect(audit.actorUserId).toBe(platformAdmin.id)
      expect(audit.after).toMatchObject({
        listingId,
        canonicalAndroidAppId: canonicalApp.androidAppId,
      })
    })

    it("refuses an ordinary organization owner both replacement and removal", async () => {
      const replace = await selectCanonicalRelease(owner, listingId, personalizedApp.androidAppId)
      expect(replace.status).toBe(403)
      const clear = await selectCanonicalRelease(owner, listingId, null)
      expect(clear.status).toBe(403)

      // The former org-scoped route must not remain as an alternate wildcard-authorized path.
      const formerRoute = await app.request(
        `/v1/orgs/${organizationSlug}/store/listings/${listingId}/android-release`,
        {
          method: "POST",
          headers: authHeaders(owner),
          body: JSON.stringify({ androidAppId: personalizedApp.androidAppId }),
        },
      )
      expect(formerRoute.status).toBe(404)
      const indirectClear = await app.request(
        `/v1/orgs/${organizationSlug}/store/listings/${listingId}/unpublish`,
        {
          method: "POST",
          headers: authHeaders(owner),
          body: JSON.stringify({ status: "archived" }),
        },
      )
      expect(indirectClear.status).toBe(403)

      const unrelatedProjects = await app.request(`/v1/orgs/${organizationSlug}/projects`, {
        headers: authHeaders(owner),
      })
      expect(unrelatedProjects.status).toBe(200)
      expect(
        await db
          .selectFrom("storeListing")
          .select("canonicalAndroidAppId")
          .where("id", "=", listingId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ canonicalAndroidAppId: canonicalApp.androidAppId })
    })

    it("rejects a release that is not a ready signed app from the listing", async () => {
      const response = await selectCanonicalRelease(platformAdmin, listingId, v7())
      expect(response.status).toBe(400)
      expect(
        await db
          .selectFrom("storeListing")
          .select("canonicalAndroidAppId")
          .where("id", "=", listingId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ canonicalAndroidAppId: canonicalApp.androidAppId })
    })

    it("shows the owner's personalized fork, with a working owner-only catalogue URL", async () => {
      const response = await catalogue(owner)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        public: { apps: { label: string }[] }
        personal: { apps: { downloadUrl: string; label: string }[] }
      }
      expect(body.public.apps.map((entry) => entry.label)).toStrictEqual(["Public Notes"])
      expect(body.personal.apps.map((entry) => entry.label)).toStrictEqual([
        "Owner Personalized Fork",
        "Public Notes",
      ])
      const personalEntry = body.personal.apps.find(
        (entry) => entry.label === "Owner Personalized Fork",
      )!
      const downloaded = await fetch(personalEntry.downloadUrl)
      expect(downloaded.status).toBe(200)
      expect(Buffer.from(await downloaded.arrayBuffer())).toStrictEqual(personalizedApk)
    })

    it("does not leak a same-listing personalized fork to anonymous or another user", async () => {
      const response = await catalogue(stranger)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        public: { apps: { label: string }[] }
        personal: { apps: unknown[]; sites: unknown[] }
      }
      expect(body.public.apps.map((entry) => entry.label)).toStrictEqual(["Public Notes"])
      expect(body.personal).toStrictEqual({ apps: [], sites: [] })
      expect(JSON.stringify(body)).not.toContain("Owner Personalized Fork")
    })

    it("enforces access when issuing a URL; an already-issued URL remains valid until expiry", async () => {
      const issued = await catalogue(null)
      const issuedBody = (await issued.json()) as {
        public: { apps: { downloadUrl: string; label: string }[] }
      }
      const issuedUrl = issuedBody.public.apps[0].downloadUrl

      const removed = await selectCanonicalRelease(platformAdmin, listingId, null)
      expect(removed.status).toBe(200)
      const afterRemoval = await catalogue(null)
      const afterRemovalBody = (await afterRemoval.json()) as { public: { apps: unknown[] } }
      expect(afterRemovalBody.public.apps).toStrictEqual([])

      // Presigned object-storage URLs are bearer URLs. Removing the association prevents a new
      // URL from being issued, but cannot revoke one that was already issued (one-hour expiry).
      const staleDownload = await fetch(issuedUrl)
      expect(staleDownload.status).toBe(200)
      expect(Buffer.from(await staleDownload.arrayBuffer())).toStrictEqual(publicApk)

      const restored = await selectCanonicalRelease(
        platformAdmin,
        listingId,
        canonicalApp.androidAppId,
      )
      expect(restored.status).toBe(200)
    })
  },
)

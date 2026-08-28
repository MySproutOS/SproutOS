import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import {
  type AndroidApp,
  type AndroidSite,
  buildCatalogue,
  CATALOGUE_TTL_SECONDS,
  toApp,
} from "@lib/services"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { authNoThrowMiddleware } from "../middleware"

/**
 * The catalogue the SproutOS Android client reads (§11.3).
 *
 * **Authenticated optionally, on purpose.** The public tab is public — somebody deciding whether to
 * install the client should be able to see what is on it — and the personal tab is built from the
 * caller's own organizations. An unauthenticated request gets a catalogue with an empty personal
 * half rather than a 401, so the client's tab says there is nothing there instead of failing.
 *
 * Every APK is private in object storage and reached through a signed URL that expires with the
 * catalogue. There is no public bucket and no permanent link: a removed app stops being reachable
 * within the hour, and a URL copied out of the response is not a distribution channel.
 */

function bucket(): string {
  return process.env.SERVICE_BUILD_BUCKET ?? "sproutos-dev-artifacts"
}

function s3(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: process.env.AWS_ENDPOINT_URL, forcePathStyle: true }),
  })
}

/**
 * Signed APK downloads for a set of deployments.
 *
 * Signed in one pass rather than per row inside the query loop: presigning is local HMAC work with
 * no network call, but doing it inside a loop that also awaits the database turns one round trip
 * into N.
 */
async function signAll(client: S3Client, rows: { key: string }[]): Promise<Map<string, string>> {
  const signed = await Promise.all(
    rows.map(async (row) => {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket(), Key: row.key }),
        // The same lifetime as the catalogue. A URL that outlived it would survive a revocation;
        // one that expired sooner would be a button that fails.
        { expiresIn: CATALOGUE_TTL_SECONDS },
      )
      return [row.key, url] as const
    }),
  )

  return new Map(signed)
}

const app: Hono = new Hono().get(
  "/android/catalogue",
  describeRoute({
    description:
      "Everything the SproutOS Android client shows: public apps, and the caller's own apps and sites.",
    responses: { 200: { description: "The catalogue" } },
  }),
  authNoThrowMiddleware,
  async (c) => {
    const user = c.var.user

    /*
      Published Android apps, from the signing queue's own record of what was signed.

      `apk_signing_job` is the only place that knows an APK exists and is signed — the deployment
      row says a release happened, not that it produced an installable artefact. Joining through it
      is what keeps an unsigned build out of the catalogue.
    */
    const publicRows = await db
      .selectFrom("apkSigningJob")
      .innerJoin("deployment", "deployment.id", "apkSigningJob.deploymentId")
      .innerJoin("project", "project.id", "apkSigningJob.projectId")
      .innerJoin(
        "androidDeveloperRegistration",
        "androidDeveloperRegistration.projectId",
        "project.id",
      )
      .innerJoin("storeListing", "storeListing.id", "project.storeListingId")
      .select([
        "storeListing.name as label",
        // `description_md` is the only prose the listing has; the client shows its first line.
        "storeListing.descriptionMd as summary",
        "apkSigningJob.signedKey as signedKey",
        "apkSigningJob.signedDigest as sha256",
        "deployment.gitSha as gitSha",
        "androidDeveloperRegistration.packageName as packageName",
      ])
      .where("apkSigningJob.status", "=", "signed")
      .where("deployment.status", "=", "ready")
      .where("androidDeveloperRegistration.state", "=", "registered")
      .where("androidDeveloperRegistration.providerState", "=", "REGISTERED")
      .where("androidDeveloperRegistration.verifiedSetupCommit", "is not", null)
      .where("storeListing.platform", "=", "android")
      .where("storeListing.status", "=", "published")
      .where("storeListing.deletedAt", "is", null)
      .where("project.deletedAt", "is", null)
      .execute()

    const personalRows =
      user === null
        ? []
        : await db
            .selectFrom("apkSigningJob")
            .innerJoin("deployment", "deployment.id", "apkSigningJob.deploymentId")
            .innerJoin("project", "project.id", "apkSigningJob.projectId")
            .innerJoin(
              "androidDeveloperRegistration",
              "androidDeveloperRegistration.projectId",
              "project.id",
            )
            .innerJoin(
              "organizationMember",
              "organizationMember.organizationId",
              "project.organizationId",
            )
            .select([
              "project.name as label",
              "apkSigningJob.signedKey as signedKey",
              "apkSigningJob.signedDigest as sha256",
              "deployment.gitSha as gitSha",
              "androidDeveloperRegistration.packageName as packageName",
            ])
            .where("apkSigningJob.status", "=", "signed")
            .where("deployment.status", "=", "ready")
            .where("androidDeveloperRegistration.state", "=", "registered")
            .where("androidDeveloperRegistration.providerState", "=", "REGISTERED")
            .where("androidDeveloperRegistration.verifiedSetupCommit", "is not", null)
            .where("organizationMember.userId", "=", user.id)
            .where("project.deletedAt", "is", null)
            .execute()

    // The caller's own deployed websites, which sit beside their apps in the personal tab.
    const siteRows =
      user === null
        ? []
        : await db
            .selectFrom("deployment")
            .innerJoin("project", "project.id", "deployment.projectId")
            .innerJoin(
              "organizationMember",
              "organizationMember.organizationId",
              "project.organizationId",
            )
            .select(["project.name as name", "deployment.url as url"])
            .where("organizationMember.userId", "=", user.id)
            .where("deployment.kind", "=", "production")
            .where("deployment.status", "=", "ready")
            .where("deployment.url", "is not", null)
            .where("project.deletedAt", "is", null)
            .where("deployment.deletedAt", "is", null)
            .execute()

    const client = s3()
    const keys = [...publicRows, ...personalRows]
      .map((row) => row.signedKey)
      .filter((key): key is string => key !== null)
      .map((key) => ({ key }))
    const urls = await signAll(client, keys)
    client.destroy()

    const asApp = (row: {
      label: string
      summary?: string | null
      signedKey: string | null
      sha256: string | null
      gitSha: string
      packageName: string
    }): AndroidApp | undefined =>
      toApp(
        {
          packageName: row.packageName,
          label: row.label,
          summary: row.summary ?? null,
          versionName: row.gitSha.slice(0, 7),
          /*
            Android compares version codes numerically and refuses to install a lower one. A commit
            sha has no order, so this is the first eight hex digits read as a number — which is
            stable per build and unique in practice, but is *not* monotonic.

            Said plainly because it is a real limitation: a customer redeploying an older commit
            could produce a lower code and find the install refused. Recording a real version code
            from the APK's manifest is the fix, and it belongs with reading the package name.
          */
          versionCode: Number.parseInt(row.gitSha.slice(0, 8), 16),
          sha256: row.sha256,
          sizeBytes: 0,
          signedKey: row.signedKey,
          iconUrl: null,
        },
        (key) => urls.get(key) ?? "",
      )

    const catalogue = buildCatalogue({
      publicApps: publicRows.map(asApp).filter((entry): entry is AndroidApp => entry !== undefined),
      personalApps: personalRows
        .map(asApp)
        .filter((entry): entry is AndroidApp => entry !== undefined),
      personalSites: siteRows
        .filter((row): row is { name: string; url: string } => row.url !== null)
        .map((row): AndroidSite => ({ name: row.name, url: row.url, summary: "" })),
    })

    // Never cached by a shared cache: half of it is the caller's own, and the URLs inside expire.
    c.header("Cache-Control", "private, no-store")
    return c.json(catalogue)
  },
)

export default app

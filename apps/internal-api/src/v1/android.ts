import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { fetchAndroidApp } from "@lib/dao"
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

function bucket(): string {
  const configured = process.env.ANDROID_ARTIFACT_BUCKET
  if (configured !== undefined && configured !== "") return configured
  if (process.env.NODE_ENV === "production") throw new Error("ANDROID_ARTIFACT_BUCKET is required")
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

async function signAll(
  client: S3Client,
  objects: { key: string; version: string }[],
): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(
      objects.map(
        async ({ key, version }) =>
          [
            `${key}:${version}`,
            await getSignedUrl(
              client,
              new GetObjectCommand({ Bucket: bucket(), Key: key, VersionId: version }),
              { expiresIn: CATALOGUE_TTL_SECONDS },
            ),
          ] as const,
      ),
    ),
  )
}

const app: Hono = new Hono().get(
  "/android/catalogue",
  describeRoute({
    description: "The verified public and caller-owned Android apps and deployed sites.",
    responses: { 200: { description: "Catalogue version 2" } },
  }),
  authNoThrowMiddleware,
  async (c) => {
    const user = c.var.user
    const [publicRows, personalRows, siteRows] = await Promise.all([
      fetchAndroidApp(db).listPublicCatalogue(),
      user === null ? [] : fetchAndroidApp(db).listPersonalCatalogue(user.id),
      user === null ? [] : fetchAndroidApp(db).listPersonalSites(user.id),
    ])
    const client = s3()
    let urls: Map<string, string>
    try {
      urls = await signAll(
        client,
        [...publicRows, ...personalRows].flatMap((row) =>
          row.signedKey === null || row.signedObjectVersion === null
            ? []
            : [{ key: row.signedKey, version: row.signedObjectVersion }],
        ),
      )
    } finally {
      client.destroy()
    }

    const asApp = (row: {
      androidAppId: string
      projectId: string
      packageName: string
      label: string
      summary?: string | null
      versionName: string | null
      versionCode: number | null
      sha256: string | null
      sizeBytes: string | null
      signedKey: string | null
      signedObjectVersion: string | null
      certificateSha256: string | null
    }): AndroidApp | undefined =>
      toApp(
        {
          androidAppId: row.androidAppId,
          projectId: row.projectId,
          packageName: row.packageName,
          label: row.label,
          summary: row.summary ?? null,
          versionName: row.versionName,
          versionCode: row.versionCode,
          sha256: row.sha256,
          sizeBytes:
            row.sizeBytes === null ||
            BigInt(row.sizeBytes) <= 0n ||
            BigInt(row.sizeBytes) > BigInt(Number.MAX_SAFE_INTEGER)
              ? null
              : Number(row.sizeBytes),
          signedKey: row.signedKey,
          signedObjectVersion: row.signedObjectVersion,
          certificateSha256: row.certificateSha256,
          iconUrl: null,
        },
        (key) => urls.get(`${key}:${row.signedObjectVersion}`) ?? "",
      )

    const catalogue = buildCatalogue({
      publicApps: publicRows.map(asApp).filter((entry): entry is AndroidApp => entry !== undefined),
      personalApps: personalRows
        .map(asApp)
        .filter((entry): entry is AndroidApp => entry !== undefined),
      personalSites: siteRows
        .filter((row) => row.url !== null)
        .map((row): AndroidSite => ({ name: row.name, url: row.url!, summary: "" })),
    })
    c.header("Cache-Control", "private, no-store")
    return c.json(catalogue)
  },
)

export default app

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { fetchClientRelease } from "@lib/dao"
import { CATALOGUE_TTL_SECONDS, toClientUpdate } from "@lib/services"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { ErrorSchemaResponse } from "../utils/errors/error.serializer"
import { throwInternalServerError, throwNotFound } from "../utils/http-exception"
import { clientReleaseSchemaResponse } from "./client-release.serializer"

function artifactBucket(): string {
  const configured = process.env.ANDROID_ARTIFACT_BUCKET
  if (configured !== undefined && configured !== "") return configured
  if (process.env.NODE_ENV === "production") throw new Error("ANDROID_ARTIFACT_BUCKET is required")
  return process.env.SERVICE_BUILD_BUCKET ?? "sproutos-dev-artifacts"
}

function s3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: process.env.AWS_ENDPOINT_URL, forcePathStyle: true }),
  })
}

const app: Hono = new Hono().get(
  "/android/client-release",
  describeRoute({
    description: "Returns the latest verified signed release of the SproutOS Android client.",
    responses: {
      200: {
        description: "Latest client release",
        content: { "application/json": { schema: resolver(clientReleaseSchemaResponse) } },
      },
      404: {
        description: "No client release has been published",
        content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
      },
      500: {
        description: "Stored release metadata is invalid",
        content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
      },
    },
  }),
  async (c) => {
    const release = await fetchClientRelease(db).latest([
      "packageName",
      "versionName",
      "versionCode",
      "apkObjectKey",
      "apkObjectVersion",
      "apkSha256",
      "apkSizeBytes",
      "certificateSha256",
      "required",
    ])
    if (release === undefined) return throwNotFound(c, "No Android client release is available")

    const sizeBytes = Number(release.apkSizeBytes)
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      return throwInternalServerError(c, "The Android client release metadata is invalid")
    }

    const client = s3Client()
    let downloadUrl: string
    try {
      downloadUrl = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: artifactBucket(),
          Key: release.apkObjectKey,
          VersionId: release.apkObjectVersion,
          ResponseContentType: "application/vnd.android.package-archive",
          ResponseContentDisposition: 'attachment; filename="sproutos.apk"',
        }),
        { expiresIn: CATALOGUE_TTL_SECONDS },
      )
    } finally {
      client.destroy()
    }

    const response = toClientUpdate(
      {
        packageName: release.packageName,
        versionName: release.versionName,
        versionCode: release.versionCode,
        sha256: release.apkSha256,
        sizeBytes,
        certificateSha256: release.certificateSha256,
        objectKey: release.apkObjectKey,
        required: release.required,
      },
      () => downloadUrl,
    )
    if (response === undefined) {
      return throwInternalServerError(c, "The Android client release metadata is invalid")
    }

    c.header("Cache-Control", "private, no-store")
    return c.json(response)
  },
)

export default app

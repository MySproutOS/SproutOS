import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { crudClientRelease, fetchClientRelease } from "@lib/dao"
import { CATALOGUE_TTL_SECONDS, toClientUpdate } from "@lib/services"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { signerAuthorized } from "./apk-signing"
import { ErrorSchemaResponse } from "../utils/errors/error.serializer"
import {
  throwBadRequest,
  throwConflict,
  throwInternalServerError,
  throwNotFound,
  throwUnauthenticated,
} from "../utils/http-exception"
import { validator } from "../utils/validator"
import {
  clientReleasePublishSchemaResponse,
  clientReleaseSchemaRequest,
  clientReleaseSchemaResponse,
} from "./client-release.serializer"

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

const app: Hono = new Hono()
  .get(
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
            ResponseContentDisposition: 'attachment; filename="sproutos-client.apk"',
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
  .post(
    "/android/client-release",
    describeRoute({
      description: "Publishes metadata for a signed and verified SproutOS Android client release.",
      responses: {
        200: {
          description: "The identical release was already recorded",
          content: {
            "application/json": { schema: resolver(clientReleasePublishSchemaResponse) },
          },
        },
        201: {
          description: "Client release recorded",
          content: {
            "application/json": { schema: resolver(clientReleasePublishSchemaResponse) },
          },
        },
        400: {
          description: "The signed artifact does not match the release metadata",
          content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
        },
        401: {
          description: "Missing or invalid signer token",
          content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
        },
        409: {
          description: "The version code was already published with different metadata",
          content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
        },
      },
    }),
    validator("json", clientReleaseSchemaRequest),
    async (c) => {
      if (!signerAuthorized(c.req.header("Authorization"))) {
        return throwUnauthenticated(c, "The signer token is not valid")
      }
      const json = c.req.valid("json")
      const existing = await fetchClientRelease(db).getByVersion(json.version_code, [
        "id",
        "versionName",
        "apkObjectKey",
        "apkObjectVersion",
        "apkSha256",
        "apkSizeBytes",
        "certificateSha256",
        "required",
      ])
      if (existing !== undefined) {
        const identical =
          existing.versionName === json.version_name &&
          existing.apkObjectKey === json.apk_object_key &&
          existing.apkObjectVersion === json.apk_object_version &&
          existing.apkSha256 === json.apk_sha256 &&
          existing.apkSizeBytes === String(json.apk_size_bytes) &&
          existing.certificateSha256 === json.certificate_sha256 &&
          existing.required === (json.required ?? false)
        if (!identical) {
          return throwConflict(c, "This Android version code has different release metadata")
        }
        return c.json({ id: existing.id })
      }

      const client = s3Client()
      try {
        let object
        try {
          object = await client.send(
            new HeadObjectCommand({
              Bucket: artifactBucket(),
              Key: json.apk_object_key,
              VersionId: json.apk_object_version,
            }),
          )
        } catch (cause) {
          const status = (cause as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode
          if (status === 404) return throwBadRequest(c, "The signed APK does not exist")
          throw cause
        }
        if (
          object.ContentLength !== json.apk_size_bytes ||
          object.ContentType !== "application/vnd.android.package-archive"
        ) {
          return throwBadRequest(c, "The signed APK does not match the release metadata")
        }
      } finally {
        client.destroy()
      }

      const created = await crudClientRelease(db).create({
        packageName: json.package_name,
        versionName: json.version_name,
        versionCode: json.version_code,
        apkObjectKey: json.apk_object_key,
        apkObjectVersion: json.apk_object_version,
        apkSha256: json.apk_sha256,
        apkSizeBytes: json.apk_size_bytes,
        certificateSha256: json.certificate_sha256,
        required: json.required ?? false,
        verifiedAt: new Date(),
      })
      return c.json({ id: created.id }, 201)
    },
  )

export default app

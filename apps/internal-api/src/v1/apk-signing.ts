import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import {
  APK_MIME,
  claimSigningJob,
  completeKeyProvision,
  completeSigning,
  failSigning,
} from "@lib/jobs"
import { db } from "@sproutos/db"
import { constantTimeEqualUtf8 } from "@utils/crypto"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { validator } from "../utils/validator"

const digest = Type.String({ pattern: "^[0-9a-f]{64}$" })
const claimRequest = Type.Object({ signer_id: Type.String({ minLength: 1, maxLength: 200 }) })
const provisionClaimResponse = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  kind: Type.Literal("provision_key"),
  android_app_id: Type.String({ format: "uuid" }),
  package_name: Type.String(),
  encrypted_key_upload_url: Type.String(),
  encrypted_key_object_key: Type.String(),
})
const signClaimResponse = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  kind: Type.Literal("sign_release"),
  android_app_id: Type.String({ format: "uuid" }),
  package_name: Type.String(),
  project_id: Type.String({ format: "uuid" }),
  deployment_id: Type.String({ format: "uuid" }),
  download_url: Type.String(),
  unsigned_digest: digest,
  input_mime: Type.Literal(APK_MIME),
  version_code: Type.Integer({ minimum: 1 }),
  previous_version_code: Type.Integer({ minimum: 0 }),
  expected_certificate_sha256: digest,
  key_download_url: Type.String(),
  encrypted_key_object_key: Type.String(),
  encrypted_key_object_version: Type.String(),
  upload_url: Type.String(),
  signed_key: Type.String(),
})
const claimResponse = Type.Union([provisionClaimResponse, signClaimResponse])

const provisionComplete = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  kind: Type.Literal("provision_key"),
  encrypted_key_object_key: Type.String({ minLength: 1 }),
  encrypted_key_object_version: Type.String({ minLength: 1 }),
  certificate_sha256: digest,
  developer_console_state: Type.Union([
    Type.Literal("pending_registration"),
    Type.Literal("registered"),
  ]),
})
const signComplete = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  kind: Type.Literal("sign_release"),
  signed_key: Type.String({ minLength: 1 }),
  signed_object_version: Type.String({ minLength: 1 }),
  signed_digest: digest,
  size_bytes: Type.Integer({ minimum: 1 }),
  package_name: Type.String({ minLength: 1 }),
  version_code: Type.Integer({ minimum: 1 }),
  version_name: Type.String({ minLength: 1, maxLength: 255 }),
  certificate_sha256: digest,
})
const completeRequest = Type.Union([provisionComplete, signComplete])
const failRequest = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  error: Type.String({ minLength: 1, maxLength: 4000 }),
  developer_console_state: Type.Optional(
    Type.Union([Type.Literal("ownership_required"), Type.Literal("failed")]),
  ),
})

export function signerAuthorized(header: string | undefined): boolean {
  const expected = process.env.APK_SIGNER_TOKEN
  if (expected === undefined || expected === "" || header?.startsWith("Bearer ") !== true)
    return false
  return constantTimeEqualUtf8(header.slice(7), expected)
}

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

const URL_TTL_S = 3600

const app: Hono = new Hono()
  .post(
    "/apk-signing/claim",
    describeRoute({
      // The signer uses this machine endpoint directly. Hey API cannot transform the tagged
      // provision/sign union safely and warns that it will emit an incomplete response
      // transformer, so do not publish a generated dashboard-client operation that can misread a
      // valid claim. Runtime TypeBox validation and the signer contract tests remain authoritative.
      hide: true,
      description: "Claim the oldest Android key-provisioning or APK-signing job.",
      responses: {
        200: {
          description: "A signer job",
          content: { "application/json": { schema: resolver(claimResponse) } },
        },
        204: { description: "Nothing is ready" },
        401: { description: "Missing or invalid signer token" },
      },
    }),
    validator("json", claimRequest),
    async (c) => {
      if (!signerAuthorized(c.req.header("Authorization")))
        return c.json({ message: "Unauthorized" }, 401)
      const job = await claimSigningJob(db, c.req.valid("json").signer_id)
      if (job === undefined) return c.body(null, 204)
      const client = s3()
      if (job.kind === "provision_key") {
        const key = `keys/${job.androidAppId}/signing.keystore.enc`
        const upload = await getSignedUrl(
          client,
          new PutObjectCommand({ Bucket: bucket(), Key: key }),
          { expiresIn: URL_TTL_S },
        )
        client.destroy()
        return c.json({
          job_id: job.id,
          kind: job.kind,
          android_app_id: job.androidAppId,
          package_name: job.packageName,
          encrypted_key_upload_url: upload,
          encrypted_key_object_key: key,
        })
      }
      const signedKey = `signed/${job.androidAppId}/${job.id}.apk`
      const [downloadUrl, keyDownloadUrl, uploadUrl] = await Promise.all([
        getSignedUrl(client, new GetObjectCommand({ Bucket: bucket(), Key: job.unsignedKey }), {
          expiresIn: URL_TTL_S,
        }),
        getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket(),
            Key: job.keyObjectKey,
            VersionId: job.keyObjectVersion,
          }),
          { expiresIn: URL_TTL_S },
        ),
        getSignedUrl(
          client,
          new PutObjectCommand({ Bucket: bucket(), Key: signedKey, ContentType: APK_MIME }),
          { expiresIn: URL_TTL_S },
        ),
      ])
      client.destroy()
      return c.json({
        job_id: job.id,
        kind: job.kind,
        android_app_id: job.androidAppId,
        package_name: job.packageName,
        project_id: job.projectId,
        deployment_id: job.deploymentId,
        download_url: downloadUrl,
        unsigned_digest: job.unsignedDigest,
        input_mime: APK_MIME,
        version_code: job.versionCode,
        previous_version_code: job.previousVersionCode,
        expected_certificate_sha256: job.certificateSha256,
        key_download_url: keyDownloadUrl,
        encrypted_key_object_key: job.keyObjectKey,
        encrypted_key_object_version: job.keyObjectVersion,
        upload_url: uploadUrl,
        signed_key: signedKey,
      })
    },
  )
  .post(
    "/apk-signing/complete",
    describeRoute({
      description: "Complete a key-provisioning or signed-release job.",
      responses: {
        200: { description: "Recorded" },
        401: { description: "Missing or invalid signer token" },
        409: { description: "The claim or reported identity no longer matches" },
      },
    }),
    validator("json", completeRequest),
    async (c) => {
      if (!signerAuthorized(c.req.header("Authorization")))
        return c.json({ message: "Unauthorized" }, 401)
      const json = c.req.valid("json")
      const client = s3()
      const uploaded = await client.send(
        new HeadObjectCommand({
          Bucket: bucket(),
          Key: json.kind === "provision_key" ? json.encrypted_key_object_key : json.signed_key,
          ...(json.kind === "provision_key"
            ? { VersionId: json.encrypted_key_object_version }
            : { VersionId: json.signed_object_version }),
        }),
      )
      client.destroy()
      if (
        json.kind === "sign_release" &&
        (uploaded.ContentLength !== json.size_bytes || uploaded.ContentType !== APK_MIME)
      ) {
        return c.json(
          { message: "The uploaded signed APK metadata does not match completion" },
          409,
        )
      }
      const recorded =
        json.kind === "provision_key"
          ? await completeKeyProvision(db, {
              jobId: json.job_id,
              signerId: json.signer_id,
              keyObjectKey: json.encrypted_key_object_key,
              keyObjectVersion: json.encrypted_key_object_version,
              certificateSha256: json.certificate_sha256,
              developerConsoleState: json.developer_console_state,
            })
          : await completeSigning(db, {
              jobId: json.job_id,
              signerId: json.signer_id,
              signedKey: json.signed_key,
              signedObjectVersion: json.signed_object_version,
              signedDigest: json.signed_digest,
              signedSizeBytes: BigInt(json.size_bytes),
              packageName: json.package_name,
              versionCode: json.version_code,
              versionName: json.version_name,
              certificateSha256: json.certificate_sha256,
            })
      if (!recorded)
        return c.json({ message: "The claim or reported app identity no longer matches" }, 409)
      return c.json({})
    },
  )
  .post(
    "/apk-signing/fail",
    describeRoute({
      description: "Report a signer failure; terminal failure marks its Android deployment failed.",
      responses: {
        200: { description: "Recorded" },
        401: { description: "Missing or invalid signer token" },
        409: { description: "The signer no longer holds the claim" },
      },
    }),
    validator("json", failRequest),
    async (c) => {
      if (!signerAuthorized(c.req.header("Authorization")))
        return c.json({ message: "Unauthorized" }, 401)
      const json = c.req.valid("json")
      const recorded = await failSigning(db, {
        jobId: json.job_id,
        signerId: json.signer_id,
        error: json.error,
        developerConsoleState: json.developer_console_state,
      })
      if (!recorded) return c.json({ message: "The signer no longer holds the claim" }, 409)
      return c.json({})
    },
  )

export default app

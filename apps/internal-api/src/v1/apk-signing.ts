import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import {
  APK_MIME,
  CLIENT_KEY_OBJECT_KEY,
  CLIENT_PACKAGE_NAME,
  ClientSigningConflictError,
  claimClientSigningJob,
  claimSigningJob,
  completeClientKeyProvision,
  completeClientSigning,
  completeKeyProvision,
  completeSigning,
  ensureClientSigningIdentity,
  failClientSigning,
  failSigning,
  finalizeClientReleaseUpload,
  prepareClientRelease,
} from "@lib/jobs"
import { db } from "@sproutos/db"
import { constantTimeEqualUtf8 } from "@utils/crypto"
import { createHash } from "node:crypto"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { validator } from "../utils/validator"

const digest = Type.String({ pattern: "^[0-9a-f]{64}$" })
const developerAccount = Type.String({ pattern: "^developerAccounts/[0-9]+$" })
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
const provisionClientClaimResponse = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  kind: Type.Literal("provision_client_key"),
  package_name: Type.Literal(CLIENT_PACKAGE_NAME),
  encrypted_key_upload_url: Type.String(),
  encrypted_key_object_key: Type.Literal(CLIENT_KEY_OBJECT_KEY),
})
const signClientClaimResponse = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  kind: Type.Literal("sign_client_release"),
  package_name: Type.Literal(CLIENT_PACKAGE_NAME),
  download_url: Type.String(),
  unsigned_digest: digest,
  input_mime: Type.Literal(APK_MIME),
  version_code: Type.Integer({ minimum: 1, maximum: 2_100_000_000 }),
  previous_version_code: Type.Integer({ minimum: 0, maximum: 2_100_000_000 }),
  expected_certificate_sha256: digest,
  key_download_url: Type.String(),
  encrypted_key_object_key: Type.Literal(CLIENT_KEY_OBJECT_KEY),
  encrypted_key_object_version: Type.String(),
  upload_url: Type.String(),
  signed_key: Type.String(),
})
const claimResponse = Type.Union([
  provisionClaimResponse,
  signClaimResponse,
  provisionClientClaimResponse,
  signClientClaimResponse,
])

const provisionComplete = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  kind: Type.Literal("provision_key"),
  encrypted_key_object_key: Type.String({ minLength: 1 }),
  encrypted_key_object_version: Type.String({ minLength: 1 }),
  certificate_sha256: digest,
  developer_console_state: Type.Literal("pending_registration"),
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
  developer_console_account: developerAccount,
})
const provisionClientComplete = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  kind: Type.Literal("provision_client_key"),
  encrypted_key_object_key: Type.Literal(CLIENT_KEY_OBJECT_KEY),
  encrypted_key_object_version: Type.String({ minLength: 1 }),
  certificate_sha256: digest,
})
const signClientComplete = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  kind: Type.Literal("sign_client_release"),
  signed_key: Type.String({ minLength: 1 }),
  signed_object_version: Type.String({ minLength: 1 }),
  signed_digest: digest,
  size_bytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  package_name: Type.Literal(CLIENT_PACKAGE_NAME),
  version_code: Type.Integer({ minimum: 1, maximum: 2_100_000_000 }),
  version_name: Type.String({ minLength: 1, maxLength: 100 }),
  certificate_sha256: digest,
  developer_console_account: developerAccount,
})
const completeRequest = Type.Union([
  provisionComplete,
  signComplete,
  provisionClientComplete,
  signClientComplete,
])
const failRequest = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  error: Type.String({ minLength: 1, maxLength: 4000 }),
  developer_console_state: Type.Optional(
    Type.Union([Type.Literal("ownership_required"), Type.Literal("failed")]),
  ),
})

const clientIdentityRequest = Type.Object({
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
})
const prepareClientReleaseRequest = Type.Object({
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  package_name: Type.Literal(CLIENT_PACKAGE_NAME),
  unsigned_digest: digest,
  size_bytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  version_code: Type.Integer({ minimum: 1, maximum: 2_100_000_000 }),
})
const finalizeClientReleaseRequest = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  unsigned_key: Type.String({ minLength: 1 }),
  unsigned_object_version: Type.String({ minLength: 1 }),
  unsigned_digest: digest,
  size_bytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
})

export function signerAuthorized(header: string | undefined): boolean {
  const expected = process.env.APK_SIGNER_TOKEN
  if (
    expected === undefined ||
    expected === "" ||
    expected === process.env.APK_SIGNER_OPERATOR_TOKEN ||
    header?.startsWith("Bearer ") !== true
  )
    return false
  return constantTimeEqualUtf8(header.slice(7), expected)
}

export function signerOperatorAuthorized(header: string | undefined): boolean {
  const expected = process.env.APK_SIGNER_OPERATOR_TOKEN
  if (
    expected === undefined ||
    expected === "" ||
    expected === process.env.APK_SIGNER_TOKEN ||
    header?.startsWith("Bearer ") !== true
  )
    return false
  return constantTimeEqualUtf8(header.slice(7), expected)
}

export function assertSignerCredentialConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const runtime = env.APK_SIGNER_TOKEN
  const operator = env.APK_SIGNER_OPERATOR_TOKEN
  if (runtime === undefined || runtime === "" || operator === undefined || operator === "") {
    throw new Error("APK signer runtime and operator credentials are required")
  }
  if (constantTimeEqualUtf8(runtime, operator)) {
    throw new Error("APK signer runtime and operator credentials must be distinct")
  }
}

const CLIENT_RELEASE_OPERATOR_PRINCIPAL = "authenticated-client-release-operator"

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
const MAX_ENCRYPTED_KEY_BYTES = 32 * 1024 * 1024
const IDEMPOTENCY_KEY = /^[0-9a-f]{64}$/

export function callbackIdempotencyKey(
  header: string | undefined,
  payload: unknown,
): string | undefined {
  if (header === undefined || !IDEMPOTENCY_KEY.test(header)) return undefined
  const expected = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  return constantTimeEqualUtf8(header, expected) ? header : undefined
}

const app: Hono = new Hono()
  .post(
    "/apk-signing/claim",
    describeRoute({
      // The signer consumes this machine endpoint directly. Hey API cannot safely transform the
      // tagged provision/sign union, so the dashboard client must not generate an incomplete
      // operation for it. Runtime validation and signer contract tests remain authoritative.
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
      const signerId = c.req.valid("json").signer_id
      const job =
        (await claimClientSigningJob(db, signerId)) ?? (await claimSigningJob(db, signerId))
      if (job === undefined) return c.body(null, 204)
      const client = s3()
      if (job.kind === "provision_key" || job.kind === "provision_client_key") {
        const key =
          job.kind === "provision_key"
            ? `keys/${job.androidAppId}/signing.keystore.enc`
            : CLIENT_KEY_OBJECT_KEY
        let upload: string
        try {
          upload = await getSignedUrl(
            client,
            new PutObjectCommand({
              Bucket: bucket(),
              Key: key,
              ContentType: "application/octet-stream",
            }),
            { expiresIn: URL_TTL_S },
          )
        } finally {
          client.destroy()
        }
        if (job.kind === "provision_client_key") {
          return c.json({
            job_id: job.id,
            kind: job.kind,
            package_name: job.packageName,
            encrypted_key_upload_url: upload,
            encrypted_key_object_key: key,
          })
        }
        return c.json({
          job_id: job.id,
          kind: job.kind,
          android_app_id: job.androidAppId,
          package_name: job.packageName,
          encrypted_key_upload_url: upload,
          encrypted_key_object_key: key,
        })
      }
      const clientRelease = job.kind === "sign_client_release"
      const signedKey = clientRelease
        ? `signed/client/${job.id}.apk`
        : `signed/${job.androidAppId}/${job.id}.apk`
      let downloadUrl: string, keyDownloadUrl: string, uploadUrl: string
      try {
        ;[downloadUrl, keyDownloadUrl, uploadUrl] = await Promise.all([
          getSignedUrl(
            client,
            new GetObjectCommand({
              Bucket: bucket(),
              Key: job.unsignedKey,
              ...(clientRelease ? { VersionId: job.unsignedObjectVersion } : {}),
            }),
            { expiresIn: URL_TTL_S },
          ),
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
      } finally {
        client.destroy()
      }
      if (clientRelease) {
        return c.json({
          job_id: job.id,
          kind: job.kind,
          package_name: job.packageName,
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
      }
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
    "/apk-signing/client-identity",
    describeRoute({
      hide: true,
      description: "Ensure and report the immutable catalogue-client signing identity.",
      responses: {
        200: { description: "Identity state" },
        401: { description: "Missing or invalid signer token" },
      },
    }),
    validator("json", clientIdentityRequest),
    async (c) => {
      if (!signerOperatorAuthorized(c.req.header("Authorization")))
        return c.json({ message: "Unauthorized" }, 401)
      const identity = await ensureClientSigningIdentity(db, CLIENT_RELEASE_OPERATOR_PRINCIPAL)
      return c.json({
        package_name: identity.packageName,
        state: identity.state,
        developer_console_state: identity.developerConsoleState,
        ...(identity.developerConsoleProviderState === null
          ? {}
          : { developer_console_provider_state: identity.developerConsoleProviderState }),
        ...(identity.developerConsoleError === null
          ? {}
          : { developer_console_error: identity.developerConsoleError }),
        ...(identity.developerConsoleAccount === null
          ? {}
          : { developer_console_account: identity.developerConsoleAccount }),
        ...(identity.certificateSha256 === null
          ? {}
          : { certificate_sha256: identity.certificateSha256 }),
      })
    },
  )
  .post(
    "/apk-signing/client-release/prepare",
    describeRoute({
      hide: true,
      description: "Prepare an immutable raw catalogue-client APK upload.",
      responses: {
        200: { description: "Upload target" },
        401: { description: "Missing or invalid signer token" },
        409: { description: "Identity or version conflict" },
      },
    }),
    validator("json", prepareClientReleaseRequest),
    async (c) => {
      const json = c.req.valid("json")
      if (!signerOperatorAuthorized(c.req.header("Authorization")))
        return c.json({ message: "Unauthorized" }, 401)
      let prepared: Awaited<ReturnType<typeof prepareClientRelease>>
      try {
        prepared = await prepareClientRelease(db, {
          operatorSignerId: CLIENT_RELEASE_OPERATOR_PRINCIPAL,
          packageName: json.package_name,
          unsignedDigest: json.unsigned_digest,
          sizeBytes: BigInt(json.size_bytes),
          versionCode: json.version_code,
        })
      } catch (error) {
        if (error instanceof ClientSigningConflictError)
          return c.json({ message: error.message }, 409)
        throw error
      }
      let uploadUrl: string | undefined
      if (prepared.state === "awaiting_upload") {
        const client = s3()
        try {
          uploadUrl = await getSignedUrl(
            client,
            new PutObjectCommand({
              Bucket: bucket(),
              Key: prepared.unsignedKey,
              ContentType: APK_MIME,
              ContentLength: json.size_bytes,
            }),
            { expiresIn: URL_TTL_S },
          )
        } finally {
          client.destroy()
        }
      }
      return c.json({
        job_id: prepared.jobId,
        unsigned_key: prepared.unsignedKey,
        state: prepared.state,
        ...(uploadUrl === undefined ? {} : { upload_url: uploadUrl }),
      })
    },
  )
  .post(
    "/apk-signing/client-release/finalize-upload",
    describeRoute({
      hide: true,
      description: "Pin the exact raw APK object version and queue it for signing.",
      responses: {
        200: { description: "Queued" },
        400: { description: "Missing or malformed idempotency key" },
        401: { description: "Missing or invalid signer token" },
        409: { description: "Upload metadata or prepared job mismatch" },
      },
    }),
    validator("json", finalizeClientReleaseRequest),
    async (c) => {
      const json = c.req.valid("json")
      if (!signerOperatorAuthorized(c.req.header("Authorization")))
        return c.json({ message: "Unauthorized" }, 401)
      const idempotencyKey = callbackIdempotencyKey(c.req.header("Idempotency-Key"), json)
      if (idempotencyKey === undefined)
        return c.json({ message: "A payload-bound SHA-256 Idempotency-Key is required" }, 400)
      const client = s3()
      try {
        const uploaded = await client.send(
          new HeadObjectCommand({
            Bucket: bucket(),
            Key: json.unsigned_key,
            VersionId: json.unsigned_object_version,
          }),
        )
        if (uploaded.ContentLength !== json.size_bytes || uploaded.ContentType !== APK_MIME)
          return c.json({ message: "The raw APK metadata does not match preparation" }, 409)
      } finally {
        client.destroy()
      }
      const finalized = await finalizeClientReleaseUpload(db, {
        jobId: json.job_id,
        operatorSignerId: CLIENT_RELEASE_OPERATOR_PRINCIPAL,
        unsignedKey: json.unsigned_key,
        unsignedObjectVersion: json.unsigned_object_version,
        unsignedDigest: json.unsigned_digest,
        sizeBytes: BigInt(json.size_bytes),
        idempotencyKey,
      })
      if (!finalized) return c.json({ message: "The prepared upload no longer matches" }, 409)
      return c.json({})
    },
  )
  .post(
    "/apk-signing/complete",
    describeRoute({
      description: "Complete a key-provisioning or signed-release job.",
      responses: {
        200: { description: "Recorded" },
        400: { description: "Missing or malformed idempotency key" },
        401: { description: "Missing or invalid signer token" },
        409: { description: "The claim or reported identity no longer matches" },
      },
    }),
    validator("json", completeRequest),
    async (c) => {
      if (!signerAuthorized(c.req.header("Authorization")))
        return c.json({ message: "Unauthorized" }, 401)
      const json = c.req.valid("json")
      const idempotencyKey = callbackIdempotencyKey(c.req.header("Idempotency-Key"), json)
      if (idempotencyKey === undefined)
        return c.json({ message: "A payload-bound SHA-256 Idempotency-Key is required" }, 400)
      const provision = json.kind === "provision_key" || json.kind === "provision_client_key"
      const client = s3()
      let uploaded
      try {
        uploaded = await client.send(
          new HeadObjectCommand({
            Bucket: bucket(),
            Key: provision ? json.encrypted_key_object_key : json.signed_key,
            VersionId: provision ? json.encrypted_key_object_version : json.signed_object_version,
          }),
        )
      } finally {
        client.destroy()
      }
      if (
        (provision &&
          (uploaded.ContentType !== "application/octet-stream" ||
            uploaded.ContentLength === undefined ||
            uploaded.ContentLength < 1 ||
            uploaded.ContentLength > MAX_ENCRYPTED_KEY_BYTES)) ||
        (!provision &&
          (uploaded.ContentLength !== json.size_bytes || uploaded.ContentType !== APK_MIME))
      ) {
        return c.json(
          { message: "The uploaded signing artifact metadata does not match completion" },
          409,
        )
      }
      let recorded: boolean
      if (json.kind === "provision_key") {
        recorded = await completeKeyProvision(db, {
          jobId: json.job_id,
          signerId: json.signer_id,
          keyObjectKey: json.encrypted_key_object_key,
          keyObjectVersion: json.encrypted_key_object_version,
          certificateSha256: json.certificate_sha256,
          developerConsoleState: json.developer_console_state,
          idempotencyKey,
        })
      } else if (json.kind === "sign_release") {
        recorded = await completeSigning(db, {
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
          developerConsoleAccount: json.developer_console_account,
          idempotencyKey,
        })
      } else if (json.kind === "provision_client_key") {
        recorded = await completeClientKeyProvision(db, {
          jobId: json.job_id,
          signerId: json.signer_id,
          keyObjectKey: json.encrypted_key_object_key,
          keyObjectVersion: json.encrypted_key_object_version,
          certificateSha256: json.certificate_sha256,
          idempotencyKey,
        })
      } else {
        recorded = await completeClientSigning(db, {
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
          developerConsoleAccount: json.developer_console_account,
          idempotencyKey,
        })
      }
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
        400: { description: "Missing or malformed idempotency key" },
        401: { description: "Missing or invalid signer token" },
        409: { description: "The signer no longer holds the claim" },
      },
    }),
    validator("json", failRequest),
    async (c) => {
      if (!signerAuthorized(c.req.header("Authorization")))
        return c.json({ message: "Unauthorized" }, 401)
      const json = c.req.valid("json")
      const idempotencyKey = callbackIdempotencyKey(c.req.header("Idempotency-Key"), json)
      if (idempotencyKey === undefined)
        return c.json({ message: "A payload-bound SHA-256 Idempotency-Key is required" }, 400)
      const recordedCustomer = await failSigning(db, {
        jobId: json.job_id,
        signerId: json.signer_id,
        error: json.error,
        developerConsoleState: json.developer_console_state,
        idempotencyKey,
      })
      const recorded =
        recordedCustomer ||
        (await failClientSigning(db, {
          jobId: json.job_id,
          signerId: json.signer_id,
          error: json.error,
          idempotencyKey,
        }))
      if (!recorded) return c.json({ message: "The signer no longer holds the claim" }, 409)
      return c.json({})
    },
  )

export default app

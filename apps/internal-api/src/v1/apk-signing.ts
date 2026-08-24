import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { claimSigningJob, completeSigning, failSigning } from "@lib/jobs"
import { db } from "@sproutos/db"
import { constantTimeEqualUtf8 } from "@utils/crypto"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { validator } from "../utils/validator"

/**
 * The three calls an on-premises APK signer makes.
 *
 * **The platform does not hold the Android signing key.** A machine on somebody's premises does. It
 * polls `/claim`, downloads the unsigned APK, signs it, uploads the result, and calls `/complete` —
 * or `/fail`. The key never reaches AWS, a CI runner, or this repository.
 *
 * ## Why these are not on the `/internal` prefix
 *
 * `pg-resolve` and the metering ingest sit behind `/internal` because their callers are inside the
 * VPC. This caller is not: it is behind a firewall on somebody's premises, it reaches out over the
 * public internet, and nothing can reach in. So these routes are exposed and carry their own
 * credential rather than relying on the network.
 *
 * ## What `signer_id` is and is not
 *
 * It is a label on a claim, used to decide who may complete it — not an authorization principal.
 * One token covers the whole signing fleet, so any holder could assert any id. That is fine because
 * the token *is* the trust boundary: a machine holding it is already permitted to sign. What the id
 * buys is that a signer whose claim expired mid-upload cannot overwrite the artifact its successor
 * produced, which is a correctness property among cooperating signers, not a defence against one.
 */

const claimRequest = Type.Object({
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
})

const claimResponse = Type.Object({
  job_id: Type.String(),
  project_id: Type.String(),
  deployment_id: Type.String(),
  /** Where to GET the unsigned APK, and the digest it must have. */
  download_url: Type.String(),
  unsigned_digest: Type.String(),
  /** Where to PUT the signed one. The key is recorded on `/complete`. */
  upload_url: Type.String(),
  signed_key: Type.String(),
})

const completeRequest = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  signed_key: Type.String({ minLength: 1 }),
  signed_digest: Type.String({ minLength: 64, maxLength: 64 }),
})

const failRequest = Type.Object({
  job_id: Type.String({ format: "uuid" }),
  signer_id: Type.String({ minLength: 1, maxLength: 200 }),
  error: Type.String({ maxLength: 4000 }),
})

/**
 * The signer's credential, compared in constant time.
 *
 * Returns `false` when the variable is unset rather than letting an empty token match an empty
 * header — an unconfigured deployment must refuse every signer, not accept every caller.
 */
export function signerAuthorized(header: string | undefined): boolean {
  const expected = process.env.APK_SIGNER_TOKEN
  if (expected === undefined || expected === "") return false
  if (header === undefined) return false

  const prefix = "Bearer "
  if (!header.startsWith(prefix)) return false

  return constantTimeEqualUtf8(header.slice(prefix.length), expected)
}

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

/*
  Long enough that a slow domestic uplink can move an APK, short enough that a URL captured from a
  log is useless before anyone reads it. The signer is on a home or office connection rather than in
  a datacentre, so this is more generous than the deploy action's.
*/
const URL_TTL_S = 3600

const app: Hono = new Hono()
  .post(
    "/apk-signing/claim",
    describeRoute({
      description: "Claim the oldest APK awaiting signature. Polled by the on-premises signer.",
      responses: {
        200: {
          description: "A job, with URLs to download the unsigned APK and upload the signed one",
          content: { "application/json": { schema: resolver(claimResponse) } },
        },
        204: { description: "Nothing to sign" },
        401: { description: "Missing or invalid signer token" },
      },
    }),
    validator("json", claimRequest),
    async (c) => {
      if (!signerAuthorized(c.req.header("Authorization"))) {
        return c.json({ message: "Unauthorized" }, 401)
      }

      const { signer_id } = c.req.valid("json")
      const job = await claimSigningJob(db, signer_id)
      // An idle queue is the common case — the signer polls on a timer and most polls find nothing.
      // 204 rather than an empty 200 so that is cheap and unambiguous.
      if (job === undefined) return c.body(null, 204)

      const client = s3()
      const signedKey = `signed/${job.projectId}/${job.deploymentId}.apk`

      const [downloadUrl, uploadUrl] = await Promise.all([
        getSignedUrl(client, new GetObjectCommand({ Bucket: bucket(), Key: job.unsignedKey }), {
          expiresIn: URL_TTL_S,
        }),
        getSignedUrl(
          client,
          new PutObjectCommand({
            Bucket: bucket(),
            Key: signedKey,
            ContentType: "application/vnd.android.package-archive",
          }),
          { expiresIn: URL_TTL_S },
        ),
      ])

      return c.json({
        job_id: job.id,
        project_id: job.projectId,
        deployment_id: job.deploymentId,
        download_url: downloadUrl,
        unsigned_digest: job.unsignedDigest,
        upload_url: uploadUrl,
        signed_key: signedKey,
      })
    },
  )
  .post(
    "/apk-signing/complete",
    describeRoute({
      description: "Record a signed APK against the job that produced it.",
      responses: {
        200: { description: "Recorded" },
        401: { description: "Missing or invalid signer token" },
        409: { description: "The claim is no longer held by this signer" },
      },
    }),
    validator("json", completeRequest),
    async (c) => {
      if (!signerAuthorized(c.req.header("Authorization"))) {
        return c.json({ message: "Unauthorized" }, 401)
      }

      const json = c.req.valid("json")
      const recorded = await completeSigning(db, {
        jobId: json.job_id,
        signerId: json.signer_id,
        signedKey: json.signed_key,
        signedDigest: json.signed_digest,
      })

      // 409 rather than 404: the job exists, the signer simply lost the claim while it was working.
      // The distinction matters to the signer, which should discard its artifact and poll again
      // rather than retry a completion that will never be accepted.
      if (!recorded) return c.json({ message: "The claim is no longer held by this signer" }, 409)

      return c.json({ ok: true })
    },
  )
  .post(
    "/apk-signing/fail",
    describeRoute({
      description:
        "Report a signing failure. The job returns to the queue until it has run out of attempts.",
      responses: {
        200: { description: "Recorded" },
        401: { description: "Missing or invalid signer token" },
      },
    }),
    validator("json", failRequest),
    async (c) => {
      if (!signerAuthorized(c.req.header("Authorization"))) {
        return c.json({ message: "Unauthorized" }, 401)
      }

      const json = c.req.valid("json")
      await failSigning(db, {
        jobId: json.job_id,
        signerId: json.signer_id,
        error: json.error,
      })

      return c.json({ ok: true })
    },
  )

export default app

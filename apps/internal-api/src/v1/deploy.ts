import { createHmac, timingSafeEqual } from "node:crypto"
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { crudDeployment, fetchDeployment } from "@lib/dao"
import { enqueue, enqueueSigning, PUBLISH_KINDS } from "@lib/jobs"
import { verifyGitHubOidcToken } from "@lib/oauth"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { validator } from "../utils/validator"

/**
 * What `MySproutOS/sproutos-deploy-action` calls.
 *
 * Three steps, and the split is deliberate. The token exchange proves *which repository* is asking.
 * The upload URL sends the artifact straight to object storage, so a 200 MB build never passes
 * through this API. The release call is small and carries the digest, which is what lets the
 * platform refuse an upload that did not arrive intact.
 *
 * ## Authentication is the repository, not a user
 *
 * There is no session here. A GitHub Actions OIDC token proves the caller is a workflow running in
 * a specific repository, and `@lib/oauth`'s verifier checks the signature against GitHub's
 * published keys — see its tests, which are a list of forgeries. A project is then found by that
 * repository, so a workflow can only deploy the project its own repository is connected to.
 */

/**
 * How long a deploy token lives.
 *
 * Long enough to upload a large artifact on a slow runner; short enough that a token captured from
 * a log is worthless by the time anyone reads it. Stateless — an HMAC over the claims — because a
 * revocation table for a credential that expires in fifteen minutes is machinery guarding nothing.
 */
const TOKEN_TTL_SECONDS = 15 * 60

function tokenSecret(): string {
  const secret = process.env.DEPLOY_TOKEN_SECRET
  if (secret === undefined || secret === "") {
    throw new Error(
      "DEPLOY_TOKEN_SECRET is not set. It signs deploy tokens, so a default would let anyone who " +
        "has read this repository mint one.",
    )
  }
  return secret
}

/** `<projectId>.<expiry>.<hmac>` — small enough for a header, and carries its own expiry. */
export function mintDeployToken(projectId: string, expiresAt: number, secret: string): string {
  const body = `${projectId}.${expiresAt}`
  const mac = createHmac("sha256", secret).update(body).digest("base64url")
  return `${body}.${mac}`
}

export function readDeployToken(
  token: string,
  secret: string,
  now: () => number = Date.now,
): { projectId: string } | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined

  const [projectId, expiry, mac] = parts as [string, string, string]
  const expected = createHmac("sha256", secret).update(`${projectId}.${expiry}`).digest("base64url")

  // Constant-time: the comparison is against a value the caller chooses and can vary a byte at a
  // time, which is exactly the shape a timing attack needs.
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined

  if (Number(expiry) <= Math.floor(now() / 1000)) return undefined
  return { projectId }
}

const tokenRequest = Type.Object({ oidc_token: Type.String({ minLength: 1 }) })
const tokenResponse = Type.Object({ token: Type.String(), expires_in: Type.Integer() })

const uploadRequest = Type.Object({
  project: Type.String({ minLength: 1 }),
  digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  preset: Type.String({ minLength: 1 }),
})
const uploadResponse = Type.Object({ url: Type.String(), key: Type.String() })

/*
  The static archive's request carries no project.

  The build one takes a `project` for the caller's benefit — it is echoed in errors — but the key is
  built from the *token's* project id either way. This one omits it entirely so there is nothing to
  mistake for an input: assets go under the project the token was minted for, and a caller cannot
  ask for someone else's prefix in a bucket every tenant shares.
*/
const staticUploadRequest = Type.Object({
  digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
})

const releaseRequest = Type.Object({
  project: Type.String({ minLength: 1 }),
  key: Type.String({ minLength: 1 }),
  digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  // Absent when the build produced no assets — an API has none — so both are optional and are
  // either present together or not at all.
  static_key: Type.Optional(Type.String({ minLength: 1 })),
  static_digest: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  preset: Type.String({ minLength: 1 }),
  environment: Type.String({ minLength: 1 }),
  commit: Type.String({ minLength: 1 }),
  ref: Type.String(),
})
const releaseResponse = Type.Object({
  deployment_id: Type.String(),
  url: Type.Optional(Type.String()),
})

/** The bearer token on the two calls that follow the exchange. */
function bearer(header: string | undefined): { projectId: string } | undefined {
  const token = header?.startsWith("Bearer ") === true ? header.slice(7) : undefined
  if (token === undefined) return undefined
  return readDeployToken(token, tokenSecret())
}

const deploy: Hono = new Hono()
  .post(
    "/deploy/token",
    describeRoute({
      description:
        "Exchange a GitHub Actions OIDC token for a short-lived SproutOS deploy token. Called by the deploy action.",
      responses: {
        200: {
          description: "A deploy token",
          content: { "application/json": { schema: resolver(tokenResponse) } },
        },
        401: { description: "The OIDC token did not verify" },
        404: { description: "No SproutOS project is connected to that repository" },
      },
    }),
    validator("json", tokenRequest),
    async (c) => {
      const { oidc_token } = c.req.valid("json")

      let claims: Awaited<ReturnType<typeof verifyGitHubOidcToken>>
      try {
        claims = await verifyGitHubOidcToken(oidc_token)
      } catch (cause) {
        // The reason goes to the log and not to the caller: which check failed is free information
        // to somebody probing, and a workflow author can only fix it from the docs anyway.
        console.error(`deploy token exchange refused: ${String(cause)}`)
        return c.json({ message: "The OIDC token did not verify" }, 401)
      }

      /*
        The repository decides the project, and nothing the caller sends does.

        `repository` is a verified claim; the `project` field on later calls is not, which is why
        it is checked against this rather than trusted. A workflow can only ever deploy the project
        its own repository is connected to.
      */
      // `repository` stores the owner and the name separately, so the claim is split rather than
      // concatenated into a column that does not exist.
      const [owner, name] = claims.repository.split("/") as [string, string]

      const project = await db
        .selectFrom("project")
        .innerJoin("repository", "repository.id", "project.repositoryId")
        .select(["project.id as id"])
        .where("repository.ownerLogin", "=", owner)
        .where("repository.name", "=", name)
        .where("project.deletedAt", "is", null)
        .executeTakeFirst()

      if (project === undefined) {
        return c.json({ message: `No SproutOS project is connected to ${claims.repository}` }, 404)
      }

      const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
      return c.json({
        token: mintDeployToken(project.id, expiresAt, tokenSecret()),
        expires_in: TOKEN_TTL_SECONDS,
      })
    },
  )
  .post(
    "/deploy/upload-url",
    describeRoute({
      description: "A pre-signed URL to upload a build artifact to. Called by the deploy action.",
      responses: {
        200: {
          description: "Where to PUT the archive",
          content: { "application/json": { schema: resolver(uploadResponse) } },
        },
        401: { description: "Missing or expired deploy token" },
      },
    }),
    validator("json", uploadRequest),
    async (c) => {
      const authorized = bearer(c.req.header("Authorization"))
      if (authorized === undefined) return c.json({ message: "Unauthorized" }, 401)

      const { digest } = c.req.valid("json")

      /*
        The key is the project and the digest, so the same build uploaded twice lands in the same
        place. That makes a redeploy of an unchanged artifact idempotent rather than accumulating
        copies — the action already produces a reproducible archive for exactly this reason.
      */
      const key = `builds/${authorized.projectId}/${digest}.zip`
      const bucket = process.env.SERVICE_BUILD_BUCKET ?? "sproutos-dev-artifacts"

      const client = new S3Client({
        region: process.env.AWS_REGION ?? "us-east-1",
        ...(process.env.AWS_ENDPOINT_URL === undefined
          ? {}
          : { endpoint: process.env.AWS_ENDPOINT_URL, forcePathStyle: true }),
      })

      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "application/zip" }),
        // Long enough for a large upload on a slow runner, short enough that a URL in a log is
        // useless before anyone reads it.
        { expiresIn: 900 },
      )

      return c.json({ url, key })
    },
  )
  .post(
    "/deploy/static-upload-url",
    describeRoute({
      description:
        "A pre-signed URL for a deployment's static assets, which are served from the CDN rather than the function.",
      responses: {
        200: {
          description: "Where to PUT the asset archive",
          content: { "application/json": { schema: resolver(uploadResponse) } },
        },
        401: { description: "Missing or expired deploy token" },
      },
    }),
    validator("json", staticUploadRequest),
    async (c) => {
      const authorized = bearer(c.req.header("Authorization"))
      if (authorized === undefined) return c.json({ message: "Unauthorized" }, 401)

      const { digest } = c.req.valid("json")

      /*
        Keyed by project and digest, like the build archive, so re-uploading an unchanged asset set
        is idempotent — which it will be constantly, since most deploys change the server and not
        the fonts.

        The project id comes from the token and never from the body. This is the shared tenant
        bucket, so the prefix *is* the tenancy boundary: a key assembled from anything the caller
        sent would let one project write into another's assets.
      */
      const key = `static/${authorized.projectId}/${digest}.zip`
      const bucket = process.env.TENANT_STATIC_BUCKET ?? "sproutos-dev-artifacts"

      const client = new S3Client({
        region: process.env.AWS_REGION ?? "us-east-1",
        ...(process.env.AWS_ENDPOINT_URL === undefined
          ? {}
          : { endpoint: process.env.AWS_ENDPOINT_URL, forcePathStyle: true }),
      })

      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "application/zip" }),
        { expiresIn: 900 },
      )

      return c.json({ url, key })
    },
  )
  .post(
    "/deploy/release",
    describeRoute({
      description: "Record an uploaded build as a deployment. Called by the deploy action.",
      responses: {
        200: {
          description: "The deployment",
          content: { "application/json": { schema: resolver(releaseResponse) } },
        },
        401: { description: "Missing or expired deploy token" },
      },
    }),
    validator("json", releaseRequest),
    async (c) => {
      const authorized = bearer(c.req.header("Authorization"))
      if (authorized === undefined) return c.json({ message: "Unauthorized" }, 401)

      const json = c.req.valid("json")

      const deployment = await crudDeployment(db).create({
        projectId: authorized.projectId,
        // `preview` for anything that is not production, so a branch build cannot take a
        // production hostname by naming itself one.
        kind: json.environment === "production" ? "production" : "preview",
        gitSha: json.commit,
        gitRef: json.ref,
        status: "queued",
        // Where the build is. Recorded on the row rather than recomputed later: the key is what the
        // action actually uploaded, and deriving it from the digest again would be a second place
        // for the two to disagree.
        artifactKey: json.key,
      })

      /*
        An Android release cannot ship from here — it has to be signed first, and the key is on a
        machine SproutOS does not operate. So the release queues a signing job and the deployment
        waits.

        The key recorded is the uploaded archive, not a bare APK: the action packages a directory,
        which for the `android` preset contains the unsigned APK. The signer unzips it. Uploading
        the APK on its own would be tidier and is worth doing when the action next changes; doing it
        now would mean a version skew where a customer on the old action silently queues a job no
        signer can read.
      */
      if (json.preset === "android") {
        await enqueueSigning(db, {
          deploymentId: deployment.id,
          projectId: authorized.projectId,
          unsignedKey: json.key,
          unsignedDigest: json.digest,
        })
      } else {
        /*
          Everything else goes live now.

          Enqueued rather than published inline: the publish talks to Lambda and to Valkey, and a
          request handler that waits on both turns a customer's `deploy` step into a call that hangs
          when either is slow. Keyed on the deployment so a retried release joins the publish
          already in flight.
        */
        // The job queue is partitioned by organization, and the deploy token carries only the
        // project — it is minted from a repository claim, which says nothing about who pays.
        const owner = await fetchDeployment(db).withProject(deployment.id)
        if (owner === undefined) return c.json({ message: "That project is gone" }, 404)

        await enqueue(db, {
          kind: PUBLISH_KINDS.release,
          organizationId: owner.project.organizationId,
          payload: { deploymentId: deployment.id },
          idempotencyKey: `${PUBLISH_KINDS.release}:${deployment.id}`,
        })
      }

      return c.json({ deployment_id: deployment.id })
    },
  )

export default deploy

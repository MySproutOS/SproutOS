import { createHmac, timingSafeEqual } from "node:crypto"
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { crudDeployment, fetchDeployment, fetchProject } from "@lib/dao"
import {
  DEPLOYMENT_CATALOGUE_IMPORT_KIND,
  enqueue,
  enqueueSigning,
  isTrustedDeploymentCatalogueWorkflow,
  PUBLISH_KINDS,
} from "@lib/jobs"
import { LambdaClient } from "@aws-sdk/client-lambda"
import { environmentFor } from "@lib/jobs"
import {
  DEFAULT_HANDLER,
  DEFAULT_RUNTIME,
  isSupportedRuntime,
  runMigration,
  runtimeForPreset,
  SUPPORTED_RUNTIMES,
} from "@lib/lambda"
import { verifyGitHubOidcToken } from "@lib/oauth"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { validate as validateUUID } from "uuid"
import { validator } from "../utils/validator"
import { authMiddleware } from "../middleware"
import { requirePermission } from "../rbac"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { deployStatusSchemaParam, deployStatusSchemaResponse } from "./deploy.serializer"

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
 * Long enough to upload a large artifact and wait through the migration and publication window;
 * short enough that a token captured from a log is worthless by the time anyone reads it. Stateless
 * — an HMAC over the claims — because a revocation table for a credential that expires in thirty
 * minutes is machinery guarding nothing.
 */
const TOKEN_TTL_SECONDS = 30 * 60

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
export function mintDeployToken(
  projectId: string,
  expiresAt: number,
  secret: string,
  actorUserId?: string,
): string {
  const body =
    actorUserId === undefined
      ? `${projectId}.${expiresAt}`
      : `${projectId}.${expiresAt}.${actorUserId}`
  const mac = createHmac("sha256", secret).update(body).digest("base64url")
  return `${body}.${mac}`
}

export function readDeployToken(
  token: string,
  secret: string,
  now: () => number = Date.now,
): { projectId: string; actorUserId?: string } | undefined {
  const parts = token.split(".")
  if (parts.length !== 3 && parts.length !== 4) return undefined

  const projectId = parts[0]
  const expiry = parts[1]
  const actorUserId = parts.length === 4 ? parts[2] : undefined
  const mac = parts.at(-1)
  if (projectId === undefined || expiry === undefined || mac === undefined) return undefined
  const body =
    actorUserId === undefined ? `${projectId}.${expiry}` : `${projectId}.${expiry}.${actorUserId}`
  const expected = createHmac("sha256", secret).update(body).digest("base64url")

  // Constant-time: the comparison is against a value the caller chooses and can vary a byte at a
  // time, which is exactly the shape a timing attack needs.
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined

  if (Number(expiry) <= Math.floor(now() / 1000)) return undefined
  return actorUserId === undefined ? { projectId } : { projectId, actorUserId }
}

const tokenRequest = Type.Object({
  oidc_token: Type.String({ minLength: 1 }),
  /*
    Which project in that repository, by slug or id.

    Optional for the single-project case, which is most of them, and **required the moment a
    repository holds more than one** — see the exchange below for why guessing is not an option.
    This is not a security input: the repository still comes from the verified OIDC claim, and a
    project named here that belongs to a different repository is refused.
  */
  project: Type.Optional(Type.String({ minLength: 1 })),
})
const tokenResponse = Type.Object({ token: Type.String(), expires_in: Type.Integer() })
const interactiveTokenParam = Type.Object({
  orgSlug: Type.String(),
  projectId: Type.String({ minLength: 1 }),
})

async function resolveInteractiveProject(organizationId: string, project: string) {
  return validateUUID(project)
    ? await fetchProject(db).getInOrganization(organizationId, project, ["id", "isGroup"])
    : await fetchProject(db).getBySlug(organizationId, project, ["id", "isGroup"])
}

const catalogueImportRequest = Type.Object({
  oidc_token: Type.String({ minLength: 1 }),
  oci_digest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
})
const catalogueImportResponse = Type.Object({
  job_id: Type.String(),
  oci_digest: Type.String(),
})

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
  /*
    What this build runs on.

    Optional, defaulting from the preset, so an older action keeps deploying — the action ships from
    its own repository and customers pin versions, so a required field here would break every
    workflow that has not upgraded.
  */
  runtime: Type.Optional(Type.String({ minLength: 1 })),
  handler: Type.Optional(Type.String({ minLength: 1 })),
  /*
    The migrator's build, uploaded like the application's.

    Absent means no migration step, which is correct for a static site and for a project whose
    schema is managed elsewhere — and is recorded as `skipped` rather than silently nothing, so
    "this project has no migrations" and "somebody forgot" do not look the same on the deployment.
  */
  migration_key: Type.Optional(Type.String({ minLength: 1 })),
  migration_handler: Type.Optional(Type.String({ minLength: 1 })),
  /** The commit subject, so a deployment list reads like a history rather than a list of shas. */
  message: Type.Optional(Type.String({ maxLength: 500 })),
})

export function staticReleaseError(
  projectId: string,
  input: { preset: string; static_key?: string; static_digest?: string },
): string | undefined {
  if ((input.static_key === undefined) !== (input.static_digest === undefined)) {
    return "`static_key` and `static_digest` must either both be set or both be omitted."
  }
  if (input.preset === "static" && input.static_key === undefined) {
    return "The `static` preset requires the static asset archive uploaded by the action."
  }
  if (
    input.static_key !== undefined &&
    input.static_key !== `static/${projectId}/${input.static_digest}.zip`
  ) {
    return "`static_key` does not belong to this project and digest."
  }
  return undefined
}

export function releasePreviewNumber(environment: string, ref: string): number | null | undefined {
  if (environment === "production") return null
  const match = /^(?:refs\/pull\/)?(\d+)\/(?:merge|head)$/.exec(ref)
  if (match === null) return undefined
  const number = Number(match[1])
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/** A migration run on its own, uploaded through `/deploy/upload-url` like any other archive. */
const migrateRequest = Type.Object({
  migration_key: Type.String({ minLength: 1 }),
  migration_handler: Type.Optional(Type.String({ minLength: 1 })),
  runtime: Type.Optional(Type.String({ minLength: 1 })),
})

const migrateResponse = Type.Object({
  /** Whether the migrator itself succeeded. The call succeeds either way. */
  ok: Type.Boolean(),
  /** What the migrator printed, trimmed. The only thing worth showing whoever ran it. */
  output: Type.String(),
})
const releaseResponse = Type.Object({
  deployment_id: Type.String(),
  url: Type.Optional(Type.String()),
})

/** The bearer token on the two calls that follow the exchange. */
function bearer(
  header: string | undefined,
): { projectId: string; actorUserId?: string } | undefined {
  const token = header?.startsWith("Bearer ") === true ? header.slice(7) : undefined
  if (token === undefined) return undefined
  return readDeployToken(token, tokenSecret())
}

const deploy: Hono = new Hono()
  .post(
    "/deploy/catalogue/import",
    describeRoute({
      description:
        "Queues an immutable Deployment-Templates catalogue import after GitHub OIDC identity verification.",
      responses: {
        202: {
          description: "The signed catalogue was queued for verification and reconciliation",
          content: { "application/json": { schema: resolver(catalogueImportResponse) } },
        },
        401: { description: "The OIDC token or trusted workflow identity did not verify" },
      },
    }),
    validator("json", catalogueImportRequest),
    async (c) => {
      const { oidc_token, oci_digest } = c.req.valid("json")
      let claims: Awaited<ReturnType<typeof verifyGitHubOidcToken>>
      try {
        claims = await verifyGitHubOidcToken(oidc_token)
      } catch (cause) {
        console.error(`catalogue import OIDC verification refused: ${String(cause)}`)
        return c.json({ message: "The OIDC token did not verify" }, 401)
      }
      if (!isTrustedDeploymentCatalogueWorkflow(claims)) {
        console.error(
          `catalogue import refused repository=${claims.repository} ref=${claims.ref} workflow_ref=${claims.workflowRef}`,
        )
        return c.json({ message: "The OIDC token did not verify" }, 401)
      }

      const jobId = await enqueue(db, {
        kind: DEPLOYMENT_CATALOGUE_IMPORT_KIND,
        payload: { ociDigest: oci_digest, sourceSha: claims.sha },
        idempotencyKey: `${DEPLOYMENT_CATALOGUE_IMPORT_KIND}:oidc:${claims.runId}:${oci_digest}`,
        maxAttempts: 5,
      })
      return c.json({ job_id: jobId, oci_digest }, 202)
    },
  )
  .post(
    "/orgs/:orgSlug/projects/:projectId/deploy-token",
    describeRoute({
      description: "Authorize an interactive deployment of one project",
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      responses: {
        200: {
          description: "A project-bound deploy token",
          content: { "application/json": { schema: resolver(tokenResponse) } },
        },
        400: { description: "The project is a group and cannot deploy" },
        403: { description: "Caller lacks deployment:write" },
        404: { description: "No such project in this organization" },
      },
    }),
    authMiddleware,
    validator("param", interactiveTokenParam),
    requirePermission("deployment:write", async (c, organization) => {
      const projectReference = c.req.param("projectId") ?? ""
      const project = await resolveInteractiveProject(organization.id, projectReference)
      return { service: "project", type: "project", id: project?.id ?? projectReference }
    }),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const project = await resolveInteractiveProject(c.var.organization.id, projectId)
      if (project === undefined) return throwNotFound(c, "Project not found")
      if (project.isGroup) return throwBadRequest(c, "A project group cannot be deployed")

      const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
      return c.json({
        token: mintDeployToken(project.id, expiresAt, tokenSecret(), c.var.user.id),
        expires_in: TOKEN_TTL_SECONDS,
      })
    },
  )
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

      /*
        **Every** project in that repository, not the first one.

        This used to be `executeTakeFirst()` with no `orderBy` and no `limit`, which is a silent
        arbitrary pick the moment a repository holds more than one project — and it already could,
        because `project_repository_target_live_key` is keyed on `root_dir` precisely so a monorepo
        can deploy its web app and its API separately. Groups made that the normal case rather than
        the unlucky one: a group and all of its children share a `repository_id`.

        A wrong pick here is not a failed deploy, which would at least be visible. It is a
        *successful* deploy of the right code onto the wrong service, and every call after this one
        takes the project from the token, so nothing downstream can notice.
      */
      const candidates = await db
        .selectFrom("project")
        .innerJoin("repository", "repository.id", "project.repositoryId")
        .select([
          "project.id as id",
          "project.slug as slug",
          "project.isGroup as isGroup",
          "project.rootDir as rootDir",
        ])
        .where("repository.ownerLogin", "=", owner)
        .where("repository.name", "=", name)
        .where("project.deletedAt", "is", null)
        .orderBy("project.createdAt", "asc")
        .execute()

      if (candidates.length === 0) {
        return c.json({ message: `No SproutOS project is connected to ${claims.repository}` }, 404)
      }

      // A group holds children; it has no root directory to build and no function to publish.
      const deployable = candidates.filter((row) => !row.isGroup)
      const requested = c.req.valid("json").project

      let project: (typeof candidates)[number] | undefined

      if (requested === undefined) {
        /*
          Refuse the ambiguity rather than resolve it.

          Picking one would be indistinguishable from working, right up until somebody notices the
          API has been serving the website's build for a week. The error names the candidates so the
          fix is to copy one into the workflow, not to go reading the database.
        */
        if (deployable.length > 1) {
          return c.json(
            {
              message:
                `${claims.repository} has ${deployable.length} deployable projects ` +
                `(${deployable.map((row) => row.slug).join(", ")}). ` +
                `Set the \`project\` input on the deploy action to say which one this workflow deploys.`,
            },
            400,
          )
        }
        project = deployable[0]
      } else {
        project = deployable.find((row) => row.slug === requested || row.id === requested)
      }

      if (project === undefined) {
        /*
          Distinguish "that is a group" from "no such project".

          Naming a group is a plausible mistake — it is the thing the repository is called in the
          UI — and "no project connected to this repository" would be actively misleading, because
          one is connected and the caller just named its parent.
        */
        const group = candidates.find(
          (row) => row.isGroup && (row.slug === requested || row.id === requested),
        )
        if (group !== undefined) {
          return c.json(
            {
              message:
                `\`${requested}\` is a project group, which holds other projects and does not ` +
                `deploy on its own. Name one of its projects instead.`,
            },
            400,
          )
        }
        return c.json(
          {
            message:
              requested === undefined
                ? `No deployable SproutOS project is connected to ${claims.repository}`
                : `${claims.repository} has no deployable project called \`${requested}\``,
          },
          404,
        )
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

      const staticError = staticReleaseError(authorized.projectId, json)
      if (staticError !== undefined) return c.json({ message: staticError }, 400)

      const prNumber = releasePreviewNumber(json.environment, json.ref)
      if (prNumber === undefined) {
        return c.json(
          {
            message:
              "A non-production release must come from refs/pull/<number>/merge (or /head), " +
              "so its preview hostname cannot collide with production.",
          },
          400,
        )
      }

      /*
        Resolve the runtime here, not at publish time.

        Validated against Lambda's own set so a typo is a 400 that names the field, rather than a
        deploy that queues, runs, and dies inside `UpdateFunctionConfiguration` with an AWS error
        that does not say which value it disliked.
      */
      const defaults = runtimeForPreset(json.preset)
      if (json.runtime !== undefined && !isSupportedRuntime(json.runtime)) {
        return c.json(
          {
            message: `\`runtime\` must be one of ${SUPPORTED_RUNTIMES.join(", ")} — got \`${json.runtime}\`.`,
          },
          400,
        )
      }

      const deployment = await crudDeployment(db).create({
        preset: json.preset,
        staticArtifactKey: json.static_key ?? null,
        staticDigest: json.static_digest ?? null,
        /*
          Copied onto the row, not read from the project later.

          A deployment is a historical fact — the same reasoning `scale_mode` and `runtime_class`
          already carry. It is also what makes rollback correct: republishing an old version has to
          use the runtime that version was built for, not whatever the project names today.
        */
        runtime: json.runtime ?? defaults.runtime,
        handler: json.handler ?? defaults.handler,
        /*
          Derived from the preset, never from the request.

          The adapter is a property of what the build *is*, and the preset is the action's own
          statement of that. Letting a caller set it independently of the handler would allow the
          one combination that fails silently — the wrapper set with no server to wrap, or a server
          published as a handler, which is the state every deployment in this account was in.

          An explicit `handler` overrides the preset's, so a customer who supplies their own Lambda
          entry point on a `next` build gets it — and then the adapter would be wrong, which is why
          it is off in that case.
        */
        webAdapter: defaults.webAdapter && json.handler === undefined,
        gitMessage: json.message ?? null,
        migrationArtifactKey: json.migration_key ?? null,
        migrationHandler: json.migration_handler ?? null,
        migrationStatus: json.migration_key === undefined ? "skipped" : "pending",
        /*
          Interactive deploy tokens carry the user who passed live RBAC. Repository tokens do not:
          GitHub OIDC proves a repository, not a person, so CI deploys remain unattributed rather
          than fabricating an author.
        */
        createdByUserId: authorized.actorUserId ?? null,
        projectId: authorized.projectId,
        // `preview` for anything that is not production, so a branch build cannot take a
        // production hostname by naming itself one.
        kind: json.environment === "production" ? "production" : "preview",
        prNumber,
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
  .get(
    "/deploy/deployments/:deploymentId",
    describeRoute({
      description:
        "Read one deployment's publish status. Called by the deploy action until the release is terminal.",
      responses: {
        200: {
          description: "The deployment's current status and any recorded failure details",
          content: { "application/json": { schema: resolver(deployStatusSchemaResponse) } },
        },
        401: { description: "Missing or expired deploy token" },
        404: { description: "No such deployment belongs to the token's project" },
      },
    }),
    validator("param", deployStatusSchemaParam),
    async (c) => {
      const authorized = bearer(c.req.header("Authorization"))
      if (authorized === undefined) return c.json({ message: "Unauthorized" }, 401)

      const { deploymentId } = c.req.valid("param")
      const deployment = await fetchDeployment(db).getForProject(
        authorized.projectId,
        deploymentId,
        ["id", "status", "failureReason", "migrationStatus", "migrationOutput", "url"],
      )
      if (deployment === undefined) return c.json({ message: "Deployment not found" }, 404)

      return c.json({
        deployment_id: deployment.id,
        status: deployment.status,
        failure_reason: deployment.failureReason,
        migration_status: deployment.migrationStatus,
        migration_output: deployment.migrationOutput,
        url: deployment.url,
      })
    },
  )
  /**
   * Run a migration on its own, without a deploy.
   *
   * `deploy.release` already runs one before the alias moves, which is the ordering that matters for
   * a release. This is the other case Andrew asked for: a migration invoked from an API call, so a
   * team whose CI is not this action — or whose schema change ships on its own schedule — can still
   * use the runner rather than opening a psql session against the tenant proxy.
   *
   * Synchronous, and the outcome is the response. Lambda's fifteen-minute ceiling is the timeout and
   * it is named in the failure, because a migration that exceeds it needs a different tool and
   * finding that out mid-migration is the worst possible moment.
   *
   * **Not retried, here or anywhere.** Re-running a partially applied schema change is how a
   * recoverable failure becomes an unrecoverable one. The migrator owns idempotency; this reports
   * what it reported.
   */
  .post(
    "/deploy/migrate",
    describeRoute({
      description: "Run an uploaded migrator against the project's database, and wait for it",
      responses: {
        200: {
          description: "The migrator ran. `ok` says whether it succeeded",
          content: { "application/json": { schema: resolver(migrateResponse) } },
        },
        401: { description: "Missing or expired deploy token" },
      },
    }),
    validator("json", migrateRequest),
    async (c) => {
      const authorized = bearer(c.req.header("Authorization"))
      if (authorized === undefined) return c.json({ message: "Unauthorized" }, 401)

      const json = c.req.valid("json")

      if (json.runtime !== undefined && !isSupportedRuntime(json.runtime)) {
        return c.json(
          {
            message: `\`runtime\` must be one of ${SUPPORTED_RUNTIMES.join(", ")} — got \`${json.runtime}\`.`,
          },
          400,
        )
      }

      const project = await db
        .selectFrom("project")
        .select(["id", "organizationId"])
        .where("id", "=", authorized.projectId)
        .where("deletedAt", "is", null)
        .executeTakeFirst()
      if (project === undefined) return c.json({ message: "That project no longer exists" }, 404)

      /*
        The project's own environment, which is where `DATABASE_URL` lives.

        Read through the same path a deploy uses rather than accepting one from the caller: a
        migration endpoint that took a connection string would let anyone holding a deploy token
        point this project's migrator at a database it has no business touching.
      */
      const environment = await environmentFor(db, project.id, "production")

      const result = await runMigration(new LambdaClient({}), {
        projectId: project.id,
        bucket: process.env.SERVICE_BUILD_BUCKET ?? "sproutos-dev-artifacts",
        key: json.migration_key,
        handler: json.migration_handler ?? DEFAULT_HANDLER,
        runtime:
          json.runtime !== undefined && isSupportedRuntime(json.runtime)
            ? json.runtime
            : DEFAULT_RUNTIME,
        roleArn: process.env.LAMBDA_EXECUTION_ROLE_ARN ?? "",
        environment,
      })

      // 200 either way: the call succeeded and the migrator's verdict is the payload. A 500 here
      // would say the platform failed, which is a different thing from the migration failing.
      return c.json({ ok: result.ok, output: result.output })
    },
  )

export default deploy

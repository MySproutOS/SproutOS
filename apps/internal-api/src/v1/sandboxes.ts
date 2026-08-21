import { crudAuditLog, crudSandbox, fetchProject, fetchSandbox } from "@lib/dao"
import { createKubeClient, inClusterConfig } from "@lib/deploy"
import { tenantNamespace } from "@lib/jobs"
import {
  devSandboxPod,
  exec,
  listFiles,
  PathEscapesWorkspaceError,
  podPath,
  readFile,
  sandboxRuntimeClass,
  writeFile,
  type SandboxTarget,
} from "@lib/sandbox"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { auditContext } from "../utils/request-context"
import { throwBadRequest, throwConflict, throwNotFound } from "../utils/http-exception"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import {
  sandboxSchemaExecRequest,
  sandboxSchemaExecResponse,
  sandboxSchemaFileQuery,
  sandboxSchemaFileResponse,
  sandboxSchemaListResponse,
  sandboxSchemaProjectParam,
  sandboxSchemaTreeQuery,
  sandboxSchemaSandbox,
  sandboxSchemaWriteRequest,
} from "./sandboxes.serializer"

/**
 * TASK 19: dev sandboxes.
 *
 * A pod per (project, user) holding a workspace, with a file API and a terminal into it. The
 * `sandbox` table has existed since the init migration — `pod_name`, `namespace`, `runtime_class`,
 * `idle_timeout_s`, `always_on` — and nothing read or wrote a row; `sandbox:read` and
 * `sandbox:write` were in the action catalogue guarding nothing.
 *
 * Every operation goes through `pods/exec` into the running pod rather than through the control
 * plane's own filesystem. That is the whole point: the workspace is a customer's code, and the
 * process that reads it should be one inside the tenant's namespace and its NetworkPolicy.
 */

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/** The image a dev sandbox runs. Node, because that is what most of the store's apps need. */
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? "node:24-alpine"

/** Fifteen minutes, matching the column default. */
const IDLE_TIMEOUT_S = 900

function serialize(row: {
  id: string
  state: string
  podName: string | null
  namespace: string | null
  runtimeClass: string
  idleTimeoutS: number
  alwaysOn: boolean
  lastActivityAt: Date
  createdAt: Date
}) {
  return {
    id: row.id,
    state: row.state,
    podName: row.podName,
    namespace: row.namespace,
    // The column is NOT NULL with a `kata-clh` default, and a cluster without that runtime class
    // does not have one. Reported as null rather than as the name of a class the pod is not using —
    // claiming a VM boundary that is not there is worse than saying there is none.
    runtimeClass: sandboxRuntimeClass() ?? null,
    idleTimeoutSeconds: row.idleTimeoutS,
    alwaysOn: row.alwaysOn,
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

/** The sandbox for this caller and project, or a 404. Also stamps it as used. */
async function activeSandbox(
  organizationId: string,
  projectId: string,
  userId: string,
): Promise<(SandboxTarget & { id: string }) | undefined> {
  const row = await fetchSandbox(db).forUser(organizationId, projectId, userId)
  if (row === undefined || row.podName === null || row.namespace === null) return undefined
  if (row.state !== "running") return undefined

  // Every read counts as activity. A person reading code for twenty minutes is using the sandbox,
  // and a reaper that only watched writes would stop it underneath them.
  await crudSandbox(db).touch(row.id)

  const config = inClusterConfig()
  return {
    id: row.id,
    server: config.server,
    ...(config.token === undefined ? {} : { token: config.token }),
    ...(config.certificateAuthority === undefined
      ? {}
      : { certificateAuthority: config.certificateAuthority }),
    namespace: row.namespace,
    pod: row.podName,
  }
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/projects/:projectId/sandbox",
    describeRoute({
      description: "The caller's dev sandbox for this project",
      responses: {
        200: {
          description: "The sandbox",
          content: { "application/json": { schema: resolver(sandboxSchemaSandbox) } },
        },
        403: { description: "Caller lacks sandbox:read", ...errorResponse },
        404: { description: "No sandbox for this caller and project", ...errorResponse },
      },
    }),
    requirePermission("sandbox:read", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const row = await fetchSandbox(db).forUser(c.var.organization.id, projectId, c.var.user.id)
      if (row === undefined) return throwNotFound(c, "No sandbox for this project")
      return c.json(serialize(row))
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/sandbox",
    describeRoute({
      description: "Starts the caller's dev sandbox, or returns the running one",
      responses: {
        201: {
          description: "The sandbox",
          content: { "application/json": { schema: resolver(sandboxSchemaSandbox) } },
        },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        404: { description: "No such project", ...errorResponse },
      },
    }),
    requirePermission("sandbox:write", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    async (c) => {
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, [
        "id",
        "repositoryId",
      ])
      if (!project) return throwNotFound(c, "Project not found")

      const existing = await fetchSandbox(db).forUser(organization.id, projectId, c.var.user.id)
      // Idempotent. Two clicks on "open" are the common case and the second must not create a
      // second pod holding a second copy of the workspace.
      if (existing !== undefined && existing.state === "running") {
        await crudSandbox(db).touch(existing.id)
        return c.json(serialize(existing), 201)
      }

      const namespace = tenantNamespace(organization.id)
      const row =
        existing ??
        (await crudSandbox(db).create({
          projectId,
          userId: c.var.user.id,
          state: "starting",
          idleTimeoutS: IDLE_TIMEOUT_S,
        }))

      const podName = `sbx-${row.id.replaceAll("-", "").slice(-16)}`

      try {
        const client = createKubeClient(inClusterConfig())
        await client.apply(
          podPath(namespace, podName),
          devSandboxPod({
            namespace,
            name: podName,
            image: SANDBOX_IMAGE,
            idleTimeoutSeconds: IDLE_TIMEOUT_S,
            ...(sandboxRuntimeClass() === undefined
              ? {}
              : { runtimeClassName: sandboxRuntimeClass() }),
          }),
        )
      } catch (error) {
        // Recorded on the row rather than only thrown: a sandbox stuck in `starting` with no reason
        // is the state a customer opens a ticket about.
        await crudSandbox(db).update(row.id, { state: "error" })
        throw error
      }

      const started = await crudSandbox(db).update(row.id, {
        podName,
        namespace,
        // `running` when the pod has been accepted, not when it is Ready: the file and exec routes
        // fail with the API server's own message if it is not, which is more use than this route
        // blocking for a minute to say the same thing.
        state: "running",
        lastActivityAt: new Date(),
      })

      await crudAuditLog(db).record({
        organizationId: organization.id,
        actorUserId: c.var.user.id,
        action: "sandbox:write",
        resourceSrn: srnFor("compute", organization.id, "sandbox", row.id),
        after: { podName, namespace },
        ...auditContext(c),
      })

      return c.json(serialize(started ?? row), 201)
    },
  )
  .delete(
    "/:orgSlug/projects/:projectId/sandbox",
    describeRoute({
      description: "Stops the caller's dev sandbox",
      responses: {
        204: { description: "Stopped" },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        404: { description: "No sandbox for this caller and project", ...errorResponse },
      },
    }),
    requirePermission("sandbox:write", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const row = await fetchSandbox(db).forUser(c.var.organization.id, projectId, c.var.user.id)
      if (row === undefined) return throwNotFound(c, "No sandbox for this project")

      if (row.podName !== null && row.namespace !== null) {
        await createKubeClient(inClusterConfig()).remove(podPath(row.namespace, row.podName))
      }

      // The row stays, marked stopped. It carries `always_on` and the timeout a customer set, and
      // deleting it would silently reset both the next time they opened one.
      await crudSandbox(db).update(row.id, { state: "stopped", podName: null })
      return c.body(null, 204)
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/sandbox/files",
    describeRoute({
      description: "Reads one file out of the workspace",
      responses: {
        200: {
          description: "The file",
          content: { "application/json": { schema: resolver(sandboxSchemaFileResponse) } },
        },
        400: { description: "The path leaves the workspace", ...errorResponse },
        403: { description: "Caller lacks sandbox:read", ...errorResponse },
        404: { description: "No such file", ...errorResponse },
        409: { description: "The sandbox is not running", ...errorResponse },
      },
    }),
    requirePermission("sandbox:read", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    validator("query", sandboxSchemaFileQuery),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const { path } = c.req.valid("query")

      const target = await activeSandbox(c.var.organization.id, projectId, c.var.user.id)
      if (target === undefined) return throwConflict(c, "The sandbox is not running")

      try {
        const result = await readFile(target, path)
        if (result.exitCode !== 0) {
          // `cat` says why — no such file, is a directory, permission denied — and that is more
          // useful than a generic message this route would have to invent.
          return throwNotFound(c, result.stderr.trim() || "Not found")
        }
        return c.json({ path, contents: result.stdout })
      } catch (error) {
        if (error instanceof PathEscapesWorkspaceError) {
          return throwBadRequest(c, error.message)
        }
        throw error
      }
    },
  )
  /**
   * Listing, as its own route rather than a trailing slash on `/files`.
   *
   * The first version overloaded the read: a path ending in `/` listed a directory and anything
   * else read a file, which meant one endpoint with two response shapes and a generated client that
   * could not type either. Two routes, two schemas, and no rule anybody has to remember.
   */
  .get(
    "/:orgSlug/projects/:projectId/sandbox/tree",
    describeRoute({
      description: "Lists a directory in the workspace",
      responses: {
        200: {
          description: "The entries; a trailing slash marks a directory",
          content: { "application/json": { schema: resolver(sandboxSchemaListResponse) } },
        },
        400: { description: "The path leaves the workspace", ...errorResponse },
        403: { description: "Caller lacks sandbox:read", ...errorResponse },
        409: { description: "The sandbox is not running", ...errorResponse },
      },
    }),
    requirePermission("sandbox:read", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    validator("query", sandboxSchemaTreeQuery),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const path = c.req.valid("query").path ?? "."

      const target = await activeSandbox(c.var.organization.id, projectId, c.var.user.id)
      if (target === undefined) return throwConflict(c, "The sandbox is not running")

      try {
        const result = await listFiles(target, path)
        if (result.exitCode !== 0) return throwNotFound(c, result.stderr.trim() || "Not found")
        return c.json({
          path,
          entries: result.stdout.split("\n").filter((entry) => entry !== ""),
        })
      } catch (error) {
        if (error instanceof PathEscapesWorkspaceError) {
          return throwBadRequest(c, error.message)
        }
        throw error
      }
    },
  )
  .put(
    "/:orgSlug/projects/:projectId/sandbox/files",
    describeRoute({
      description: "Writes one file, creating its directories",
      responses: {
        200: {
          description: "Written",
          content: { "application/json": { schema: resolver(sandboxSchemaFileResponse) } },
        },
        400: { description: "The path leaves the workspace", ...errorResponse },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        409: { description: "The sandbox is not running", ...errorResponse },
      },
    }),
    requirePermission("sandbox:write", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    validator("json", sandboxSchemaWriteRequest),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const { path, contents } = c.req.valid("json")

      const target = await activeSandbox(c.var.organization.id, projectId, c.var.user.id)
      if (target === undefined) return throwConflict(c, "The sandbox is not running")

      try {
        const result = await writeFile(target, path, contents)
        if (result.exitCode !== 0) {
          return throwBadRequest(c, result.stderr.trim() || "Could not write the file")
        }
        return c.json({ path, contents })
      } catch (error) {
        if (error instanceof PathEscapesWorkspaceError) {
          return throwBadRequest(c, error.message)
        }
        throw error
      }
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/sandbox/exec",
    describeRoute({
      description: "Runs a command in the sandbox. This is the terminal",
      responses: {
        200: {
          description: "What the command said, and its exit code",
          content: { "application/json": { schema: resolver(sandboxSchemaExecResponse) } },
        },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        409: { description: "The sandbox is not running", ...errorResponse },
      },
    }),
    // `sandbox:write`, not `sandbox:read`. Running a command can change the workspace, and the
    // permission has to be the one that says so — a reader who can also run `rm` is not a reader.
    requirePermission("sandbox:write", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    validator("json", sandboxSchemaExecRequest),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const { command, timeoutMs } = c.req.valid("json")

      const target = await activeSandbox(c.var.organization.id, projectId, c.var.user.id)
      if (target === undefined) return throwConflict(c, "The sandbox is not running")

      const result = await exec(target, command, timeoutMs)
      return c.json(result)
    },
  )

export default app

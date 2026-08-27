import { crudAuditLog, crudSandbox, fetchProject, fetchSandbox, sandboxScopeFor } from "@lib/dao"
import { requestSandboxDestroy, requestSandboxStart, SandboxDeletingError } from "@lib/jobs"
import {
  daytonaClientFromEnv,
  SandboxNotFoundError,
  SandboxUnavailableError,
  WORKSPACE_DIR,
  type DaytonaSandboxClient,
} from "@lib/sandbox"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import type { Selectable } from "kysely"
import type { DB } from "@sproutos/db"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import {
  throwBadRequest,
  throwConflict,
  throwInternalServerError,
  throwNotFound,
} from "../utils/http-exception"
import { requireArray } from "../utils/require-array"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  sandboxSchemaExecRequest,
  sandboxSchemaExecResponse,
  sandboxSchemaFileQuery,
  sandboxSchemaFileResponse,
  sandboxSchemaListResponse,
  sandboxSchemaPreviewQuery,
  sandboxSchemaPreviewResponse,
  sandboxSchemaProjectParam,
  sandboxSchemaSandbox,
  sandboxSchemaTreeQuery,
  sandboxSchemaWriteRequest,
} from "./sandboxes.serializer"

/**
 * Dev sandboxes: one per (project, user), holding a checkout and a shell into it.
 *
 * The route existed for the Kubernetes era and went with the cluster in `2249bad`; the table, both
 * DAOs, this file's serializer and the `sandbox:read`/`sandbox:write` actions all survived, which
 * is most of why bringing it back is small. What changed underneath is where the sandbox runs:
 * every operation now goes through `@lib/sandbox` to a rented provider rather than through
 * `pods/exec` into a pod we scheduled.
 *
 * The reason is unchanged and worth restating, because it is the whole point of the file: the
 * workspace holds a customer's code, and the process that reads and executes it must not be one
 * holding the platform's credentials. Finding 0007's eleventh defect was "the agent had a shell in
 * the control-plane pod".
 */

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/** Fifteen minutes, matching the column default and what a person expects "idle" to mean. */
const IDLE_TIMEOUT_S = 900

/** How long a preview link lives. Long enough to load a page and short enough to be worth signing. */
const PREVIEW_TTL_S = 3600

/** Where a dev server usually listens. Overridable per request; recorded on the row when used. */
const DEFAULT_PREVIEW_PORT = 3000

/**
 * Built per request, not at module load.
 *
 * A Daytona client constructed while this module is imported reads configuration that a process
 * may not have — the OpenAPI generator, for one, imports every route and would then fail to start wherever
 * `DAYTONA_API_KEY` is absent. `2249bad` records the same bug with a Redis client, where
 * the generator's process never exited and timed out at three minutes.
 */
function daytona(): DaytonaSandboxClient {
  return daytonaClientFromEnv()
}

function serialize(row: Selectable<DB["sandbox"]>) {
  return {
    id: row.id,
    state: row.state,
    provider: row.provider,
    externalId: row.externalId,
    sandboxClass: row.sandboxClass,
    cpu: row.cpu,
    memoryGib: row.memoryGib,
    diskGib: row.diskGib,
    previewPort: row.previewPort,
    idleTimeoutSeconds: row.idleTimeoutS,
    alwaysOn: row.alwaysOn,
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * A path inside the workspace, or nothing.
 *
 * Refused rather than rebased. A `..` that is normalised away is a request the caller did not make
 * being answered as though they had, and the difference between refusing `../../etc/passwd` and
 * quietly reading `workspace/etc/passwd` is that only one of them tells the caller they were wrong.
 * Absolute paths are refused for the same reason.
 */
function workspacePath(relative: string): string | null {
  if (relative.startsWith("/") || relative.includes("..") || relative.includes("\0")) return null
  return `${WORKSPACE_DIR}/${relative}`
}

/**
 * The sandbox for this caller and project, with its activity stamped.
 *
 * Every read, every command, every poll. The reaper stops a sandbox idle for `idle_timeout_s`, and
 * idle has to mean *nobody is using it* rather than *nothing has been written* — a person reading
 * code for twenty minutes is using it.
 */
/**
 * The sandbox for a project, which is the sandbox for its *group*.
 *
 * A group is one repository and one checkout; its children are directories inside it. A sandbox per
 * child would mean two clones of the same repository, two `node_modules`, two dev servers that
 * cannot see each other, and an agent that fixes a shared library in one and cannot see it from
 * the other. For a monorepo — the shape this platform is built around — that is not isolation, it
 * is a split brain.
 *
 * Every route here goes through this rather than through `forUser` directly, so that asking about
 * `apps/website` and asking about `apps/internal-api` reach the same workspace. Bypassing it is how
 * two sandboxes for one repository would come back.
 */
async function sandboxFor(organizationId: string, projectId: string, userId: string) {
  const scope = await sandboxScopeFor(db, organizationId, projectId)
  if (scope === undefined) return undefined
  return await fetchSandbox(db).forUser(organizationId, scope, userId)
}

async function activeSandbox(organizationId: string, projectId: string, userId: string) {
  const row = await sandboxFor(organizationId, projectId, userId)
  if (row === undefined) return undefined
  await crudSandbox(db).touch(row.id)
  return row
}

/** Turn a provider fault into an honest status. A vendor being down is not a bad request. */
function providerError(c: Parameters<typeof throwNotFound>[0], error: unknown) {
  if (error instanceof SandboxNotFoundError) {
    return throwNotFound(c, "The sandbox no longer exists at its provider")
  }
  if (error instanceof SandboxUnavailableError) {
    return throwInternalServerError(c, "The sandbox provider is unavailable")
  }
  throw error
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
      const row = await sandboxFor(c.var.organization.id, projectId, c.var.user.id)
      if (row === undefined) return throwNotFound(c, "No sandbox for this project")
      return c.json(serialize(row))
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/sandbox",
    describeRoute({
      description: "Starts the caller's dev sandbox, or returns the one already running",
      responses: {
        201: {
          description: "The sandbox, starting or already running",
          content: { "application/json": { schema: resolver(sandboxSchemaSandbox) } },
        },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        404: { description: "No such project", ...errorResponse },
        409: { description: "The previous sandbox is being deleted", ...errorResponse },
      },
    }),
    requirePermission("sandbox:write", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    async (c) => {
      const organization = c.var.organization
      const { projectId } = c.req.valid("param")

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (!project) return throwNotFound(c, "Project not found")

      const scope = (await sandboxScopeFor(db, organization.id, projectId)) ?? projectId
      let created
      try {
        created = await requestSandboxStart(db, {
          organizationId: organization.id,
          projectId: scope,
          userId: c.var.user.id,
          idleTimeoutS: IDLE_TIMEOUT_S,
        })
      } catch (error) {
        if (error instanceof SandboxDeletingError) {
          return throwConflict(c, "The previous sandbox is still being deleted")
        }
        throw error
      }

      await crudAuditLog(db).record({
        organizationId: organization.id,
        actorUserId: c.var.user.id,
        action: "sandbox:write",
        resourceSrn: `sandbox/${created.id}`,
        after: { state: "starting" },
        ...auditContext(c),
      })

      return c.json(serialize(created), 201)
    },
  )
  .delete(
    "/:orgSlug/projects/:projectId/sandbox",
    describeRoute({
      description: "Permanently deletes the caller's dev sandbox and its database branch",
      responses: {
        202: { description: "Deletion queued" },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        404: { description: "No sandbox for this caller and project", ...errorResponse },
      },
    }),
    requirePermission("sandbox:write", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const scope = await sandboxScopeFor(db, c.var.organization.id, projectId)
      if (scope === undefined) return throwNotFound(c, "No sandbox for this project")
      const row = await requestSandboxDestroy(db, {
        organizationId: c.var.organization.id,
        projectId: scope,
        userId: c.var.user.id,
      })
      if (row === undefined) return throwNotFound(c, "No sandbox for this project")

      await crudAuditLog(db).record({
        organizationId: c.var.organization.id,
        actorUserId: c.var.user.id,
        action: "sandbox:write",
        resourceSrn: `sandbox/${row.id}`,
        after: { state: "deleting" },
        ...auditContext(c),
      })

      return c.body(null, 202)
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/sandbox/activity",
    describeRoute({
      description: "Keeps an actively viewed sandbox preview from being reaped",
      responses: {
        204: { description: "Activity recorded" },
        403: { description: "Caller lacks sandbox:read", ...errorResponse },
        404: { description: "No running sandbox for this caller and project", ...errorResponse },
      },
    }),
    requirePermission("sandbox:read", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const row = await sandboxFor(c.var.organization.id, projectId, c.var.user.id)
      if (row === undefined || row.externalId === null || row.state !== "running") {
        return throwNotFound(c, "No running sandbox for this project")
      }

      try {
        // Keep both clocks aligned. Preview HTTP reaches Daytona directly and would otherwise keep
        // only the provider clock alive while Sprout's reaper stopped a page somebody was viewing.
        await daytona().touch(row.externalId)
        await crudSandbox(db).touch(row.id)
        return c.body(null, 204)
      } catch (error) {
        return providerError(c, error)
      }
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/sandbox/preview",
    describeRoute({
      description: "A signed, short-lived URL onto a port in the sandbox",
      responses: {
        200: {
          description: "The preview link",
          content: { "application/json": { schema: resolver(sandboxSchemaPreviewResponse) } },
        },
        403: { description: "Caller lacks sandbox:read", ...errorResponse },
        404: { description: "No running sandbox for this caller and project", ...errorResponse },
      },
    }),
    requirePermission("sandbox:read", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    validator("query", sandboxSchemaPreviewQuery),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const { port } = c.req.valid("query")

      const row = await activeSandbox(c.var.organization.id, projectId, c.var.user.id)
      if (row === undefined || row.externalId === null) {
        return throwNotFound(c, "No running sandbox for this project")
      }

      const target = port ?? row.previewPort ?? DEFAULT_PREVIEW_PORT

      try {
        /*
          Signed, minted per request, and never `public`.

          The provider's ordinary preview token goes in a header, which an `iframe` cannot set; the
          only other way to make one load is marking the sandbox public, which puts a customer's
          work-in-progress behind a guessable URL and no authentication at all.
        */
        const link = await daytona().previewUrl(row.externalId, target, PREVIEW_TTL_S)
        if (row.previewPort !== target) {
          await crudSandbox(db).update(row.id, { previewPort: target })
        }
        return c.json({ url: link.url, port: target, expiresAt: link.expiresAt.toISOString() })
      } catch (error) {
        return providerError(c, error)
      }
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/sandbox/file",
    describeRoute({
      description: "Reads a file from the sandbox workspace",
      responses: {
        200: {
          description: "The file",
          content: { "application/json": { schema: resolver(sandboxSchemaFileResponse) } },
        },
        400: { description: "Path escapes the workspace", ...errorResponse },
        403: { description: "Caller lacks sandbox:read", ...errorResponse },
        404: { description: "No running sandbox, or no such file", ...errorResponse },
      },
    }),
    requirePermission("sandbox:read", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    validator("query", sandboxSchemaFileQuery),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const { path } = c.req.valid("query")

      const row = await activeSandbox(c.var.organization.id, projectId, c.var.user.id)
      if (row === undefined || row.externalId === null) {
        return throwNotFound(c, "No running sandbox for this project")
      }

      const full = workspacePath(path)
      if (full === null) return throwBadRequest(c, "Path escapes the workspace")

      try {
        return c.json({ path, contents: await daytona().readFile(row.externalId, full) })
      } catch (error) {
        return providerError(c, error)
      }
    },
  )
  .put(
    "/:orgSlug/projects/:projectId/sandbox/file",
    describeRoute({
      description: "Writes a file into the sandbox workspace",
      responses: {
        204: { description: "Written" },
        400: { description: "Path escapes the workspace", ...errorResponse },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        404: { description: "No running sandbox for this caller and project", ...errorResponse },
      },
    }),
    requirePermission("sandbox:write", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    validator("json", sandboxSchemaWriteRequest),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const { path, contents } = c.req.valid("json")

      const row = await activeSandbox(c.var.organization.id, projectId, c.var.user.id)
      if (row === undefined || row.externalId === null) {
        return throwNotFound(c, "No running sandbox for this project")
      }

      const full = workspacePath(path)
      if (full === null) return throwBadRequest(c, "Path escapes the workspace")

      try {
        await daytona().writeFile(row.externalId, full, contents)
        return c.body(null, 204)
      } catch (error) {
        return providerError(c, error)
      }
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/sandbox/tree",
    describeRoute({
      description: "Lists a directory in the sandbox workspace",
      responses: {
        200: {
          description: "The listing",
          content: { "application/json": { schema: resolver(sandboxSchemaListResponse) } },
        },
        400: { description: "Path escapes the workspace", ...errorResponse },
        403: { description: "Caller lacks sandbox:read", ...errorResponse },
        404: { description: "No running sandbox for this caller and project", ...errorResponse },
      },
    }),
    requirePermission("sandbox:read", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    validator("query", sandboxSchemaTreeQuery),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const { path } = c.req.valid("query")

      const row = await activeSandbox(c.var.organization.id, projectId, c.var.user.id)
      if (row === undefined || row.externalId === null) {
        return throwNotFound(c, "No running sandbox for this project")
      }

      const full = path === undefined ? WORKSPACE_DIR : workspacePath(path)
      if (full === null) return throwBadRequest(c, "Path escapes the workspace")

      try {
        const entries = await daytona().tree(row.externalId, full)
        return c.json({
          path: path ?? "",
          // A trailing slash marks a directory, which is what the schema documents and what the
          // Kubernetes-era `ls -1Ap` produced. Kept so the client does not have to change.
          entries: entries.map((entry: { kind: string; path: string }) =>
            entry.kind === "directory" ? `${entry.path}/` : entry.path,
          ),
        })
      } catch (error) {
        return providerError(c, error)
      }
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/sandbox/exec",
    describeRoute({
      description: "Runs a command in the sandbox workspace",
      responses: {
        200: {
          description: "The result",
          content: { "application/json": { schema: resolver(sandboxSchemaExecResponse) } },
        },
        400: { description: "Command is not an argument vector", ...errorResponse },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        404: { description: "No running sandbox for this caller and project", ...errorResponse },
      },
    }),
    requirePermission("sandbox:write", paramResource("compute", "sandbox", "projectId")),
    validator("param", sandboxSchemaProjectParam),
    /*
      The guard, before the validator's coercion is invisible.

      `Value.Convert` runs before `Check` and wraps a scalar into a one-element array, so `"ls -la"`
      arrives as `["ls -la"]` and passes `minItems`. By the time a handler sees the value the
      evidence that a string was sent is gone — which is why this is here and not in the schema.
    */
    requireArray("command", 'an argument vector, e.g. ["ls", "-la"]'),
    validator("json", sandboxSchemaExecRequest),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const { command, timeoutMs } = c.req.valid("json")

      const row = await activeSandbox(c.var.organization.id, projectId, c.var.user.id)
      if (row === undefined || row.externalId === null) {
        return throwNotFound(c, "No running sandbox for this project")
      }

      try {
        const result = await daytona().exec(row.externalId, command, timeoutMs ?? 30_000)
        return c.json(result)
      } catch (error) {
        return providerError(c, error)
      }
    },
  )

export default app

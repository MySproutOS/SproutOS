import {
  crudAuditLog,
  crudSandbox,
  fetchProject,
  fetchSandbox,
  type SandboxRuntimeClass,
} from "@lib/dao"
import { createKubeClient, inClusterConfig } from "@lib/deploy"
import { tenantNamespace } from "@lib/jobs"
import {
  devSandboxPod,
  ensureTenantNamespace,
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
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { auditContext } from "../utils/request-context"
import { throwBadRequest, throwConflict, throwNotFound } from "../utils/http-exception"
import { requireArray } from "../utils/require-array"
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

/**
 * What `runtime_class` says when the pod was given no RuntimeClass at all.
 *
 * The column is `not null`, so the honest value has to be a word rather than a null. `none` states
 * the isolation the workload has: a namespace, its NetworkPolicies, and a pod with no
 * service-account token — not a VM. Taken from `SANDBOX_RUNTIME_CLASSES`, which the DAO tests
 * assert against the check constraint, so this cannot be a word the database will refuse.
 */
const NO_RUNTIME_CLASS: SandboxRuntimeClass = "none"

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
    /*
      What *this* pod got, from the row — not what a pod created right now would get.

      This read `sandboxRuntimeClass()`, the serving process's own environment variable, and
      reported that for every sandbox regardless of which one was being described. It gave the right
      answer only because the row was guaranteed wrong: the column defaulted to `kata-clh` and
      nothing ever wrote it, so reading the row would have claimed a VM boundary that did not exist,
      and reading the environment was the less wrong of two bad options.

      Both halves are fixed now — the row is written at creation and `none` is a value it can hold —
      so this reports the sandbox rather than the server. The difference shows up the moment
      `SANDBOX_RUNTIME_CLASS` is set on a cluster that already has running sandboxes: those pods
      have no VM around them, and this used to say they did.
    */
    runtimeClass: row.runtimeClass === NO_RUNTIME_CLASS ? null : row.runtimeClass,
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

  const config = inClusterConfig()

  /*
    The row says running. Check that the pod agrees.

    Without this, a pod that has gone away — evicted, node drained, deleted — leaves every file and
    exec route throwing whatever the exec attempt happens to fail with, which reached the client as
    a 500. A 500 says the platform is broken; the truth is that this customer's sandbox stopped,
    which is a 409 and a "start it again" button.

    The row is corrected on the way past, so the next `POST` builds a pod instead of short-circuiting
    on a state that is no longer true. One `GET` per operation, against an API server call the
    operation was about to make anyway.
  */
  const pod = await createKubeClient(config).get<{
    metadata?: { deletionTimestamp?: string }
    status?: { phase?: string }
  }>(podPath(row.namespace, row.podName))

  if (pod === undefined || pod.metadata?.deletionTimestamp !== undefined) {
    await crudSandbox(db).update(row.id, { state: "stopped" })
    return undefined
  }

  /*
    Running, not merely existing.

    A pod is `Pending` from the moment the API server accepts it until its image is pulled and the
    container starts — a few seconds normally, longer on a first pull. Exec against a Pending pod
    fails with whatever the API server says about a container that is not there, which reached the
    client as a 500: the platform reporting itself broken because a sandbox was still starting.

    The row is left alone. This is not a sandbox that has stopped, it is one that has not started
    yet, and rewriting the state would make the next `POST` build a second pod for the first one's
    workspace.
  */
  if (pod.status?.phase !== "Running") return undefined

  // Every read counts as activity. A person reading code for twenty minutes is using the sandbox,
  // and a reaper that only watched writes would stop it underneath them.
  await crudSandbox(db).touch(row.id)

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
      const namespace = tenantNamespace(organization.id)
      const client = createKubeClient(inClusterConfig())

      /*
        Idempotent, but only when there is really a pod.

        Two clicks on "open" are the common case and the second must not create a second pod holding
        a second copy of the workspace — so a row saying `running` short-circuits. It short-circuited
        on the row alone, and a row is not a pod.

        A pod can go away without the row hearing about it: a node drains, the pod is evicted, an
        operator deletes it, or — the way this was found — a delete issued moments earlier finishes
        its grace period *after* the create applied a pod of the same name, so the apply succeeds
        against an object that is already on its way out and the delete takes it.

        The row then says `running` forever. Every `POST` returns 201 and creates nothing, every
        file operation fails against a pod that is not there, and the API is telling the customer
        their sandbox is running the whole time. The only escape is a `DELETE` nobody has a reason
        to try.

        So: ask. One `GET` against the API server per open, which is nothing next to the pod it
        avoids stranding. A pod that exists but is terminating counts as absent — applying over it
        is precisely the race above.
      */
      if (existing !== undefined && existing.state === "running" && existing.podName !== null) {
        const pod = await client.get<{ metadata?: { deletionTimestamp?: string } }>(
          podPath(existing.namespace ?? namespace, existing.podName),
        )

        if (pod !== undefined && pod.metadata?.deletionTimestamp === undefined) {
          await crudSandbox(db).touch(existing.id)
          return c.json(serialize(existing), 201)
        }

        console.info(
          JSON.stringify({
            level: "info",
            message: "sandbox row said running with no pod; recreating",
            sandboxId: existing.id,
            podName: existing.podName,
            terminating: pod !== undefined,
          }),
        )
      }
      const row =
        existing ??
        (await crudSandbox(db).create({
          projectId,
          userId: c.var.user.id,
          state: "starting",
          idleTimeoutS: IDLE_TIMEOUT_S,
          // Stated at creation because the column no longer has a default to inherit. That default
          // was `kata-clh`, and it is why every row claimed a VM boundary no pod here ever had.
          runtimeClass: sandboxRuntimeClass() ?? NO_RUNTIME_CLASS,
        }))

      const podName = `sbx-${row.id.replaceAll("-", "").slice(-16)}`

      const runtimeClass = sandboxRuntimeClass()

      try {
        // Before the pod, every time. The namespace existing is not evidence that its
        // NetworkPolicies are in force — see `ensureTenantNamespace`.
        await ensureTenantNamespace(client, namespace)
        await client.apply(
          podPath(namespace, podName),
          devSandboxPod({
            namespace,
            // Who pays for the pod. Without these the metering agent samples its cgroup, delivers
            // the batch, and attributes it to nobody.
            organizationId: organization.id,
            projectId,
            name: podName,
            image: SANDBOX_IMAGE,
            idleTimeoutSeconds: IDLE_TIMEOUT_S,
            ...(runtimeClass === undefined ? {} : { runtimeClassName: runtimeClass }),
          }),
        )
      } catch (error) {
        /*
          Log first, then record, then rethrow — in that order, and the order is the point.

          This wrote `state: "error"`, which `sandbox_state_check` does not permit. So the update
          threw a constraint violation, that violation propagated instead of `error`, and the only
          thing anywhere in the logs was Postgres complaining about a column value. Whatever had
          actually gone wrong creating the pod — the reason a customer's sandbox would not start —
          was gone. Two failures, and the second one ate the first.

          Logging before touching the database is what makes the cause survive a failure in the
          recording of it.
        */
        console.error(
          JSON.stringify({
            level: "error",
            message: "sandbox pod create failed",
            sandboxId: row.id,
            namespace,
            podName,
            cause: error instanceof Error ? error.message : String(error),
          }),
        )
        await crudSandbox(db).update(row.id, { state: "failed" })
        throw error
      }

      const started = await crudSandbox(db).update(row.id, {
        podName,
        namespace,
        /*
          What the pod was actually given, which is usually nothing.

          The column defaults to `kata-clh` and every row said so, including on a cluster with no
          `kata-clh` RuntimeClass and a pod spec that names none. A row asserting an isolation
          boundary the workload does not have is worse than a null: `runtime_class` is exactly the
          field someone would read to answer whether a customer's code ran in a VM.
        */
        runtimeClass: runtimeClass ?? NO_RUNTIME_CLASS,
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
    requireArray("command", "There is no shell to split a command line."),
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

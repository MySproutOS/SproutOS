import type { AgentEvent } from "@lib/agent"
import { AgentNotConfiguredError, checkout, resolveAgentCredential, runAgentTurn } from "@lib/agent"
import { InsufficientBalanceError } from "@lib/billing"
import {
  crudAgentSession,
  crudAuditLog,
  fetchAgentSession,
  fetchProject,
  fetchRepository,
} from "@lib/dao"
import { createGitHubClient, createInstallationTokenStore, envAppJwtSigner } from "@lib/github"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { streamSSE } from "hono/streaming"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import {
  agentChatSchemaMessageRequest,
  agentChatSchemaSessionCreateRequest,
  agentChatSchemaSessionListResponse,
  agentChatSchemaSessionResponse,
} from "./agent-chat.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/**
 * A turn is bounded so one message cannot become an unattended agent.
 *
 * Chat is interactive: a person is watching, and a run that takes forty turns without saying
 * anything useful has gone wrong rather than gone deep. Scheduled fork upkeep is the place for a
 * long leash, and it is a different entry point.
 */
const MAX_TURNS = 24

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/projects/:projectId/agent/sessions",
    describeRoute({
      description: "Lists a project's agent chat sessions",
      responses: {
        200: {
          description: "Sessions",
          content: {
            "application/json": { schema: resolver(agentChatSchemaSessionListResponse) },
          },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
      },
    }),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const sessions = await fetchAgentSession(db).listForProject(
        c.var.organization.id,
        c.req.param("projectId"),
      )

      return c.json({
        data: sessions.map((session) => ({
          id: session.id,
          title: session.title,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
        })),
      })
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/agent/sessions",
    describeRoute({
      description: "Starts an agent chat session on a project",
      responses: {
        201: {
          description: "Session",
          content: { "application/json": { schema: resolver(agentChatSchemaSessionResponse) } },
        },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        404: { description: "No such project in this organization", ...errorResponse },
      },
    }),
    requirePermission("sandbox:write", paramResource("project", "project", "projectId")),
    validator("json", agentChatSchemaSessionCreateRequest),
    async (c) => {
      const projectId = c.req.param("projectId")
      const organization = c.var.organization

      const project = await fetchProject(db).getInOrganization(organization.id, projectId, ["id"])
      if (project === undefined) return throwNotFound(c, "Project not found")

      const session = await crudAgentSession(db).createSession({
        projectId,
        createdByUserId: c.var.user.id,
        title: c.req.valid("json").title ?? null,
      })

      return c.json(
        {
          id: session.id,
          title: session.title,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
        },
        201,
      )
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/agent/sessions/:sessionId/messages",
    describeRoute({
      /*
        Kept out of the OpenAPI document, and therefore out of the generated client.

        hey-api models a response as one JSON body, so a route that streams events would get a
        client method that resolves on the first chunk and drops the rest — a generated function
        that compiles, runs, and is wrong. Excluding it at the config layer was the obvious move
        and does not work: this version of @hey-api/openapi-ts accepts `input.filters` and ignores
        it, which is worse than not supporting it. Hiding the route at the source is the thing that
        actually holds.

        The chat client reads this with fetch and a stream reader, not EventSource — EventSource
        only issues GET requests, and the prompt has to be a body.
      */
      hide: true,
      description: "Sends a message and streams the agent's response as server-sent events",
      responses: {
        200: { description: "An SSE stream of agent events" },
        402: { description: "Not enough credit to reserve the run", ...errorResponse },
        403: { description: "Caller lacks sandbox:write", ...errorResponse },
        404: { description: "No such session", ...errorResponse },
        409: { description: "No usable model credential", ...errorResponse },
      },
    }),
    requirePermission("sandbox:write", paramResource("project", "project", "projectId")),
    validator("json", agentChatSchemaMessageRequest),
    async (c) => {
      const { projectId, sessionId } = c.req.param()
      const organization = c.var.organization
      const prompt = c.req.valid("json").prompt.trim()
      if (prompt === "") return throwBadRequest(c, "prompt is empty")

      const session = await fetchAgentSession(db).getInOrganization(
        organization.id,
        projectId,
        sessionId,
      )
      if (session === undefined) return throwNotFound(c, "Session not found")

      // Resolved before anything is written, so a project with no credential fails as a plain
      // JSON error rather than as an SSE stream whose first event is a failure — a client cannot
      // show a 409 it has already committed to rendering as a chat response.
      const credential = await resolveAgentCredential(db, organization.id, projectId)
      if (credential.billing === "none") {
        return throwBadRequest(c, `No model credential configured (${credential.reason})`)
      }
      if (credential.billing === "platform") {
        return throwBadRequest(
          c,
          "Credit-billed chat runs on the platform model and does not use the Claude Code agent",
        )
      }

      const repository = await repositoryFor(organization.id, projectId)
      if (typeof repository === "string") return throwBadRequest(c, repository)

      await crudAuditLog(db).record({
        organizationId: organization.id,
        actorUserId: c.var.user.id,
        action: "sandbox:write",
        resourceSrn: srnFor("agent", organization.id, "session", sessionId),
        after: { prompt: prompt.slice(0, 200) },
        ...auditContext(c),
      })

      const sessions = crudAgentSession(db)
      await sessions.titleIfUnset(sessionId, prompt)
      const turn = await sessions.openTurn({
        agentSessionId: sessionId,
        role: "user",
        inputText: prompt,
      })

      return streamSSE(c, async (stream) => {
        // Events accumulate and are flushed in batches. A turn emits hundreds, and a round trip
        // per event would make the database the slowest part of relaying a response the model has
        // already produced.
        const pending: { type: string; payload: unknown; agentTurnId: string }[] = []
        let seq = await sessions.nextEventSeq(sessionId)

        const flush = async () => {
          if (pending.length === 0) return
          const batch = pending.splice(0, pending.length)
          await sessions.appendEvents(sessionId, seq, batch)
          seq += BigInt(batch.length)
        }

        const emit = async (event: AgentEvent) => {
          pending.push({ type: event.type, payload: event, agentTurnId: turn.id })
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
          if (pending.length >= 32) await flush()
        }

        let workspace: Awaited<ReturnType<typeof checkout>> | null = null
        try {
          workspace = await checkout({
            owner: repository.ownerLogin,
            repo: repository.name,
            ref: repository.defaultBranch,
            token: await installationTokenFor(repository.installationId),
          })

          const outcome = await runAgentTurn(
            db,
            {
              organizationId: organization.id,
              projectId,
              sessionId,
              prompt,
              resume: session.sdkSessionId,
              cwd: workspace.path,
              maxTurns: MAX_TURNS,
              // The browser going away should stop the run, not leave it burning tokens against
              // a balance nobody is watching.
              signal: c.req.raw.signal,
            },
            emit,
          )

          if (outcome.sdkSessionId !== null) {
            await sessions.setSdkSessionId(sessionId, outcome.sdkSessionId)
          }
          await sessions.closeTurn(turn.id, {
            resultSubtype: outcome.subtype,
            estimatedCostMicroUsd: outcome.chargedMicroUsd,
            numTurns: outcome.numTurns,
            durationMs: outcome.durationMs,
          })
          await sessions.setStatus(sessionId, outcome.isError ? "failed" : "idle")

          await emit({
            type: "done",
            subtype: outcome.subtype,
            isError: outcome.isError,
            numTurns: outcome.numTurns,
            durationMs: outcome.durationMs,
          })
        } catch (error) {
          const message = describeFailure(error)
          await sessions.closeTurn(turn.id, { error: message, resultSubtype: "error" })
          await sessions.setStatus(sessionId, "failed")
          await emit({ type: "error", message })
        } finally {
          // The checkout holds a copy of the customer's source. It goes away whether the run
          // succeeded, failed, or the client hung up mid-stream.
          await workspace?.dispose()
          await flush()
        }
      })
    },
  )

/**
 * Failures are described, not forwarded.
 *
 * An SDK error can carry a command line, a file path on the runner, or a fragment of a token. The
 * two failures a person can act on are named; everything else is generic, and the detail stays in
 * the server's logs.
 */
function describeFailure(error: unknown): string {
  if (error instanceof InsufficientBalanceError) {
    return "Not enough credit to run this. Add credit and try again."
  }
  if (error instanceof AgentNotConfiguredError) {
    return "No model credential is configured for this project."
  }
  console.warn("agent turn failed", error)
  return "The agent run failed."
}

/**
 * The repository the agent will work in, or a sentence saying what is missing.
 *
 * Three different things can be absent here and they need different answers from the person
 * reading them. Collapsing them into one "no repository" is what this function used to do, and it
 * sent me looking at the project's repository row when the actual gap was an uninstalled GitHub
 * App — a message that is not merely unhelpful but points the wrong way.
 */
async function repositoryFor(
  organizationId: string,
  projectId: string,
): Promise<
  { ownerLogin: string; name: string; defaultBranch: string; installationId: number } | string
> {
  const project = await fetchProject(db).getInOrganization(organizationId, projectId, [
    "repositoryId",
  ])
  if (project === undefined) return "Project not found"

  const repository = await fetchRepository(db).getInOrganization(
    organizationId,
    project.repositoryId,
    ["ownerLogin", "name", "defaultBranch"],
  )
  if (repository === undefined) return "This project's repository record is missing"

  const installation = await db
    .selectFrom("githubInstallation")
    .select("installationId")
    .where("organizationId", "=", organizationId)
    .where("suspendedAt", "is", null)
    .executeTakeFirst()

  if (installation === undefined) {
    return "Install the SproutOS GitHub App on this organization so the agent can read the repository"
  }

  return { ...repository, installationId: Number(installation.installationId) }
}

/**
 * Built lazily: `envAppJwtSigner()` reads GITHUB_APP_PRIVATE_KEY, and dotenv has not run when this
 * module is first evaluated. Constructing it at import time turns a missing key into a crash at
 * startup for every route in the app, rather than an error on the one request that needs it.
 */
let tokenStore: ReturnType<typeof createInstallationTokenStore> | null = null

async function installationTokenFor(installationId: number): Promise<string> {
  tokenStore ??= createInstallationTokenStore({
    client: createGitHubClient(),
    signJwt: envAppJwtSigner(),
  })
  const token = await tokenStore.get(installationId)
  return token.token
}

export default app

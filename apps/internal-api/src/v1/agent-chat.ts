import type { AgentEvent } from "@lib/agent"
import {
  harnessFor,
  mintProxyToken,
  runSandboxTurn,
  upstreamKindFor,
  AgentNotConfiguredError,
  checkout,
  commitAndPush,
  commitSandboxWork,
  installSproutosSkill,
  type PlatformMessage,
  resolveAgentCredential,
  runAgentTurn,
  runPlatformChat,
} from "@lib/agent"
import { InsufficientBalanceError } from "@lib/billing"
import {
  crudSandbox,
  crudAgentProxyToken,
  fetchSandbox,
  sandboxScopeFor,
  crudAgentSession,
  crudAuditLog,
  fetchAgentSession,
  fetchGithubInstallation,
  fetchProject,
  fetchRepository,
} from "@lib/dao"
import {
  createGitHubClient,
  createInstallationTokenStore,
  envAppJwtSigner,
  type GitHubCredential,
  userGitHubCredential,
} from "@lib/github"
import { srnFor } from "@lib/srn"
import { daytonaClientFromEnv } from "@lib/sandbox"
import { sealForProxy } from "@lib/proxy-secret"
import { db } from "@sproutos/db"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
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
  agentChatSchemaTranscriptResponse,
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
/**
 * How long a sandbox turn may run.
 *
 * Longer than a control-plane turn because the agent can actually do things here — an install and a
 * test suite is minutes before the model has said anything. Bounded all the same: an agent that has
 * stopped making progress should end, and the sandbox's own idle reaper cannot tell the difference
 * between thinking and hanging.
 */
const SANDBOX_TURN_TIMEOUT_MS = 30 * 60 * 1000

type SandboxTerminalEvent = Extract<AgentEvent, { type: "done" }>

export function sandboxEventRelay(emit: (event: AgentEvent) => Promise<void>) {
  let delivery = Promise.resolve()
  let terminal: SandboxTerminalEvent | undefined

  return {
    onEvent(event: AgentEvent): void {
      if (event.type === "done") {
        terminal ??= event
        return
      }
      delivery = delivery.then(() => emit(event))
    },
    async drain(): Promise<void> {
      await delivery
    },
    terminal(exitCode: number): SandboxTerminalEvent {
      const result =
        terminal ??
        ({
          type: "done",
          subtype: exitCode === 0 ? "success" : "error",
          isError: exitCode !== 0,
          numTurns: 1,
          durationMs: 0,
        } satisfies SandboxTerminalEvent)
      return exitCode === 0 ? result : { ...result, subtype: "error", isError: true }
    },
  }
}

/**
 * The sandbox this project's group has running, if any.
 *
 * Group-scoped, like every other sandbox lookup: a child's turn belongs in the checkout its code
 * actually lives in. `running` rather than merely present — a stopped container accepts nothing and
 * a turn routed into one hangs until the timeout.
 */
async function runningSandbox(organizationId: string, projectId: string, userId: string) {
  const scope = await sandboxScopeFor(db, organizationId, projectId)
  if (scope === undefined) return undefined
  const row = await fetchSandbox(db).forUser(organizationId, scope, userId)
  return row?.state === "running" ? row : undefined
}

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
  .get(
    "/:orgSlug/projects/:projectId/agent/sessions/:sessionId",
    describeRoute({
      description: "Reads an agent chat transcript and its persisted activity events",
      responses: {
        200: {
          description: "Transcript",
          content: { "application/json": { schema: resolver(agentChatSchemaTranscriptResponse) } },
        },
        403: { description: "Caller lacks project:read", ...errorResponse },
        404: { description: "No such session", ...errorResponse },
      },
    }),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const { projectId, sessionId } = c.req.param()
      const session = await fetchAgentSession(db).getInOrganization(
        c.var.organization.id,
        projectId,
        sessionId,
      )
      if (session === undefined) return throwNotFound(c, "Session not found")

      const [turns, events] = await Promise.all([
        fetchAgentSession(db).listTurns(sessionId),
        fetchAgentSession(db).listEvents(sessionId, null),
      ])
      return c.json({
        session: {
          id: session.id,
          title: session.title,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          updatedAt: session.updatedAt.toISOString(),
        },
        turns: turns.map((turn) => ({
          id: turn.id,
          role: turn.role,
          inputText: turn.inputText,
          error: turn.error,
          seq: turn.seq,
          createdAt: turn.createdAt.toISOString(),
        })),
        events: events.map((event) => ({
          ...event,
          payload: typeof event.payload === "object" && event.payload !== null ? event.payload : {},
          createdAt: event.createdAt.toISOString(),
        })),
      })
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
      /*
        Two credential sources, one coding environment.

        A configured customer credential is passed through the LLM proxy and billed by their
        provider. Platform credit selects the platform OpenAI credential at the proxy. Once a
        Daytona sandbox is running both execute the coding harness there, because shell access,
        previews and repository edits are the product — the read-only API-process assistant below
        remains only a compatibility fallback for direct clients that did not start a sandbox.
      */
      const onPlatformCredit = credential.billing === "platform"

      const repository = onPlatformCredit
        ? null
        : await repositoryFor(organization.id, projectId, c.var.user.id, "agent-clone")
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
      await sessions.setStatus(sessionId, "active")

      return streamSSE(c, async (stream) => {
        // Events accumulate and are flushed in batches. A turn emits hundreds, and a round trip
        // per event would make the database the slowest part of relaying a response the model has
        // already produced.
        const pending: { type: string; payload: unknown; agentTurnId: string }[] = []
        const flush = async () => {
          if (pending.length === 0) return
          const batch = pending.splice(0, pending.length)
          await sessions.appendEvents(sessionId, batch)
        }

        const emit = async (event: AgentEvent) => {
          pending.push({ type: event.type, payload: event, agentTurnId: turn.id })
          await stream
            .writeSSE({ event: event.type, data: JSON.stringify(event) })
            .catch(() => undefined)
          if (pending.length >= 32) await flush()
        }

        let workspace: Awaited<ReturnType<typeof checkout>> | null = null
        let turnProxyTokenId: string | null = null
        try {
          const sandbox = await runningSandbox(organization.id, projectId, c.var.user.id)
          if (sandbox === undefined && onPlatformCredit) {
            const history = await priorMessages(sessionId)
            const outcome = await runPlatformChat(
              db,
              {
                organizationId: organization.id,
                projectId,
                sessionId,
                messages: [...history, { role: "user", content: prompt }],
                signal: undefined,
              },
              emit,
            )

            await sessions.closeTurn(turn.id, {
              resultSubtype: outcome.finishReason,
              estimatedCostMicroUsd: outcome.chargedMicroUsd,
              numTurns: 1,
            })
            await sessions.setStatus(sessionId, "idle")
            await emit({
              type: "done",
              subtype: outcome.finishReason,
              isError: false,
              numTurns: 1,
              durationMs: 0,
            })
            await flush()
            return
          }

          /*
            The sandbox, when there is one.

            This is the path the product is supposed to have: the agent runs on a machine of its
            own, where a shell is just a shell, so it can install, test and start a dev server —
            and the preview then has something to show. The control-plane checkout below is the
            fallback for a customer with no sandbox running, and it is strictly weaker: `tools.ts`
            refuses `Bash` there because the subprocess shares a uid with this API.

            Chosen by whether a sandbox is *running*, not by whether one exists. A `stopped` row is
            the ordinary state of a sandbox somebody used yesterday, and routing a turn into a
            stopped container would hang until the timeout.
          */
          if (sandbox !== undefined && sandbox.externalId !== null) {
            const relay = sandboxEventRelay(emit)
            const proxy = await mintProxyToken(db, {
              actorUserId: c.var.user.id,
              agentCredentialId: credential.billing === "byo" ? credential.credentialId : null,
              agentSessionId: sessionId,
              agentTurnId: turn.id,
              organizationId: organization.id,
              projectId,
              upstreamBaseUrl: credential.billing === "byo" ? credential.baseUrl : null,
              upstreamKind: credential.billing === "byo" ? upstreamKindFor(credential.kind) : null,
              upstreamSecret: credential.billing === "byo" ? sealForProxy(credential.secret) : null,
            })
            turnProxyTokenId = proxy.id

            const scopedProject = await fetchProject(db).getInOrganization(
              organization.id,
              projectId,
              ["id", "isGroup", "parentProjectId", "slug"],
            )
            if (scopedProject === undefined) throw new Error("the scoped project disappeared")
            const groupProjectId = scopedProject.isGroup
              ? scopedProject.id
              : scopedProject.parentProjectId
            const groupPrimaryCandidates =
              groupProjectId === null
                ? []
                : await fetchProject(db).listChildren(organization.id, groupProjectId, [
                    "name",
                    "rootDir",
                    "slug",
                  ])

            const { exitCode } = await runSandboxTurn({
              actionUrl: `${process.env.NEXT_PUBLIC_API_URL ?? "https://api.sproutos.me"}/v1/orgs/${encodeURIComponent(c.req.param("orgSlug"))}/projects/${encodeURIComponent(projectId)}/agent/actions/group-primary`,
              driver: daytonaClientFromEnv(),
              externalId: sandbox.externalId,
              harness: credential.billing === "byo" ? harnessFor(credential.kind) : "codex",
              model: credential.model,
              groupPrimaryCandidates,
              onEvent: (event) => {
                relay.onEvent(event)
              },
              prompt,
              proxyBaseUrl: process.env.LLM_PROXY_URL ?? "https://llm.sproutos.me",
              projectSlug: scopedProject.slug,
              refreshUrl: `${process.env.NEXT_PUBLIC_API_URL ?? "https://api.sproutos.me"}/v1/orgs/${c.req.param("orgSlug")}/agent/proxy-token/refresh`,
              timeoutMs: SANDBOX_TURN_TIMEOUT_MS,
              token: proxy,
              // Or the reaper stops the sandbox out from under a turn that is still working.
              touch: () => crudSandbox(db).touch(sandbox.id),
            })
            await relay.drain()
            const terminal = relay.terminal(exitCode)

            /*
              The agent's work leaves the sandbox, or it lives only until the reaper.

              A branch, never the production branch: the platform holds a credential that can write,
              and using it to push straight to `main` would make every agent turn an unreviewed
              commit on a customer's repository. The same rule the control-plane path follows below.

              The repository credential is resolved here rather than reused from above, because on
              platform credit `repository` is deliberately null — that path needs no checkout. A
              sandbox has one regardless: it was cloned at provision.

              Never fatal. A turn that produced good work and then failed to push must report the
              push, not discard the answer the customer already watched being written.
            */
            if (exitCode === 0 && !terminal.isError) {
              try {
                const target = await repositoryFor(
                  organization.id,
                  projectId,
                  c.var.user.id,
                  "sandbox-push",
                )
                if (typeof target === "string") throw new Error(target)

                const pushed = await commitSandboxWork({
                  author: {
                    email: c.var.user.email ?? "agent@users.noreply.github.com",
                    name: c.var.user.name ?? "SproutOS Agent",
                  },
                  branch: `sproutos/agent-${sessionId.slice(-12)}`,
                  baseBranch: target.defaultBranch,
                  driver: daytonaClientFromEnv(),
                  externalId: sandbox.externalId,
                  message: `${prompt.split("\n")[0]?.slice(0, 72) ?? "Agent changes"}\n\nWritten by the SproutOS agent in a sandbox.`,
                  repository: `${target.ownerLogin}/${target.name}`,
                  token: target.credential.token,
                })

                if (pushed.committed) {
                  await emit({
                    type: "committed",
                    branch: pushed.branch,
                    sha: pushed.sha,
                    files: pushed.files,
                  })
                }
              } catch (cause) {
                await emit({
                  type: "commit_failed",
                  message: cause instanceof Error ? cause.message : "the push failed",
                })
              }
            }

            await sessions.closeTurn(turn.id, {
              resultSubtype: terminal.subtype,
              numTurns: terminal.numTurns,
              durationMs: terminal.durationMs,
            })
            await sessions.setStatus(sessionId, terminal.isError ? "failed" : "idle")
            await emit(terminal)
            await flush()
            return
          }

          if (repository === null) return

          workspace = await checkout({
            owner: repository.ownerLogin,
            repo: repository.name,
            ref: repository.defaultBranch,
            token: repository.credential.token,
          })

          /*
            What SproutOS is, written where the SDK will look for it.

            `runAgentTurn` reads project settings out of the checkout, so this is available to the
            model without spending a system prompt on it — and only read when the task turns out to
            be about deployment. It is excluded from git inside `installSproutosSkill`, because the
            commit step below stages everything and nobody asked us to put our scaffolding in their
            repository.
          */
          await installSproutosSkill({
            workspace,
            apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "https://api.sproutos.me",
            tenantDomain: process.env.TENANT_DOMAIN ?? "sproutos.run",
            projectSlug: repository.projectSlug,
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
              signal: undefined,
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

          /*
            The agent's edits leave the checkout, or they are lost.

            The workspace is deleted in the `finally` below, so anything the model wrote has minutes
            to live. It goes out on a branch rather than the production branch: the platform holds a
            credential that can write, and using it to push straight to `main` on a customer's
            repository would make every agent turn an unreviewed commit.

            Not fatal. A turn that produced good work and then failed to push should report the push
            failure, not discard the answer the customer already watched being written.
          */
          if (!outcome.isError) {
            try {
              const writeTarget = await repositoryFor(
                organization.id,
                projectId,
                c.var.user.id,
                "agent-push",
              )
              if (typeof writeTarget === "string") throw new Error(writeTarget)
              const pushed = await commitAndPush({
                workspace,
                owner: writeTarget.ownerLogin,
                repo: writeTarget.name,
                token: writeTarget.credential.token,
                branch: `sproutos/agent-${sessionId.slice(-12)}`,
                message: `${prompt.split("\n")[0]?.slice(0, 72) ?? "Agent changes"}\n\nWritten by the SproutOS agent.`,
              })

              if (pushed.committed) {
                await emit({
                  type: "committed",
                  branch: pushed.branch,
                  sha: pushed.sha,
                  files: pushed.files,
                })
              }
            } catch (cause) {
              await emit({
                type: "commit_failed",
                message: cause instanceof Error ? cause.message : "the push failed",
              })
            }
          }

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
          try {
            // A detached process can survive the harness command inside the persistent sandbox.
            // The bearer belongs to this turn, so finishing or failing the turn withdraws it
            // immediately instead of leaving a 35-minute control-plane credential behind.
            if (turnProxyTokenId !== null) {
              await crudAgentProxyToken(db).revoke(turnProxyTokenId)
            }
          } finally {
            // Cleanup and transcript persistence still run if the database refuses the revocation;
            // the action route independently rejects a turn as soon as closeTurn stamps it done.
            await workspace?.dispose()
            await flush()
          }
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
  /*
    An incident id, logged beside the error and returned to the caller.

    The message above stays deliberately opaque — an SDK error can carry a command line, a path on
    the runner, or a fragment of a token — and that is the right call. What it cost was any way to
    connect "the agent run failed" to the log line that says why: the first real failure here was
    `spawn git ENOENT`, and finding it meant reading pod logs and guessing which request was the
    user's.

    A random id is not a secret and identifies nothing. It is the whole difference between a support
    conversation that takes one grep and one that takes an afternoon.
  */
  const incidentId = randomUUID().slice(0, 8)
  console.warn(`agent turn failed [${incidentId}]`, error)
  return `The agent run failed. Reference ${incidentId} if you report this.`
}

/**
 * The repository the agent will work in, or a sentence saying what is missing.
 *
 * Three different things can be absent here and they need different answers from the person
 * reading them. Collapsing them into one "no repository" is what this function used to do, and it
 * sent me looking at the project's repository row when the actual gap was an uninstalled GitHub
 * App — a message that is not merely unhelpful but points the wrong way.
 */
/**
 * Rebuild the conversation for a stateless runner.
 *
 * The Claude Code agent resumes by session id and keeps its own history; a chat completion has no
 * memory at all, so every turn has to carry the whole exchange back up. Read from `agent_turn`
 * (the prompts) and `agent_event` (the replies) rather than kept in memory, because the process
 * that served turn one is not necessarily the one serving turn two.
 */
async function priorMessages(sessionId: string): Promise<PlatformMessage[]> {
  const turns = await db
    .selectFrom("agentTurn")
    .select(["id", "seq", "inputText"])
    .where("agentSessionId", "=", sessionId)
    .orderBy("seq", "asc")
    .execute()

  const replies = await db
    .selectFrom("agentEvent")
    .select(["agentTurnId", "payload"])
    .where("agentSessionId", "=", sessionId)
    .where("type", "=", "text")
    .orderBy("seq", "asc")
    .execute()

  const textByTurn = new Map<string, string>()
  for (const reply of replies) {
    if (reply.agentTurnId === null) continue
    const text = (reply.payload as { text?: string }).text ?? ""
    textByTurn.set(reply.agentTurnId, (textByTurn.get(reply.agentTurnId) ?? "") + text)
  }

  const messages: PlatformMessage[] = []
  for (const turn of turns) {
    // The turn being served right now has its prompt written but no reply yet; the caller appends
    // it, so including it here would send it twice.
    const answer = textByTurn.get(turn.id)
    if (answer === undefined) continue
    if (turn.inputText !== null) messages.push({ role: "user", content: turn.inputText })
    messages.push({ role: "assistant", content: answer })
  }

  // Bounded: a long conversation replayed in full is a bill that grows quadratically with the
  // number of turns, since every turn resends every earlier one.
  return messages.slice(-20)
}

/**
 * The repository the agent will check out, and a credential that can clone it.
 *
 * The App installation first — ADR 0005 — because an installation token is scoped to what the
 * customer granted, carries its own rate-limit budget, and does not depend on anyone being signed
 * in. Then the caller's own OAuth token, which is a real credential for a repository that is
 * theirs, issued to them, for work they are asking for right now.
 *
 * Without that fallback this returned "Install the SproutOS GitHub App on this organization" to a
 * user who had just signed in with `repo` scope and forked the very repository in question with
 * that same token. The App is better; its absence is not a reason to refuse.
 */
async function repositoryFor(
  organizationId: string,
  projectId: string,
  userId: string,
  purpose: "agent-clone" | "agent-push" | "sandbox-push",
): Promise<
  | {
      ownerLogin: string
      name: string
      defaultBranch: string
      /** Carried so the injected skill can name this project in its workflow snippet. */
      projectSlug: string
      credential: GitHubCredential
    }
  | string
> {
  const project = await fetchProject(db).getInOrganization(organizationId, projectId, [
    "repositoryId",
    "slug",
  ])
  if (project === undefined) return "Project not found"

  const repository = await fetchRepository(db).getInOrganization(
    organizationId,
    project.repositoryId,
    ["ownerLogin", "name", "defaultBranch", "githubRepoId"],
  )
  if (repository === undefined) return "This project's repository record is missing"

  const installation = await fetchGithubInstallation(db).getForRepository(
    organizationId,
    project.repositoryId,
    ["installationId"],
  )

  if (installation !== undefined) {
    const installationId = Number(installation.installationId)
    return {
      ...repository,
      projectSlug: project.slug,
      credential: {
        kind: "installation",
        installationId,
        // The store hands back the expiry too. Carried rather than dropped: an installation token
        // lasts an hour, and a caller that holds one across a long agent turn needs to know.
        ...(await installationTokenFor(installationId, purpose, Number(repository.githubRepoId))),
      },
    }
  }

  const user = await userGitHubCredential(db, userId)
  if (user !== undefined) return { ...repository, projectSlug: project.slug, credential: user }

  return (
    "The agent cannot read this repository. Install the SproutOS GitHub App on this organization, " +
    "or sign in again through /login/github?scopes=repository to grant repository access."
  )
}

/**
 * Built lazily: `envAppJwtSigner()` reads GITHUB_APP_PRIVATE_KEY, and dotenv has not run when this
 * module is first evaluated. Constructing it at import time turns a missing key into a crash at
 * startup for every route in the app, rather than an error on the one request that needs it.
 */
let tokenStore: ReturnType<typeof createInstallationTokenStore> | null = null

async function installationTokenFor(
  installationId: number,
  purpose: "agent-clone" | "agent-push" | "sandbox-push",
  repositoryId: number,
): Promise<{ token: string; expiresAt: Date }> {
  tokenStore ??= createInstallationTokenStore({
    client: createGitHubClient(),
    signJwt: envAppJwtSigner(),
  })
  const token = await tokenStore.get(installationId, { purpose, repositoryId })
  return { token: token.token, expiresAt: token.expiresAt }
}

export default app

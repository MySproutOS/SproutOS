import { resolveProxyAccessToken, type AgentEvent } from "@lib/agent"
import {
  appendAgentEventsInTransaction,
  crudAuditLog,
  crudProject,
  fetchAgentSession,
  fetchOrganization,
  fetchOrganizationMember,
  fetchProject,
  fetchUser,
} from "@lib/dao"
import { srnFor } from "@lib/srn"
import { enqueue, JOB_KINDS } from "@lib/jobs"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { readBearerToken } from "../bearer"
import { hasPermission } from "../rbac"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import {
  throwBadRequest,
  throwForbidden,
  throwNotFound,
  throwUnauthenticated,
} from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  agentActionSchemaParam,
  agentActionSchemaSetGroupPrimaryRequest,
  agentActionSchemaSetGroupPrimaryResponse,
  agentActionSchemaUpdateUpstreamResponse,
} from "./agent-actions.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

function invalidToken(c: Parameters<typeof throwUnauthenticated>[0]) {
  c.header("WWW-Authenticate", 'Bearer error="invalid_token"')
  return throwUnauthenticated(c, "The agent token is not valid")
}

/**
 * The sandbox agent's deliberately narrow control-plane surface.
 *
 * This route does not accept a browser session or a customer API key. Its bearer is the same
 * short-lived, revocable `spa_…` token already present for model proxying, and only tokens minted
 * inside an identified chat turn carry the actor metadata required below. The user's live RBAC is
 * checked again at execution time, so removing a role stops an already-running sandbox.
 */
const app = new Hono()
  .post(
    "/:orgSlug/projects/:projectId/agent/actions/group-primary",
    describeRoute({
      description: "Sets a direct child as its group's primary project from a scoped agent turn",
      responses: {
        200: {
          description: "The group primary project and its currently active domain",
          content: {
            "application/json": {
              schema: resolver(agentActionSchemaSetGroupPrimaryResponse),
            },
          },
        },
        400: {
          description: "The scoped project or nominee is not a valid group child",
          ...errorResponse,
        },
        401: { description: "The short-lived agent token is absent or invalid", ...errorResponse },
        403: {
          description: "The person who started the turn lacks project:update",
          ...errorResponse,
        },
        404: {
          description: "The token does not belong to this organization and project",
          ...errorResponse,
        },
      },
    }),
    validator("param", agentActionSchemaParam),
    validator("json", agentActionSchemaSetGroupPrimaryRequest),
    async (c) => {
      const bearer = readBearerToken(c.req.header("authorization"))
      if (bearer === null) return invalidToken(c)

      const token = await resolveProxyAccessToken(db, bearer)
      if (
        token === undefined ||
        token.actorUserId === null ||
        token.agentSessionId === null ||
        token.agentTurnId === null ||
        token.projectId === null
      ) {
        return invalidToken(c)
      }
      const actorUserId = token.actorUserId
      const agentSessionId = token.agentSessionId
      const agentTurnId = token.agentTurnId

      const { orgSlug, projectId } = c.req.valid("param")
      const organization = await fetchOrganization(db).getBySlug(orgSlug, [
        "id",
        "slug",
        "name",
        "kind",
        "ownerUserId",
      ])
      if (
        organization === undefined ||
        organization.id !== token.organizationId ||
        projectId !== token.projectId
      ) {
        return throwNotFound(c, "Agent action scope not found")
      }

      const [user, membership, session, turn] = await Promise.all([
        fetchUser(db).getOne(actorUserId, ["id", "deletedAt"]),
        fetchOrganizationMember(db).getForUser(organization.id, actorUserId),
        fetchAgentSession(db).getInOrganization(organization.id, projectId, agentSessionId),
        fetchAgentSession(db).getTurnInSession(agentSessionId, agentTurnId),
      ])
      if (user === undefined || user.deletedAt !== null) return invalidToken(c)
      if (membership === undefined || membership.status !== "active") {
        return throwNotFound(c, "Agent action scope not found")
      }
      if (session === undefined || turn === undefined || turn.resultSubtype !== null) {
        return invalidToken(c)
      }

      const scopedProject = await fetchProject(db).getInOrganization(organization.id, projectId, [
        "id",
        "isGroup",
        "name",
        "parentProjectId",
        "primaryChildProjectId",
        "slug",
      ])
      if (scopedProject === undefined) return throwNotFound(c, "Project not found")

      const primaryProject = await fetchProject(db).getBySlug(
        organization.id,
        c.req.valid("json").primaryProjectSlug,
        ["id", "isGroup", "name", "parentProjectId", "slug"],
      )

      const groupProjectId = scopedProject.isGroup
        ? scopedProject.id
        : scopedProject.parentProjectId
      if (groupProjectId === null) {
        return throwBadRequest(c, "A standalone project has no group primary to set")
      }
      if (
        primaryProject === undefined ||
        primaryProject.isGroup ||
        primaryProject.parentProjectId !== groupProjectId ||
        (!scopedProject.isGroup && primaryProject.id !== scopedProject.id)
      ) {
        return throwBadRequest(
          c,
          "The primary project must be a deployable child in this agent's group",
          ErrorCode.ValidationFailed,
          { target: "primaryProjectSlug" },
        )
      }

      if (
        !(await hasPermission(actorUserId, organization, "project:update", {
          service: "project",
          type: "project",
          id: groupProjectId,
        }))
      ) {
        return throwForbidden(c, "Forbidden", ErrorCode.InsufficientPermissions)
      }

      const group = await fetchProject(db).getInOrganization(organization.id, groupProjectId, [
        "id",
        "isGroup",
        "name",
        "primaryChildProjectId",
      ])
      if (group === undefined || !group.isGroup) {
        return throwBadRequest(c, "The scoped group is no longer available")
      }

      const destination = await fetchProject(db).primaryDestination(
        organization.id,
        primaryProject.id,
      )
      const event = {
        type: "platform_action",
        action: "set_group_primary_project",
        message: `Set ${primaryProject.name} as the primary project for ${group.name}`,
        groupProjectId: group.id,
        primaryProjectId: primaryProject.id,
        primaryHostname: destination.hostname,
        primaryUrl: destination.url,
      } satisfies AgentEvent

      const updated = await db.transaction().execute(async (tx) => {
        const row = await crudProject(tx).setPrimaryChild(
          organization.id,
          group.id,
          primaryProject.id,
        )
        if (row === undefined) return undefined

        await crudAuditLog(tx).record({
          action: "project:update",
          actorUserId,
          after: {
            agentProxyTokenId: token.id,
            agentSessionId,
            agentTurnId,
            primaryChildProjectId: primaryProject.id,
            primaryHostname: destination.hostname,
            primaryProjectName: primaryProject.name,
            source: "agent",
          },
          before: { primaryChildProjectId: group.primaryChildProjectId },
          organizationId: organization.id,
          resourceSrn: srnFor("project", organization.id, "project", group.id),
          ...auditContext(c),
        })
        await appendAgentEventsInTransaction(tx, agentSessionId, [
          { type: event.type, payload: event, agentTurnId },
        ])
        return row
      })
      if (updated === undefined) {
        return throwBadRequest(c, "The nominated project is no longer a child of this group")
      }

      return c.json({
        action: event.action,
        groupProjectId: group.id,
        groupName: group.name,
        primaryProjectId: primaryProject.id,
        primaryProjectName: primaryProject.name,
        primaryHostname: destination.hostname,
        primaryUrl: destination.url,
      })
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/agent/actions/update-upstream",
    describeRoute({
      description: "Queues this project's trusted upstream update flow from a scoped agent turn",
      responses: {
        202: {
          description: "The upstream comparison and PR-gated update were queued",
          content: {
            "application/json": { schema: resolver(agentActionSchemaUpdateUpstreamResponse) },
          },
        },
        400: { description: "The project has no recorded upstream", ...errorResponse },
        401: { description: "The short-lived agent token is absent or invalid", ...errorResponse },
        403: {
          description: "The person who started the turn lacks project:update",
          ...errorResponse,
        },
        404: { description: "The token does not belong to this project", ...errorResponse },
      },
    }),
    validator("param", agentActionSchemaParam),
    async (c) => {
      const bearer = readBearerToken(c.req.header("authorization"))
      if (bearer === null) return invalidToken(c)
      const token = await resolveProxyAccessToken(db, bearer)
      if (
        token === undefined ||
        token.actorUserId === null ||
        token.agentSessionId === null ||
        token.agentTurnId === null ||
        token.projectId === null
      )
        return invalidToken(c)

      const { orgSlug, projectId } = c.req.valid("param")
      const organization = await fetchOrganization(db).getBySlug(orgSlug, [
        "id",
        "slug",
        "name",
        "kind",
        "ownerUserId",
      ])
      if (
        organization === undefined ||
        organization.id !== token.organizationId ||
        projectId !== token.projectId
      ) {
        return throwNotFound(c, "Agent action scope not found")
      }
      const [user, membership, session, turn] = await Promise.all([
        fetchUser(db).getOne(token.actorUserId, ["id", "deletedAt"]),
        fetchOrganizationMember(db).getForUser(organization.id, token.actorUserId),
        fetchAgentSession(db).getInOrganization(organization.id, projectId, token.agentSessionId),
        fetchAgentSession(db).getTurnInSession(token.agentSessionId, token.agentTurnId),
      ])
      if (user === undefined || user.deletedAt !== null) return invalidToken(c)
      if (membership === undefined || membership.status !== "active")
        return throwNotFound(c, "Agent action scope not found")
      if (session === undefined || turn === undefined || turn.resultSubtype !== null)
        return invalidToken(c)
      if (
        !(await hasPermission(token.actorUserId, organization, "project:update", {
          service: "project",
          type: "project",
          id: projectId,
        }))
      )
        return throwForbidden(c, "Forbidden", ErrorCode.InsufficientPermissions)

      const project = await db
        .selectFrom("project")
        .innerJoin("repository", "repository.id", "project.repositoryId")
        .select(["project.repositoryId", "repository.upstreamFullName"])
        .where("project.id", "=", projectId)
        .where("project.organizationId", "=", organization.id)
        .where("project.deletedAt", "is", null)
        .executeTakeFirst()
      if (project === undefined) return throwNotFound(c, "Project not found")
      if (project.upstreamFullName === null)
        return throwBadRequest(c, "This project has no recorded upstream repository")

      const jobId = await enqueue(db, {
        kind: JOB_KINDS.upkeepRepository,
        organizationId: organization.id,
        payload: {
          repositoryId: project.repositoryId,
          requestedProjectId: projectId,
          requestedByUserId: token.actorUserId,
        },
        idempotencyKey: `${JOB_KINDS.upkeepRepository}:agent:${token.agentTurnId}`,
        maxAttempts: 5,
      })
      await crudAuditLog(db).record({
        action: "project:update",
        actorUserId: token.actorUserId,
        after: { source: "agent", jobId, upstreamFullName: project.upstreamFullName },
        before: null,
        organizationId: organization.id,
        resourceSrn: srnFor("project", organization.id, "project", projectId),
        ...auditContext(c),
      })
      return c.json(
        {
          action: "update_from_upstream" as const,
          jobId,
          upstreamFullName: project.upstreamFullName,
        },
        202,
      )
    },
  )

export default app

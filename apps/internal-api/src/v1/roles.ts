import {
  crudAuditLog,
  crudMemberPermission,
  crudRole,
  fetchRole,
  type StatementInput,
  SYSTEM_ROLE_NAMES,
} from "@lib/dao"
import { srnFor, tryParseSrn, WILDCARD } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { authMiddleware } from "../middleware"
import { ACTIONS, isGrantableAction, paramResource, requirePermission } from "../rbac"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest, throwError, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import {
  roleIdParam,
  roleSchemaActionsResponse,
  roleSchemaCreateRequest,
  roleSchemaCreateResponse,
  roleSchemaListResponse,
  roleSchemaUpdateRequest,
  roleSlugParam,
} from "./roles.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

type StatementDraft = {
  effect: "allow" | "deny"
  actions: string[]
  resources: string[]
}

/**
 * Validates customer-authored statements before they are persisted.
 *
 * Two things are checked that the schema cannot. Actions must exist in the ADR 0016 catalogue —
 * a typo would otherwise be stored, match nothing, and read as a working grant in the roles UI.
 * Resources must be SRNs scoped to *this* organization: `member_permission.organization_id` is
 * what actually confines a grant, so a foreign organization segment is inert today, and storing
 * one would be a trap for the first query that stops filtering on it.
 */
function validateStatements(
  statements: readonly StatementDraft[],
  organizationId: string,
): { ok: true; statements: StatementInput[] } | { ok: false; target: string; message: string } {
  const validated: StatementInput[] = []

  for (const statement of statements) {
    for (const action of statement.actions) {
      if (!isGrantableAction(action)) {
        return {
          ok: false,
          target: "statements.actions",
          message: `\`${action}\` is not an action in the catalogue`,
        }
      }
    }

    for (const resource of statement.resources) {
      const parsed = tryParseSrn(resource)
      if (parsed === null) {
        return {
          ok: false,
          target: "statements.resources",
          message: `\`${resource}\` is not a valid SRN`,
        }
      }
      if (parsed.organizationId !== organizationId && parsed.organizationId !== WILDCARD) {
        return {
          ok: false,
          target: "statements.resources",
          message: "Resources must be scoped to this organization",
        }
      }
    }

    validated.push({
      effect: statement.effect,
      actions: [...statement.actions],
      resources: [...statement.resources],
    })
  }

  return { ok: true, statements: validated }
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/roles",
    describeRoute({
      description: "Lists the organization's roles and their statements",
      responses: {
        200: {
          description: "Roles in the organization",
          content: { "application/json": { schema: resolver(roleSchemaListResponse) } },
        },
        403: { description: "Caller lacks role:read", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("param", roleSlugParam),
    requirePermission("role:read", { service: "org", type: "role", id: "*" }),
    async (c) => {
      const organization = c.var.organization

      const roles = await fetchRole(db).listQuery(organization.id).execute()
      const statements = await fetchRole(db).listStatements(roles.map((role) => role.id))

      const byRole = new Map<string, typeof statements>()
      for (const statement of statements) {
        const bucket = byRole.get(statement.roleId) ?? []
        bucket.push(statement)
        byRole.set(statement.roleId, bucket)
      }

      return c.json({
        data: roles.map((role) => ({
          id: role.id,
          name: role.name,
          description: role.description,
          isSystem: role.isSystem,
          statements: (byRole.get(role.id) ?? []).map((statement) => ({
            id: statement.id,
            effect: statement.effect,
            actions: statement.actions,
            resources: statement.resources,
          })),
          createdAt: role.createdAt.toISOString(),
        })),
      })
    },
  )
  .get(
    "/:orgSlug/roles/actions",
    describeRoute({
      description: "The action catalogue a role statement may draw from",
      responses: {
        200: {
          description: "Every action in the catalogue",
          content: { "application/json": { schema: resolver(roleSchemaActionsResponse) } },
        },
        403: { description: "Caller lacks role:read", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("param", roleSlugParam),
    requirePermission("role:read", { service: "org", type: "role", id: "*" }),
    (c) => c.json({ data: [...ACTIONS] }),
  )
  .post(
    "/:orgSlug/roles",
    describeRoute({
      description: "Creates a custom role",
      responses: {
        201: {
          description: "Role created",
          content: { "application/json": { schema: resolver(roleSchemaCreateResponse) } },
        },
        400: {
          description: "Reserved name, unknown action, or foreign resource",
          ...errorResponse,
        },
        403: { description: "Caller lacks role:create", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
        409: { description: "A role with that name already exists", ...errorResponse },
      },
    }),
    validator("param", roleSlugParam),
    validator("json", roleSchemaCreateRequest),
    requirePermission("role:create", { service: "org", type: "role", id: "*" }),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const json = c.req.valid("json")
      const name = json.name.trim()

      if (SYSTEM_ROLE_NAMES.has(name)) {
        return throwBadRequest(
          c,
          "That name is reserved for a system role",
          ErrorCode.ValidationFailed,
          {
            target: "name",
          },
        )
      }

      const validation = validateStatements(json.statements, organization.id)
      if (!validation.ok) {
        return throwBadRequest(c, validation.message, ErrorCode.ValidationFailed, {
          target: validation.target,
        })
      }

      const existing = await fetchRole(db).getByName(organization.id, name, ["id"])
      if (existing) {
        return throwError(c, 409, ErrorCode.ResourceAlreadyExists, "That role name is taken")
      }

      const role = await db.transaction().execute(async (tx) => {
        const row = await crudRole(tx).create({
          organizationId: organization.id,
          name,
          description: json.description ?? null,
          isSystem: false,
        })

        await crudRole(tx).replaceStatements(row.id, validation.statements)
        await crudMemberPermission(tx).rebuildOrganization(organization.id)

        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "role:create",
          resourceSrn: srnFor("org", organization.id, "role", row.id),
          after: { name, statements: validation.statements },
          ...auditContext(c),
        })

        return row
      })

      return c.json({ id: role.id, name: role.name }, 201)
    },
  )
  .patch(
    "/:orgSlug/roles/:roleId",
    describeRoute({
      description: "Renames a custom role or replaces its statements",
      responses: {
        200: {
          description: "Role updated",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        400: { description: "System role, unknown action, or foreign resource", ...errorResponse },
        403: { description: "Caller lacks role:update", ...errorResponse },
        404: { description: "No such organization or role", ...errorResponse },
      },
    }),
    validator("param", roleIdParam),
    validator("json", roleSchemaUpdateRequest),
    requirePermission("role:update", paramResource("org", "role", "roleId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { roleId } = c.req.valid("param")
      const json = c.req.valid("json")

      const role = await fetchRole(db).getInOrganization(organization.id, roleId, [
        "id",
        "name",
        "description",
        "isSystem",
      ])
      if (!role) return throwNotFound(c, "Role not found")

      if (role.isSystem) {
        return throwBadRequest(c, "System roles cannot be edited", ErrorCode.ResourceLocked, {
          target: "roleId",
        })
      }

      const name = json.name?.trim()
      if (name !== undefined && SYSTEM_ROLE_NAMES.has(name)) {
        return throwBadRequest(
          c,
          "That name is reserved for a system role",
          ErrorCode.ValidationFailed,
          {
            target: "name",
          },
        )
      }

      const validation =
        json.statements === undefined ? null : validateStatements(json.statements, organization.id)

      if (validation !== null && !validation.ok) {
        return throwBadRequest(c, validation.message, ErrorCode.ValidationFailed, {
          target: validation.target,
        })
      }

      const before = await fetchRole(db).listStatements([roleId])

      await db.transaction().execute(async (tx) => {
        await crudRole(tx).update(organization.id, roleId, {
          ...(name === undefined ? {} : { name }),
          ...(json.description === undefined ? {} : { description: json.description }),
        })

        if (validation !== null && validation.ok) {
          await crudRole(tx).replaceStatements(roleId, validation.statements)
        }

        // Statement edits touch no `member_role` row, so the `ON DELETE CASCADE` that cleans up
        // after a revoked assignment does nothing here. Without this rebuild the stale
        // denormalization keeps authorizing under the old statements.
        await crudMemberPermission(tx).rebuildOrganization(organization.id)

        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "role:update",
          resourceSrn: srnFor("org", organization.id, "role", roleId),
          before: {
            name: role.name,
            description: role.description,
            statements: before.map((statement) => ({
              effect: statement.effect,
              actions: statement.actions,
              resources: statement.resources,
            })),
          },
          after: {
            name: name ?? role.name,
            description: json.description === undefined ? role.description : json.description,
            statements: validation === null || !validation.ok ? undefined : validation.statements,
          },
          ...auditContext(c),
        })
      })

      return c.json({})
    },
  )
  .delete(
    "/:orgSlug/roles/:roleId",
    describeRoute({
      description: "Deletes a custom role that nobody holds",
      responses: {
        200: {
          description: "Role deleted",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        400: { description: "System roles cannot be deleted", ...errorResponse },
        403: { description: "Caller lacks role:delete", ...errorResponse },
        404: { description: "No such organization or role", ...errorResponse },
        409: { description: "The role is still assigned or invited into", ...errorResponse },
      },
    }),
    validator("param", roleIdParam),
    requirePermission("role:delete", paramResource("org", "role", "roleId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { roleId } = c.req.valid("param")

      const role = await fetchRole(db).getInOrganization(organization.id, roleId, [
        "id",
        "name",
        "isSystem",
      ])
      if (!role) return throwNotFound(c, "Role not found")

      if (role.isSystem) {
        return throwBadRequest(c, "System roles cannot be deleted", ErrorCode.ResourceLocked, {
          target: "roleId",
        })
      }

      // `member_role` cascades from `role`, so deleting an assigned role would silently strip
      // permissions from everyone holding it. Refusing makes the revocation an explicit step.
      const assignments = await fetchRole(db).countAssignments(roleId)
      if (assignments > 0) {
        return throwError(
          c,
          409,
          ErrorCode.Conflict,
          "That role is still assigned; remove it from every member first",
        )
      }

      const pending = await fetchRole(db).countPendingInvites(roleId)
      if (pending > 0) {
        return throwError(
          c,
          409,
          ErrorCode.Conflict,
          "That role has pending invites; revoke them first",
        )
      }

      await db.transaction().execute(async (tx) => {
        await crudRole(tx).remove(organization.id, roleId)
        await crudMemberPermission(tx).rebuildOrganization(organization.id)
        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "role:delete",
          resourceSrn: srnFor("org", organization.id, "role", roleId),
          before: { name: role.name },
          after: null,
          ...auditContext(c),
        })
      })

      return c.json({})
    },
  )

export default app

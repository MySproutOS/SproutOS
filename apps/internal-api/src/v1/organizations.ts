import {
  allocateOrganizationSlug,
  crudAuditLog,
  crudOrganization,
  crudUserPreference,
  fetchOrganization,
  fetchOrganizationMember,
  isValidOrganizationSlug,
  provisionOrganization,
} from "@lib/dao"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { requirePermission } from "../rbac"
import { authMiddleware } from "../middleware"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { cursorPaginate, decodeCursor } from "../utils/pagination"
import { auditContext } from "../utils/request-context"
import {
  organizationSchemaCreateRequest,
  organizationSchemaCreateResponse,
  organizationSchemaListQuery,
  organizationSchemaListResponse,
  organizationSchemaResponse,
  organizationSchemaTransferRequest,
  organizationSchemaUpdateRequest,
  organizationSlugParam,
} from "./organizations.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/",
    describeRoute({
      description: "Lists the organizations the caller is an active member of",
      responses: {
        200: {
          description: "Organizations the caller belongs to",
          content: { "application/json": { schema: resolver(organizationSchemaListResponse) } },
        },
        400: { description: "Invalid cursor", ...errorResponse },
      },
    }),
    validator("query", organizationSchemaListQuery),
    async (c) => {
      const user = c.var.user
      const query = c.req.valid("query")
      const cursor = query.cursor ?? null
      const limit = query.limit ?? 25

      try {
        decodeCursor(cursor)
      } catch {
        return throwBadRequest(c, "Invalid cursor")
      }

      const { results, nextCursor } = await cursorPaginate({
        query: fetchOrganization(db).listForUserQuery(user.id),
        cursor,
        ordering: "id",
        positionColumn: "organization.id",
        pageSize: limit,
      })

      /*
        A second query for the page, not a join on the first.

        A member may hold several roles, so joining would multiply each organization row by its
        role count and the cursor pagination above would then be paginating over the wrong thing.
        Same two-query-and-group shape the members list uses.
      */
      const roles = await fetchOrganizationMember(db).listRolesForUserInOrganizations(
        user.id,
        results.map((organization) => organization.id),
      )

      const rolesByOrganization = new Map<string, string[]>()
      for (const role of roles) {
        const bucket = rolesByOrganization.get(role.organizationId) ?? []
        bucket.push(role.name)
        rolesByOrganization.set(role.organizationId, bucket)
      }

      return c.json({
        data: results.map((organization) => ({
          ...organization,
          roleNames: rolesByOrganization.get(organization.id) ?? [],
        })),
        nextCursor,
      })
    },
  )
  .post(
    "/",
    describeRoute({
      description: "Creates an organization owned by the caller",
      responses: {
        201: {
          description: "Organization created",
          content: { "application/json": { schema: resolver(organizationSchemaCreateResponse) } },
        },
        400: { description: "Invalid name or slug", ...errorResponse },
      },
    }),
    validator("json", organizationSchemaCreateRequest),
    async (c) => {
      const user = c.var.user
      const json = c.req.valid("json")

      if (json.slug !== undefined && !isValidOrganizationSlug(json.slug)) {
        return throwBadRequest(c, "Slug is reserved or malformed", ErrorCode.ValidationFailed, {
          target: "slug",
        })
      }

      const organization = await provisionOrganization(db).createOrganization({
        userId: user.id,
        name: json.name,
        slug: json.slug ?? null,
        kind: "team",
        audit: auditContext(c),
      })

      return c.json({ id: organization.id, slug: organization.slug }, 201)
    },
  )
  .get(
    "/:orgSlug",
    describeRoute({
      description: "Reads one organization",
      responses: {
        200: {
          description: "The organization",
          content: { "application/json": { schema: resolver(organizationSchemaResponse) } },
        },
        403: { description: "Caller lacks org:read", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("param", organizationSlugParam),
    requirePermission("org:read"),
    async (c) => {
      const organization = c.var.organization

      const row = await fetchOrganization(db).getOne(organization.id, [
        "id",
        "slug",
        "name",
        "kind",
        "ownerUserId",
        "createdAt",
      ])

      if (!row) return throwNotFound(c, "Organization not found")

      return c.json({ ...row, createdAt: row.createdAt.toISOString() })
    },
  )
  .patch(
    "/:orgSlug",
    describeRoute({
      description: "Renames an organization or changes its slug",
      responses: {
        200: {
          description: "The updated organization",
          content: { "application/json": { schema: resolver(organizationSchemaResponse) } },
        },
        400: { description: "Invalid name or slug", ...errorResponse },
        403: { description: "Caller lacks org:update", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("param", organizationSlugParam),
    validator("json", organizationSchemaUpdateRequest),
    requirePermission("org:update"),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const json = c.req.valid("json")

      if (json.slug !== undefined && json.slug !== organization.slug) {
        if (!isValidOrganizationSlug(json.slug)) {
          return throwBadRequest(c, "Slug is reserved or malformed", ErrorCode.ValidationFailed, {
            target: "slug",
          })
        }

        const free = await allocateOrganizationSlug(db, json.slug)
        if (free !== json.slug) {
          return throwBadRequest(c, "Slug is already taken", ErrorCode.ResourceAlreadyExists, {
            target: "slug",
          })
        }
      }

      const updated = await db.transaction().execute(async (tx) => {
        const row = await crudOrganization(tx).update(organization.id, {
          ...(json.name === undefined ? {} : { name: json.name }),
          ...(json.slug === undefined ? {} : { slug: json.slug }),
        })

        if (!row) return undefined

        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "org:update",
          resourceSrn: srnFor("org", organization.id, "organization", organization.id),
          before: { name: organization.name, slug: organization.slug },
          after: { name: row.name, slug: row.slug },
          ...auditContext(c),
        })

        return row
      })

      if (!updated) return throwNotFound(c, "Organization not found")

      return c.json({
        id: updated.id,
        slug: updated.slug,
        name: updated.name,
        kind: updated.kind,
        ownerUserId: updated.ownerUserId,
        createdAt: updated.createdAt.toISOString(),
      })
    },
  )
  .delete(
    "/:orgSlug",
    describeRoute({
      description: "Soft-deletes an organization",
      responses: {
        200: {
          description: "Organization deleted",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        403: { description: "Caller lacks org:delete", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("param", organizationSlugParam),
    requirePermission("org:delete"),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization

      const deleted = await db.transaction().execute(async (tx) => {
        const ok = await crudOrganization(tx).softDelete(organization.id)
        if (!ok) return false

        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "org:delete",
          resourceSrn: srnFor("org", organization.id, "organization", organization.id),
          before: { slug: organization.slug, name: organization.name, deletedAt: null },
          after: { deletedAt: new Date().toISOString() },
          ...auditContext(c),
        })

        return true
      })

      if (!deleted) return throwNotFound(c, "Organization not found")

      await crudUserPreference(db).setLastOrganization(user.id, null)

      return c.json({})
    },
  )
  .post(
    "/:orgSlug/transfer-ownership",
    describeRoute({
      description: "Hands the organization to another active member",
      responses: {
        200: {
          description: "Ownership transferred",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        400: { description: "The named user cannot become the owner", ...errorResponse },
        403: { description: "Caller lacks org:transfer_ownership", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("param", organizationSlugParam),
    validator("json", organizationSchemaTransferRequest),
    requirePermission("org:transfer_ownership"),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const json = c.req.valid("json")

      const result = await provisionOrganization(db).transferOwnership({
        organizationId: organization.id,
        actorUserId: user.id,
        newOwnerUserId: json.newOwnerUserId,
        audit: auditContext(c),
      })

      if (!result.ok) {
        if (result.reason === "gone") return throwNotFound(c, "Organization not found")
        if (result.reason === "already-owner") {
          return throwBadRequest(c, "That user already owns this organization")
        }
        return throwBadRequest(
          c,
          "That user is not an active member of this organization",
          ErrorCode.ValidationFailed,
          { target: "newOwnerUserId" },
        )
      }

      return c.json({})
    },
  )

export default app

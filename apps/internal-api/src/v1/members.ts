import {
  crudAuditLog,
  crudMemberPermission,
  crudOrganizationInvite,
  crudOrganizationMember,
  crudUserPreference,
  fetchOrganization,
  fetchOrganizationInvite,
  fetchOrganizationMember,
  fetchRole,
  OWNER_ROLE_NAME,
} from "@lib/dao"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { encodeHexLowerCase, generateUrlSafeToken, sha256Utf8 } from "@utils/crypto"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest, throwForbidden, throwNotFound } from "../utils/http-exception"
import { cursorPaginate, decodeCursor } from "../utils/pagination"
import { auditContext } from "../utils/request-context"
import {
  inviteIdParam,
  inviteSchemaAcceptRequest,
  inviteSchemaAcceptResponse,
  inviteSchemaCreateRequest,
  inviteSchemaCreateResponse,
  inviteSchemaListResponse,
  memberIdParam,
  memberSchemaListQuery,
  memberSchemaListResponse,
  memberSchemaRolesRequest,
  memberSlugParam,
} from "./members.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7

async function hashInviteToken(token: string): Promise<string> {
  return encodeHexLowerCase(await sha256Utf8(token))
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/members",
    describeRoute({
      description: "Lists the organization's members and the roles each holds",
      responses: {
        200: {
          description: "Members of the organization",
          content: { "application/json": { schema: resolver(memberSchemaListResponse) } },
        },
        400: { description: "Invalid cursor", ...errorResponse },
        403: { description: "Caller lacks member:read", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("param", memberSlugParam),
    validator("query", memberSchemaListQuery),
    requirePermission("member:read", { service: "org", type: "member", id: "*" }),
    async (c) => {
      const organization = c.var.organization
      const query = c.req.valid("query")
      const cursor = query.cursor ?? null
      const limit = query.limit ?? 25

      try {
        decodeCursor(cursor)
      } catch {
        return throwBadRequest(c, "Invalid cursor")
      }

      const page = await cursorPaginate({
        query: fetchOrganizationMember(db).listQuery(organization.id),
        cursor,
        ordering: "id",
        positionColumn: "organizationMember.id",
        pageSize: limit,
      })

      const rows = page.results
      const roles = await fetchOrganizationMember(db).listRolesForMembers(rows.map((row) => row.id))

      const rolesByMember = new Map<string, { id: string; name: string }[]>()
      for (const role of roles) {
        const bucket = rolesByMember.get(role.organizationMemberId) ?? []
        bucket.push({ id: role.roleId, name: role.name })
        rolesByMember.set(role.organizationMemberId, bucket)
      }

      return c.json({
        data: rows.map((row) => ({
          id: row.id,
          userId: row.userId,
          name: row.name,
          email: row.email,
          status: row.status,
          isOwner: row.userId === organization.ownerUserId,
          roles: rolesByMember.get(row.id) ?? [],
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      })
    },
  )
  .put(
    "/:orgSlug/members/:memberId/roles",
    describeRoute({
      description: "Replaces the roles one member holds",
      responses: {
        200: {
          description: "Roles updated",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        400: { description: "Unknown role, or the owner role was named", ...errorResponse },
        403: { description: "Caller lacks member:update", ...errorResponse },
        404: { description: "No such organization or member", ...errorResponse },
      },
    }),
    validator("param", memberIdParam),
    validator("json", memberSchemaRolesRequest),
    requirePermission("member:update", paramResource("org", "member", "memberId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { memberId } = c.req.valid("param")
      const { roleIds } = c.req.valid("json")

      const member = await fetchOrganizationMember(db).getInOrganization(organization.id, memberId)
      if (!member) return throwNotFound(c, "Member not found")

      const roles = await fetchRole(db).listQuery(organization.id).execute()
      const byId = new Map(roles.map((role) => [role.id, role]))

      const unknown = roleIds.filter((roleId) => !byId.has(roleId))
      if (unknown.length > 0) {
        return throwBadRequest(
          c,
          "Unknown role for this organization",
          ErrorCode.ValidationFailed,
          {
            target: "roleIds",
          },
        )
      }

      const namesOwner = roleIds.some((roleId) => byId.get(roleId)?.name === OWNER_ROLE_NAME)
      const memberIsOwner = member.userId === organization.ownerUserId

      // The owner role is not grantable. If it were, `member:update` would be a path to
      // `org:delete` for anyone who holds it, which is exactly the authority the deny statement on
      // the admin role exists to withhold. Ownership moves only through transfer-ownership.
      if (namesOwner && !memberIsOwner) {
        return throwBadRequest(
          c,
          "The owner role is granted by transferring ownership, not by assignment",
          ErrorCode.ValidationFailed,
          { target: "roleIds" },
        )
      }

      if (memberIsOwner && !namesOwner) {
        return throwBadRequest(
          c,
          "The owner must keep the owner role; transfer ownership first",
          ErrorCode.ValidationFailed,
          { target: "roleIds" },
        )
      }

      const before = await fetchOrganizationMember(db).listRolesForMembers([memberId])

      await db.transaction().execute(async (tx) => {
        await crudOrganizationMember(tx).setRoles(memberId, roleIds)
        await crudMemberPermission(tx).rebuildOrganization(organization.id)
        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "member:update",
          resourceSrn: srnFor("org", organization.id, "member", memberId),
          before: { roleIds: before.map((row) => row.roleId) },
          after: { roleIds },
          ...auditContext(c),
        })
      })

      return c.json({})
    },
  )
  .delete(
    "/:orgSlug/members/:memberId",
    describeRoute({
      description: "Removes a member from the organization",
      responses: {
        200: {
          description: "Member removed",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        400: { description: "The owner cannot be removed", ...errorResponse },
        403: { description: "Caller lacks member:remove", ...errorResponse },
        404: { description: "No such organization or member", ...errorResponse },
      },
    }),
    validator("param", memberIdParam),
    requirePermission("member:remove", paramResource("org", "member", "memberId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { memberId } = c.req.valid("param")

      const member = await fetchOrganizationMember(db).getInOrganization(organization.id, memberId)
      if (!member) return throwNotFound(c, "Member not found")

      if (member.userId === organization.ownerUserId) {
        return throwBadRequest(
          c,
          "The owner cannot be removed; transfer ownership first",
          ErrorCode.ValidationFailed,
          { target: "memberId" },
        )
      }

      await db.transaction().execute(async (tx) => {
        await crudOrganizationMember(tx).remove(organization.id, memberId)
        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "member:remove",
          resourceSrn: srnFor("org", organization.id, "member", memberId),
          before: { userId: member.userId, status: member.status },
          after: null,
          ...auditContext(c),
        })
      })

      return c.json({})
    },
  )
  .get(
    "/:orgSlug/invites",
    describeRoute({
      description: "Lists invites that are still pending",
      responses: {
        200: {
          description: "Pending invites",
          content: { "application/json": { schema: resolver(inviteSchemaListResponse) } },
        },
        403: { description: "Caller lacks member:read", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("param", memberSlugParam),
    requirePermission("member:read", { service: "org", type: "invite", id: "*" }),
    async (c) => {
      const organization = c.var.organization

      const rows = await fetchOrganizationInvite(db).listPendingQuery(organization.id).execute()

      return c.json({
        data: rows.map((row) => ({
          id: row.id,
          email: row.email,
          roleId: row.roleId,
          roleName: row.roleName,
          invitedByUserId: row.invitedByUserId,
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        })),
      })
    },
  )
  .post(
    "/:orgSlug/invites",
    describeRoute({
      description: "Invites an email address to join the organization with one role",
      responses: {
        201: {
          description: "Invite created; the token is shown once",
          content: { "application/json": { schema: resolver(inviteSchemaCreateResponse) } },
        },
        400: { description: "Unknown role, or the address is already invited", ...errorResponse },
        403: { description: "Caller lacks member:invite", ...errorResponse },
        404: {
          description: "No such organization, or the caller is not a member",
          ...errorResponse,
        },
      },
    }),
    validator("param", memberSlugParam),
    validator("json", inviteSchemaCreateRequest),
    requirePermission("member:invite", { service: "org", type: "invite", id: "*" }),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const json = c.req.valid("json")
      const email = json.email.trim().toLowerCase()

      const role = await fetchRole(db).getInOrganization(organization.id, json.roleId, [
        "id",
        "name",
      ])
      if (!role) {
        return throwBadRequest(
          c,
          "Unknown role for this organization",
          ErrorCode.ValidationFailed,
          {
            target: "roleId",
          },
        )
      }

      if (role.name === OWNER_ROLE_NAME) {
        return throwBadRequest(
          c,
          "The owner role cannot be invited into",
          ErrorCode.ValidationFailed,
          { target: "roleId" },
        )
      }

      const pending = await fetchOrganizationInvite(db).getPendingForEmail(organization.id, email)
      if (pending) {
        return throwBadRequest(
          c,
          "That address already has a pending invite",
          ErrorCode.ResourceAlreadyExists,
          { target: "email" },
        )
      }

      const token = generateUrlSafeToken(32)
      const tokenHash = await hashInviteToken(token)
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS)

      const invite = await db.transaction().execute(async (tx) => {
        const row = await crudOrganizationInvite(tx).create({
          organizationId: organization.id,
          email,
          roleId: role.id,
          invitedByUserId: user.id,
          tokenHash,
          expiresAt,
        })

        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "member:invite",
          resourceSrn: srnFor("org", organization.id, "invite", row.id),
          after: { email, roleId: role.id, expiresAt: expiresAt.toISOString() },
          ...auditContext(c),
        })

        return row
      })

      // The raw token is returned once, here, so the caller can build the invite link. It is never
      // stored: `organization_invite.token_hash` holds only its SHA-256, the same property the
      // session table relies on.
      return c.json(
        { id: invite.id, email: invite.email, token, expiresAt: expiresAt.toISOString() },
        201,
      )
    },
  )
  .delete(
    "/:orgSlug/invites/:inviteId",
    describeRoute({
      description: "Revokes a pending invite",
      responses: {
        200: {
          description: "Invite revoked",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        403: { description: "Caller lacks member:invite", ...errorResponse },
        404: { description: "No such organization or pending invite", ...errorResponse },
      },
    }),
    validator("param", inviteIdParam),
    requirePermission("member:invite", paramResource("org", "invite", "inviteId")),
    async (c) => {
      const user = c.var.user
      const organization = c.var.organization
      const { inviteId } = c.req.valid("param")

      const revoked = await db.transaction().execute(async (tx) => {
        const row = await crudOrganizationInvite(tx).revoke(organization.id, inviteId)
        if (!row) return undefined

        await crudAuditLog(tx).record({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "member:invite:revoke",
          resourceSrn: srnFor("org", organization.id, "invite", inviteId),
          before: { email: row.email, revokedAt: null },
          after: { revokedAt: row.revokedAt?.toISOString() ?? null },
          ...auditContext(c),
        })

        return row
      })

      if (!revoked) return throwNotFound(c, "Invite not found")

      return c.json({})
    },
  )

/**
 * Invite redemption is not org-scoped: the invitee is not a member yet, so `requirePermission`
 * would 404 them out of their own invite. The token is the authorization, and it is bound to the
 * address it was sent to.
 */
export const invites = new Hono().use(authMiddleware).post(
  "/accept",
  describeRoute({
    description: "Redeems an invite token and joins the organization",
    responses: {
      200: {
        description: "Joined the organization",
        content: { "application/json": { schema: resolver(inviteSchemaAcceptResponse) } },
      },
      400: { description: "The invite is expired, revoked, or already used", ...errorResponse },
      403: { description: "The invite was issued to a different address", ...errorResponse },
      404: { description: "No such invite", ...errorResponse },
    },
  }),
  validator("json", inviteSchemaAcceptRequest),
  async (c) => {
    const user = c.var.user
    const { token } = c.req.valid("json")

    const invite = await fetchOrganizationInvite(db).getByTokenHash(await hashInviteToken(token))
    if (!invite) return throwNotFound(c, "Invite not found")

    if (invite.acceptedAt !== null || invite.revokedAt !== null) {
      return throwBadRequest(c, "That invite is no longer valid", ErrorCode.ResourceLocked)
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      return throwBadRequest(c, "That invite has expired", ErrorCode.ResourceLocked)
    }

    // Bound to the address it was sent to, so forwarding the link does not hand the team to
    // whoever received the forward.
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
      return throwForbidden(c, "That invite was issued to a different address")
    }

    const organization = await fetchOrganization(db).getOne(invite.organizationId, ["id", "slug"])
    if (!organization) return throwNotFound(c, "Invite not found")

    const joined = await db.transaction().execute(async (tx) => {
      const claimed = await crudOrganizationInvite(tx).markAccepted(invite.id)
      if (!claimed) return false

      const existing = await fetchOrganizationMember(tx).getForUser(organization.id, user.id)
      const membership =
        existing ??
        (await crudOrganizationMember(tx).create({
          organizationId: organization.id,
          userId: user.id,
          status: "active",
        }))

      if (existing && existing.status !== "active") {
        await crudOrganizationMember(tx).update(existing.id, { status: "active" })
      }

      await crudOrganizationMember(tx).assignRole(membership.id, invite.roleId)
      await crudMemberPermission(tx).rebuildOrganization(organization.id)

      await crudAuditLog(tx).record({
        organizationId: organization.id,
        actorUserId: user.id,
        action: "member:invite:accept",
        resourceSrn: srnFor("org", organization.id, "member", membership.id),
        before: { inviteId: invite.id },
        after: { userId: user.id, roleId: invite.roleId },
        ...auditContext(c),
      })

      return true
    })

    if (!joined) {
      return throwBadRequest(c, "That invite is no longer valid", ErrorCode.ResourceLocked)
    }

    await crudUserPreference(db).setLastOrganization(user.id, organization.id)

    return c.json({ organizationId: organization.id, organizationSlug: organization.slug })
  },
)

export default app

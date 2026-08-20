import type { AuthSession, SessionUser } from "@lib/dao"
import {
  fetchMemberPermission,
  fetchOrganization,
  fetchOrganizationMember,
  fetchUserPreference,
} from "@lib/dao"
import { expandSrnTarget, srnFor, tryParseSrn } from "@lib/srn"
import { db } from "@sproutos/db"
import type { Context } from "hono"
import { createMiddleware } from "hono/factory"
import { ErrorCode } from "../utils/errors.enum"
import { throwForbidden, throwNotFound } from "../utils/http-exception"
import { type Action, expandAction } from "./actions"
import {
  type MembershipContext,
  type OrganizationContext,
  organizationResource,
  type ResourceSelector,
  resolveResourceTarget,
} from "./resources"

export type PermissionVariables = {
  user: SessionUser
  session: AuthSession
  organization: OrganizationContext
  membership: MembershipContext
}

const ORGANIZATION_FIELDS = ["id", "slug", "name", "kind", "ownerUserId"] as const

/**
 * Resolves which organization a request is about.
 *
 * The slug in the path wins, per ADR 0003 — tenancy that comes from a cookie or from session
 * state is the textbook confused-deputy setup, and it breaks two tabs on two teams. The fallback
 * to `user_preference.last_org_id` exists only for routes that are genuinely org-scoped but have
 * no slug to carry it, and it is filtered through live membership so a stale pointer resolves to
 * nothing.
 */
async function resolveOrganization(
  c: Context,
  userId: string,
): Promise<OrganizationContext | null> {
  const slug = c.req.param("orgSlug")

  if (slug !== undefined && slug !== "") {
    const bySlug = await fetchOrganization(db).getBySlug(slug, [...ORGANIZATION_FIELDS])
    return bySlug ?? null
  }

  const lastOrganizationId = await fetchUserPreference(db).getLastOrganizationId(userId)
  if (lastOrganizationId === null) return null

  const byId = await fetchOrganization(db).getOne(lastOrganizationId, [...ORGANIZATION_FIELDS])
  return byId ?? null
}

/**
 * Gate a route on one action against one resource.
 *
 * Runs after `authMiddleware`, which it does not replace: it reads `c.var.user` and would throw
 * without it. On success the handler gets `c.var.organization` and `c.var.membership`.
 *
 * Failure modes are deliberately asymmetric. A caller who is not a member — or who names an
 * organization that does not exist, or one that was soft-deleted — gets **404**, because 403
 * would confirm that a team with that slug exists and who is in it. A caller who *is* a member
 * but lacks the action gets **403**, which tells them something they already know.
 */
export function requirePermission(
  action: Action,
  resource: ResourceSelector = organizationResource,
) {
  return createMiddleware<{ Variables: PermissionVariables }>(async (c, next) => {
    const user = c.var.user

    const organization = await resolveOrganization(c, user.id)
    if (organization === null) return throwNotFound(c, "Organization not found")

    const membership = await fetchOrganizationMember(db).getForUser(organization.id, user.id)
    if (!membership || membership.status !== "active") {
      return throwNotFound(c, "Organization not found")
    }

    const target = await resolveResourceTarget(resource, c, organization)
    const srn = srnFor(target.service, organization.id, target.type, target.id)
    const parsed = tryParseSrn(srn)
    if (parsed === null) {
      return throwForbidden(c, "Forbidden", ErrorCode.InsufficientPermissions)
    }

    const decision = await fetchMemberPermission(db).evaluate(
      user.id,
      organization.id,
      expandAction(action),
      expandSrnTarget(parsed),
    )

    if (decision.denied || !decision.allowed) {
      return throwForbidden(c, "Forbidden", ErrorCode.InsufficientPermissions)
    }

    c.set("organization", organization)
    c.set("membership", { id: membership.id, userId: membership.userId, status: membership.status })

    await next()
    return undefined
  })
}

/**
 * A second permission check inside a handler, for decisions a route-level gate cannot express —
 * "may this caller also see the billing column of the row they are allowed to read".
 *
 * Same evaluation as the middleware, including deny-wins; it just returns a boolean instead of a
 * response.
 */
export async function hasPermission(
  userId: string,
  organization: OrganizationContext,
  action: Action,
  target: { service: Parameters<typeof srnFor>[0]; type: string; id: string },
): Promise<boolean> {
  const parsed = tryParseSrn(srnFor(target.service, organization.id, target.type, target.id))
  if (parsed === null) return false

  const decision = await fetchMemberPermission(db).evaluate(
    userId,
    organization.id,
    expandAction(action),
    expandSrnTarget(parsed),
  )

  return decision.allowed && !decision.denied
}

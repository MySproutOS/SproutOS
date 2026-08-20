import type { AuthSession, SessionUser } from "@lib/dao"
import type { AuthContext } from "../middleware"
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
import { type Action, actionsCover, expandAction } from "./actions"
import {
  type MembershipContext,
  type OrganizationContext,
  organizationResource,
  type ResourceSelector,
  resolveResourceTarget,
} from "./resources"

export type PermissionVariables = {
  user: SessionUser
  /** Null when the caller authenticated with a bearer credential rather than a cookie. */
  session: AuthSession | null
  /** How they authenticated, and what that credential was granted. See `middleware.ts`. */
  auth: AuthContext
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
 * Resolves the organization *and* asserts the caller is an active member of it.
 *
 * The single home of the "404 never leaks existence" rule. A caller who is not a member, one who
 * names an organization that does not exist, and one whose membership is suspended are all the
 * same `null` here, so no caller of this function can accidentally distinguish them.
 */
async function resolveMembership(
  c: Context,
  userId: string,
): Promise<{ organization: OrganizationContext; membership: MembershipContext } | null> {
  const organization = await resolveOrganization(c, userId)
  if (organization === null) return null

  const membership = await fetchOrganizationMember(db).getForUser(organization.id, userId)
  if (!membership || membership.status !== "active") return null

  return {
    organization,
    membership: { id: membership.id, userId: membership.userId, status: membership.status },
  }
}

/**
 * Resolve the organization and require active membership, with no permission check at all.
 *
 * For the handful of routes whose authority is membership itself rather than a granted action —
 * leaving a team is the whole set today. Deliberately not expressed as an action in the
 * catalogue: an action no route evaluates would let a custom role carry a `deny` that silently
 * does nothing, which is the exact failure the catalogue exists to prevent.
 */
export function requireMembership() {
  return createMiddleware<{ Variables: PermissionVariables }>(async (c, next) => {
    const resolved = await resolveMembership(c, c.var.user.id)
    if (resolved === null) return throwNotFound(c, "Organization not found")

    c.set("organization", resolved.organization)
    c.set("membership", resolved.membership)

    await next()
    return undefined
  })
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

    /*
      A bearer credential's power is the intersection of what the user can do and what the
      credential was granted, so the scope check comes first — and it is a check on the *action*
      alone, which is why it can run before the membership lookup.

      Checked before RBAC deliberately: a token that was never granted `project:delete` should be
      refused whether or not its user happens to have the permission, and doing the cheap check
      first means a wrong-scope request costs no queries.

      `scopes: null` is a session — a person at a browser, whose RBAC is the whole answer.
    */
    const scopes = c.var.auth?.scopes ?? null
    if (scopes !== null && !actionsCover(scopes, action)) {
      return throwForbidden(c, "Forbidden", ErrorCode.InsufficientPermissions)
    }

    const resolved = await resolveMembership(c, user.id)
    if (resolved === null) return throwNotFound(c, "Organization not found")

    const { organization, membership } = resolved

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
    c.set("membership", membership)

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

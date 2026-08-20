import type { SrnService } from "@lib/srn"
import type { Context } from "hono"

/** The organization a request resolved to, as handlers see it on `c.var.organization`. */
export type OrganizationContext = {
  id: string
  slug: string
  name: string
  kind: string
  ownerUserId: string
}

/** The caller's membership in that organization, on `c.var.membership`. */
export type MembershipContext = {
  id: string
  userId: string
  status: string
}

/**
 * What a route is acting on, minus the organization segment.
 *
 * The organization is deliberately absent: `requirePermission` fills it in from the resolved
 * organization, never from request input. A selector that could name its own organization would
 * let a caller who legitimately belongs to one team hand in an SRN scoped to another and be
 * authorized against the wrong tenant (ADR 0016).
 */
export type ResourceTarget = {
  service: SrnService
  type: string
  id: string
}

export type ResourceSelector =
  | ResourceTarget
  | ((c: Context, organization: OrganizationContext) => ResourceTarget | Promise<ResourceTarget>)

/** The organization row itself — the default target for org-level actions. */
export const organizationResource: ResourceSelector = (_c, organization) => ({
  service: "org",
  type: "organization",
  id: organization.id,
})

/** Every resource of one type in the organization, for list and create routes. */
export function collectionResource(service: SrnService, type: string): ResourceSelector {
  return { service, type, id: "*" }
}

/**
 * One resource named by a path parameter.
 *
 * A missing parameter yields the empty string, which is not a legal SRN segment, so the request
 * is denied rather than silently widened to a wildcard.
 */
export function paramResource(
  service: SrnService,
  type: string,
  parameter: string,
): ResourceSelector {
  return (c) => ({ service, type, id: c.req.param(parameter) ?? "" })
}

export async function resolveResourceTarget(
  selector: ResourceSelector,
  c: Context,
  organization: OrganizationContext,
): Promise<ResourceTarget> {
  return typeof selector === "function" ? await selector(c, organization) : selector
}

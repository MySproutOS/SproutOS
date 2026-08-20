import { useQuery } from "@tanstack/react-query"
import {
  getV1AuthMeOptions,
  getV1UserMePreferencesOptions,
  getV1OrgsByOrgSlugOptions,
  getV1OrgsOptions,
} from "@lib/api-client/generated/@tanstack/react-query.gen"

export type OrganizationRole = "owner" | "admin" | "member"

export type Organization = {
  id: string
  slug: string
  name: string
  /** Single letter shown in the team switcher until real avatars exist. */
  initial: string
  kind: string
  isOwner: boolean
}

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
}

type OrganizationResponse = {
  id: string
  slug: string
  name: string
  kind: string
  ownerUserId: string
}

/*
  `GET /v1/orgs` returns `ownerUserId`, not the caller's role, so owner-vs-member
  is all the switcher can honestly say — an admin renders as "Member" until the
  list response carries a role for the caller. `GET .../members` does have real
  roles, but fetching it per organization to label one line of the sidebar would
  be a request per team on every page.
*/
function toOrganization(organization: OrganizationResponse, userId: string | null): Organization {
  return {
    id: organization.id,
    slug: organization.slug,
    name: organization.name,
    initial: (organization.name.trim()[0] ?? "·").toUpperCase(),
    kind: organization.kind,
    isOwner: organization.ownerUserId === userId,
  }
}

export function organizationRoleLabel(organization: Organization | undefined): string {
  if (organization === undefined) return ""
  return organization.isOwner ? ROLE_LABELS.owner : ROLE_LABELS.member
}

export function useOrganizations() {
  const me = useQuery(getV1AuthMeOptions())
  const query = useQuery(getV1OrgsOptions())
  const userId = me.data?.user?.id ?? null

  return {
    ...query,
    isPending: query.isPending || me.isPending,
    isError: query.isError || me.isError,
    data: query.data?.data.map((organization) => toOrganization(organization, userId)),
  }
}

export function useOrganization(slug: string) {
  const me = useQuery(getV1AuthMeOptions())
  const query = useQuery(getV1OrgsByOrgSlugOptions({ path: { orgSlug: slug } }))
  const userId = me.data?.user?.id ?? null

  return {
    ...query,
    isPending: query.isPending || me.isPending,
    isError: query.isError || me.isError,
    data: query.data === undefined ? undefined : toOrganization(query.data, userId),
  }
}

/**
 * The organization to land a user in.
 *
 * `user_preference.last_org_id`, resolved server-side — and the server falls back deterministically
 * when it does not point at a live membership: the personal organization first, then the oldest
 * team. The column is `ON DELETE SET NULL`, but nothing clears it when someone is merely *removed*
 * from a team, so "the row says X" and "X is somewhere they can go" are different questions.
 *
 * Doing the fallback there rather than here means the redirect after login and any other caller
 * agree about where "home" is.
 */
export function useLastOrganizationSlug() {
  const query = useQuery(getV1UserMePreferencesOptions())
  return {
    ...query,
    data: query.data?.lastOrganizationSlug ?? null,
  }
}

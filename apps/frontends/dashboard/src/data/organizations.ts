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
  /** The roles the caller holds here, as the API named them. */
  roleNames: string[]
}

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
}

/*
  A Map, not `ROLE_LABELS[name]`, because `name` is a customer-typed RBAC role.
  Indexing a plain object with free text reaches `Object.prototype`: a role named
  `constructor` or `toString` returns a *function*, which is truthy — so a `??`
  fallback never fires and React throws on a function child. A Map has no
  prototype keys, and it needs no `as OrganizationRole` assertion, which is what
  hid the hole from the type checker in the first place.
*/
const SEEDED_ROLE_LABELS = new Map<string, string>(Object.entries(ROLE_LABELS))

type OrganizationResponse = {
  id: string
  slug: string
  name: string
  kind: string
  ownerUserId: string
  roleNames: string[]
}
function toOrganization(organization: OrganizationResponse, userId: string | null): Organization {
  return {
    id: organization.id,
    slug: organization.slug,
    name: organization.name,
    initial: (organization.name.trim()[0] ?? "·").toUpperCase(),
    kind: organization.kind,
    isOwner: organization.ownerUserId === userId,
    roleNames: organization.roleNames,
  }
}

/**
 * What to call the caller in this team.
 *
 * `GET /v1/orgs` now carries the caller's own `roleNames`, so an admin reads as "Admin". It used to
 * carry only `ownerUserId`, and owner-vs-member was the most the switcher could honestly say — the
 * alternative, fetching `.../members` per organization to label one line of the sidebar, is a
 * request per team on every page load.
 *
 * `isOwner` still wins over the role list. Ownership is a column on the organization rather than a
 * role, and someone can hold the `owner` role without being the owner of record; the switcher
 * should say what the database says.
 *
 * A member may hold several roles. The first is shown, because one line of sidebar chrome is not
 * the place to enumerate them — the members screen is.
 */
export function organizationRoleLabel(organization: Organization | undefined): string {
  if (organization === undefined) return ""
  if (organization.isOwner) return ROLE_LABELS.owner

  const role = organization.roleNames.find((name) => name !== "owner")
  if (role === undefined) return ROLE_LABELS.member

  // A customer's own role name, rendered as they typed it, when it is not one of the three seeded.
  return SEEDED_ROLE_LABELS.get(role) ?? role
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

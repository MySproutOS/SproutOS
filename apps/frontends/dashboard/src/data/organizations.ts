import { usePlaceholderQuery } from "@frontends/dashboard/data/placeholder"

export type OrganizationRole = "owner" | "admin" | "member"

export type Organization = {
  id: string
  slug: string
  name: string
  /** Single letter shown in the team switcher until real avatars exist. */
  initial: string
  role: OrganizationRole
}

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
}

const ORGANIZATIONS: Organization[] = [
  { id: "org_01", slug: "andrews-team", name: "Andrew's Team", initial: "A", role: "owner" },
  { id: "org_02", slug: "acme-co", name: "Acme Co", initial: "A", role: "admin" },
  {
    id: "org_03",
    slug: "weekend-projects",
    name: "Weekend Projects",
    initial: "W",
    role: "member",
  },
]

/** PLACEHOLDER — swap for `getV1OrganizationOptions()`. */
export function useOrganizations() {
  return usePlaceholderQuery(["organizations"], ORGANIZATIONS)
}

/**
 * PLACEHOLDER — swap for `getV1OrganizationBySlugOptions({ path: { slug } })`.
 * Derived from the list today so the sidebar and the switcher cannot disagree.
 */
export function useOrganization(slug: string) {
  const query = useOrganizations()
  return {
    ...query,
    data: query.data?.find((organization) => organization.slug === slug),
  }
}

/**
 * PLACEHOLDER — swap for the `last_org_id` field on `getV1UserPreferenceOptions()`.
 * ADR 0004 puts the redirect target in `user_preference`, so `/dashboard` resolves
 * it server-side rather than guessing from the org list.
 */
export function useLastOrganizationSlug() {
  const query = useOrganizations()
  return {
    ...query,
    data: query.data?.[0]?.slug ?? null,
  }
}

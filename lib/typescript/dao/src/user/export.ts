import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

/**
 * Everything the platform holds about one person, as a document they can take away.
 *
 * The right of access is the half of GDPR that is easy to forget once deletion works, and it is the
 * half a customer actually exercises: they want to leave, and before they leave they want what they
 * wrote. `deleteUser` already refuses while they own an organization, which makes this the step
 * that comes first in practice.
 *
 * Three rules shape what is in here.
 *
 * **No secrets, ever.** Not the OAuth access token in `account`, not `api_key.key_hash`, not
 * `session.session_key`. An export is a file that leaves our custody by design — it goes to a
 * download folder, an email, a cloud drive — and a file that carries live credentials turns a data
 * subject request into a credential distribution channel. Where a credential exists, the export
 * says it exists and names it; it does not carry it.
 *
 * **Personal data, not the whole database.** The right is to the data concerning *them*. An
 * organization's projects are the organization's, and shipping every project a member could see
 * would let any member of a team export the team. What is here is what is theirs: their profile,
 * their preferences, their memberships, the keys and grants they hold, and the record of what they
 * did.
 *
 * **Bounded, and honest about it.** The audit trail and the session history have no upper size, and
 * a query that streams a million rows into a JSON response is a way to take the API down rather
 * than a way to serve a request. Each collection is capped and each says whether it was truncated,
 * because silently returning the most recent thousand rows under the heading "your data" is worse
 * than saying there are more.
 */

/** Rows per collection. Generous for a person, bounded for the process serving it. */
export const EXPORT_LIMIT = 1000

export type ExportedCollection<T> = {
  items: T[]
  /** True when more rows exist than the cap allowed. Never silently false. */
  truncated: boolean
}

export type UserExport = {
  /** ISO 8601, so the document says what moment it describes. */
  exportedAt: string
  format: "sproutos.user-export.v1"
  profile: {
    id: string
    email: string
    name: string | null
    image: string | null
    githubLogin: string | null
    createdAt: string
    updatedAt: string
  }
  preferences: {
    timezone: string
    productEmails: boolean
    sidebarCollapsed: boolean
    navPinnedProjectIds: string[]
    updatedAt: string
  } | null
  identities: ExportedCollection<{
    provider: string
    providerAccountId: string
    scopes: string[]
    createdAt: string
  }>
  organizations: ExportedCollection<{
    id: string
    slug: string
    name: string
    owner: boolean
    joinedAt: string
  }>
  apiKeys: ExportedCollection<{
    id: string
    name: string
    prefix: string
    createdAt: string
    lastUsedAt: string | null
    revokedAt: string | null
  }>
  authorizedApplications: ExportedCollection<{
    clientId: string
    clientName: string
    scopes: string[]
    grantedAt: string
  }>
  sessions: ExportedCollection<{
    createdAt: string
    expires: string
    ip: string | null
    userAgent: string | null
  }>
  activity: ExportedCollection<{
    action: string
    resourceSrn: string | null
    organizationId: string | null
    ip: string | null
    createdAt: string
  }>
}

export function exportUser(db: Kysely<DB>) {
  async function forUser(userId: string): Promise<UserExport | null> {
    const profile = await db
      .selectFrom("user")
      .select(["id", "email", "name", "image", "githubLogin", "createdAt", "updatedAt"])
      .where("id", "=", userId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (profile === undefined) return null

    const preference = await db
      .selectFrom("userPreference")
      .select(["timezone", "productEmails", "sidebarCollapsed", "navPinnedProjectIds", "updatedAt"])
      .where("userId", "=", userId)
      .executeTakeFirst()

    /*
      `account` carries `access_token_ciphertext` and `refresh_token_ciphertext`, and neither is in
      this select. The provider, the account id and the granted scopes are the personal data — they
      are what says "this GitHub user is this SproutOS user, and this is what we may do as them".
      The tokens are a credential for a *third party's* API, and handing a customer a working GitHub
      token in a file they will email themselves is a way to compromise their GitHub account on our
      initiative.
    */
    const identities = await capped((limit) =>
      db
        .selectFrom("account")
        .select(["provider", "providerAccountId", "scopes", "createdAt"])
        .where("userId", "=", userId)
        .orderBy("createdAt", "asc")
        .limit(limit)
        .execute(),
    )

    const organizations = await capped((limit) =>
      db
        .selectFrom("organizationMember")
        .innerJoin("organization", "organization.id", "organizationMember.organizationId")
        .select((eb) => [
          "organization.id as id",
          "organization.slug as slug",
          "organization.name as name",
          "organizationMember.createdAt as joinedAt",
          eb("organization.ownerUserId", "=", userId).as("owner"),
        ])
        .where("organizationMember.userId", "=", userId)
        .where("organization.deletedAt", "is", null)
        .orderBy("organizationMember.createdAt", "asc")
        .limit(limit)
        .execute(),
    )

    // Metadata only. `key_hash` is a hash and useless to them; `prefix` is what the UI shows
    // anyway. There is no path by which an export reveals a usable key.
    const apiKeys = await capped((limit) =>
      db
        .selectFrom("apiKey")
        .select(["id", "name", "prefix", "createdAt", "lastUsedAt", "revokedAt"])
        .where("userId", "=", userId)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .execute(),
    )

    // Only the grants that still stand. A revoked grant is a record of an authorization that has
    // been withdrawn, and it lives in `activity` below where the audit trail keeps it in order.
    const authorizedApplications = await capped((limit) =>
      db
        .selectFrom("oauthGrant")
        .innerJoin("oauthClient", "oauthClient.id", "oauthGrant.oauthClientId")
        .select([
          "oauthClient.id as clientId",
          "oauthClient.name as clientName",
          "oauthGrant.scopes as scopes",
          "oauthGrant.createdAt as grantedAt",
        ])
        .where("oauthGrant.userId", "=", userId)
        .where("oauthGrant.revokedAt", "is", null)
        .orderBy("oauthGrant.createdAt", "desc")
        .limit(limit)
        .execute(),
    )

    /*
      `session_key` is the credential and is not here. The IP and the user agent are, because we
      store them: an export is also a statement about what we hold, and leaving out the fields that
      are least flattering to collect is how an export becomes a misleading document rather than an
      incomplete one.
    */
    const sessions = await capped((limit) =>
      db
        .selectFrom("session")
        .select(["createdAt", "expires", "ip", "userAgent"])
        .where("userId", "=", userId)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .execute(),
    )

    /*
      Their own actions, not their organizations'.

      `audit_log` is keyed by actor, and an export scoped to the actor is the person's own record.
      Exporting every row of an organization they belong to would hand one member the trail of
      everyone else's actions — the audit log is the organization's, and only this slice is theirs.

      `before`/`after` are omitted: they hold the state of whatever was changed, which is very often
      somebody else's data described in a row that happens to name this user as the actor.
    */
    const activity = await capped((limit) =>
      db
        .selectFrom("auditLog")
        .select(["action", "resourceSrn", "organizationId", "ip", "createdAt"])
        .where("actorUserId", "=", userId)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .execute(),
    )

    return {
      exportedAt: new Date().toISOString(),
      format: "sproutos.user-export.v1",
      profile: {
        id: profile.id,
        email: profile.email,
        name: profile.name,
        image: profile.image,
        githubLogin: profile.githubLogin,
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
      },
      preferences:
        preference === undefined
          ? null
          : {
              timezone: preference.timezone,
              productEmails: preference.productEmails,
              sidebarCollapsed: preference.sidebarCollapsed,
              navPinnedProjectIds: preference.navPinnedProjectIds,
              updatedAt: preference.updatedAt.toISOString(),
            },
      identities: {
        items: identities.items.map((row) => ({
          provider: row.provider,
          providerAccountId: row.providerAccountId,
          scopes: row.scopes,
          createdAt: row.createdAt.toISOString(),
        })),
        truncated: identities.truncated,
      },
      organizations: {
        items: organizations.items.map((row) => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          owner: Boolean(row.owner),
          joinedAt: row.joinedAt.toISOString(),
        })),
        truncated: organizations.truncated,
      },
      apiKeys: {
        items: apiKeys.items.map((row) => ({
          id: row.id,
          name: row.name,
          prefix: row.prefix,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
        })),
        truncated: apiKeys.truncated,
      },
      authorizedApplications: {
        items: authorizedApplications.items.map((row) => ({
          clientId: row.clientId,
          clientName: row.clientName,
          scopes: row.scopes,
          grantedAt: row.grantedAt.toISOString(),
        })),
        truncated: authorizedApplications.truncated,
      },
      sessions: {
        items: sessions.items.map((row) => ({
          createdAt: row.createdAt.toISOString(),
          expires: row.expires.toISOString(),
          ip: row.ip,
          userAgent: row.userAgent,
        })),
        truncated: sessions.truncated,
      },
      activity: {
        items: activity.items.map((row) => ({
          action: row.action,
          resourceSrn: row.resourceSrn,
          organizationId: row.organizationId,
          ip: row.ip,
          createdAt: row.createdAt.toISOString(),
        })),
        truncated: activity.truncated,
      },
    }
  }

  return { forUser }
}

/**
 * Run a query one row past the cap, so "there are more" is known rather than guessed.
 *
 * Comparing the returned count to the limit cannot distinguish "exactly `EXPORT_LIMIT` rows" from
 * "more than that", and reporting the first as truncated would be a lie in the one direction that
 * matters — telling someone their export is incomplete when it is not.
 *
 * It takes a function rather than a half-built query because a Kysely builder's type is enormous,
 * and a parameter shaped `{ limit(n): { execute() } }` matches it only by discarding the row type
 * on the way through. Passing the limit in keeps the inference on the caller's side, where it works.
 */
async function capped<T>(run: (limit: number) => Promise<T[]>): Promise<ExportedCollection<T>> {
  const rows = await run(EXPORT_LIMIT + 1)
  return { items: rows.slice(0, EXPORT_LIMIT), truncated: rows.length > EXPORT_LIMIT }
}

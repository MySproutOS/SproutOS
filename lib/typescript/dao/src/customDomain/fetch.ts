import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export const CUSTOM_DOMAIN_FIELDS = [
  "id",
  "organizationId",
  "projectId",
  "hostname",
  "isApex",
  "verificationToken",
  "verifiedAt",
  "certificateObjectKey",
  "certificateObjectVersion",
  "certificateIssuedAt",
  "certificateExpiresAt",
  "nextRenewalAt",
  "nextRetryAt",
  "lastCheckedAt",
  "claimExpiresAt",
  "status",
  "statusReason",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof DB["customDomain"])[]

export function fetchCustomDomain(db: Kysely<DB>) {
  async function getInProject<T extends (keyof DB["customDomain"])[]>(
    organizationId: string,
    projectId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["customDomain"]>, T[number]> | undefined> {
    return await db
      .selectFrom("customDomain")
      .select(fields)
      .where("id", "=", id)
      .where("projectId", "=", projectId)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  async function findLiveByHostname<T extends (keyof DB["customDomain"])[]>(
    hostname: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["customDomain"]>, T[number]> | undefined> {
    return await db
      .selectFrom("customDomain")
      .select(fields)
      .where("hostname", "=", hostname)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  function listInProjectQuery(organizationId: string, projectId: string) {
    return db
      .selectFrom("customDomain")
      .select(CUSTOM_DOMAIN_FIELDS)
      .where("organizationId", "=", organizationId)
      .where("projectId", "=", projectId)
      .where("deletedAt", "is", null)
      .orderBy("createdAt", "asc")
  }

  function listInOrganizationQuery(organizationId: string) {
    return db
      .selectFrom("customDomain")
      .innerJoin("project", "project.id", "customDomain.projectId")
      .select(CUSTOM_DOMAIN_FIELDS.map((field) => `customDomain.${field}` as const))
      .select(["project.name as projectName", "project.slug as projectSlug"])
      .where("customDomain.organizationId", "=", organizationId)
      .where("customDomain.deletedAt", "is", null)
      .where("project.deletedAt", "is", null)
      .orderBy("customDomain.createdAt", "asc")
  }

  function listDueQuery(now: Date) {
    return db
      .selectFrom("customDomain")
      .select(["id", "organizationId"])
      .where("deletedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("nextRetryAt", "<=", now),
          eb.and([
            eb("status", "in", ["active", "renewal_warning"]),
            eb("nextRenewalAt", "<=", now),
          ]),
          eb.and([
            eb("status", "in", ["active", "renewal_warning"]),
            eb("renewalInfoRetryAt", "<=", now),
          ]),
        ]),
      )
      .orderBy("nextRetryAt", "asc")
      .limit(100)
  }

  return {
    findLiveByHostname,
    getInProject,
    listInOrganizationQuery,
    listInProjectQuery,
    listDueQuery,
  }
}

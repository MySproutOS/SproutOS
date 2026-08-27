import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/**
 * `github_installation` is org-scoped (ADR 0007). `installed_by_user_id` is provenance, not the
 * access-control key — headless upkeep has to keep working after the installing user leaves.
 *
 * Suspended installations are filtered alongside deleted ones: a suspended installation's tokens
 * cannot be minted, so handing one to a provisioning job produces a 403 an hour later instead of
 * a refusal now.
 */
export function fetchGithubInstallation(db: Kysely<DB>) {
  async function getForRepository<T extends (keyof DB["githubInstallation"])[]>(
    organizationId: string,
    repositoryId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["githubInstallation"]>, T[number]> | undefined> {
    const repository = await db
      .selectFrom("repository")
      .select("githubInstallationId")
      .where("id", "=", repositoryId)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (repository === undefined || repository.githubInstallationId === null) return undefined
    return await db
      .selectFrom("githubInstallation")
      .select(fields)
      .where("id", "=", repository.githubInstallationId)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .where("suspendedAt", "is", null)
      .executeTakeFirst()
  }

  async function getInOrganization<T extends (keyof DB["githubInstallation"])[]>(
    organizationId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["githubInstallation"]>, T[number]> | undefined> {
    return await db
      .selectFrom("githubInstallation")
      .select(fields)
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
  }

  async function listUsable<T extends (keyof DB["githubInstallation"])[]>(
    organizationId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["githubInstallation"]>, T[number]>[]> {
    return await db
      .selectFrom("githubInstallation")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .where("deletedAt", "is", null)
      .where("suspendedAt", "is", null)
      .orderBy("id", "desc")
      .execute()
  }

  async function getByAccountLogin<T extends (keyof DB["githubInstallation"])[]>(
    organizationId: string,
    accountLogin: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["githubInstallation"]>, T[number]> | undefined> {
    return await db
      .selectFrom("githubInstallation")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .where("accountLogin", "=", accountLogin)
      .where("deletedAt", "is", null)
      .where("suspendedAt", "is", null)
      .executeTakeFirst()
  }

  return { getByAccountLogin, getForRepository, getInOrganization, listUsable }
}

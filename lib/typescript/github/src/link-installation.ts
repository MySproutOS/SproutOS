import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

/** The facts about an installation this platform stores, from a webhook or from the REST API. */
export type InstallationFacts = {
  id: number
  login: string
  accountType: string
  repositorySelection: string
  permissions: Record<string, string>
  suspended: boolean
}

/**
 * Writes the row that makes the App usable for an organization.
 *
 * Lives here rather than beside the webhook handlers because a webhook is only one of the ways an
 * installation becomes known, and it is the *worst* one: a delivery says which GitHub account the
 * App was installed on and cannot say which SproutOS organization asked for it. The setup redirect
 * knows both, because the person who clicked install is still signed in when GitHub sends them
 * back.
 */
export async function linkInstallation(
  db: Kysely<DB>,
  organizationId: string,
  facts: InstallationFacts,
): Promise<void> {
  await db
    .insertInto("githubInstallation")
    .values({
      id: v7(),
      organizationId,
      installationId: String(facts.id),
      accountLogin: facts.login,
      accountType: facts.accountType,
      repositorySelection: facts.repositorySelection,
      permissions: facts.permissions as never,
    })
    /*
      Keyed on the installation, because GitHub reuses the id across events — `created`,
      `new_permissions_accepted`, `suspend`, `unsuspend` all carry the same one. Inserting on each
      would give one installation several rows and whichever was read first would win.
    */
    .onConflict((oc) =>
      oc.column("installationId").doUpdateSet({
        organizationId,
        accountLogin: facts.login,
        repositorySelection: facts.repositorySelection,
        permissions: facts.permissions as never,
        suspendedAt: facts.suspended ? new Date() : null,
        updatedAt: new Date(),
      }),
    )
    .execute()

  console.info(`[github] installation ${facts.id} on ${facts.login} linked to ${organizationId}`)
}

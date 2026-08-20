import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export function fetchAgentConfig(db: Kysely<DB>) {
  async function getForOrganization<T extends (keyof DB["agentConfig"])[]>(
    organizationId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["agentConfig"]>, T[number]> | undefined> {
    return await db
      .selectFrom("agentConfig")
      .select(fields)
      .where("scope", "=", "organization")
      .where("organizationId", "=", organizationId)
      .executeTakeFirst()
  }

  async function getForProject<T extends (keyof DB["agentConfig"])[]>(
    projectId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["agentConfig"]>, T[number]> | undefined> {
    return await db
      .selectFrom("agentConfig")
      .select(fields)
      .where("scope", "=", "project")
      .where("projectId", "=", projectId)
      .executeTakeFirst()
  }

  return { getForOrganization, getForProject }
}

import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import { v7 } from "uuid"

export type AgentConfigUpsert = {
  agentCredentialId?: string | null
  useSproutosCredits?: boolean
  model?: string | null
  maxBudgetMicroUsd?: bigint | null
  permissionMode?: string
}

export function crudAgentConfig(db: Kysely<DB>) {
  /**
   * One config row per scope, created on first write.
   *
   * The partial unique indexes (`agent_config_organization_key`, `agent_config_project_key`) are
   * what make this safe under concurrency: two simultaneous saves collide on the index and the
   * second becomes an update rather than a second row that shadows the first.
   */
  async function upsertForOrganization(
    organizationId: string,
    values: AgentConfigUpsert,
  ): Promise<Selectable<DB["agentConfig"]>> {
    return await db
      .insertInto("agentConfig")
      .values({
        id: v7(),
        scope: "organization",
        organizationId,
        projectId: null,
        agentCredentialId: values.agentCredentialId ?? null,
        useSproutosCredits: values.useSproutosCredits ?? false,
        model: values.model ?? null,
        maxBudgetMicroUsd: values.maxBudgetMicroUsd ?? null,
        permissionMode: values.permissionMode ?? "default",
      })
      .onConflict((oc) =>
        oc
          .column("organizationId")
          .where("scope", "=", "organization")
          .doUpdateSet({ ...values, updatedAt: new Date() }),
      )
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function upsertForProject(
    projectId: string,
    values: AgentConfigUpsert,
  ): Promise<Selectable<DB["agentConfig"]>> {
    return await db
      .insertInto("agentConfig")
      .values({
        id: v7(),
        scope: "project",
        organizationId: null,
        projectId,
        agentCredentialId: values.agentCredentialId ?? null,
        useSproutosCredits: values.useSproutosCredits ?? false,
        model: values.model ?? null,
        maxBudgetMicroUsd: values.maxBudgetMicroUsd ?? null,
        permissionMode: values.permissionMode ?? "default",
      })
      .onConflict((oc) =>
        oc
          .column("projectId")
          .where("scope", "=", "project")
          .doUpdateSet({ ...values, updatedAt: new Date() }),
      )
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { upsertForOrganization, upsertForProject }
}

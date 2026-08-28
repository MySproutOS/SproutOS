import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export type StatementLineRow = Pick<
  Selectable<DB["statementLineItem"]>,
  | "id"
  | "kind"
  | "dimension"
  | "quantity"
  | "unitMicroUsd"
  | "amountMicroUsd"
  | "description"
  | "projectId"
> & { projectName: string | null }

export function fetchStatement(db: Kysely<DB>) {
  async function getForOrganization<T extends (keyof DB["statement"])[]>(
    organizationId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["statement"]>, T[number]> | undefined> {
    return await db
      .selectFrom("statement")
      .select(fields)
      .where("id", "=", id)
      .where("organizationId", "=", organizationId)
      .where("status", "!=", "void")
      .executeTakeFirst()
  }

  async function listForOrganization<T extends (keyof DB["statement"])[]>(
    organizationId: string,
    fields: T,
    limit = 24,
  ): Promise<Pick<Selectable<DB["statement"]>, T[number]>[]> {
    return await db
      .selectFrom("statement")
      .select(fields)
      .where("organizationId", "=", organizationId)
      .where("status", "!=", "void")
      .orderBy("periodStart", "desc")
      .limit(limit)
      .execute()
  }

  async function listLineItems(statementId: string): Promise<StatementLineRow[]> {
    return await db
      .selectFrom("statementLineItem")
      .leftJoin("project", "project.id", "statementLineItem.projectId")
      .select([
        "statementLineItem.id",
        "statementLineItem.kind",
        "statementLineItem.dimension",
        "statementLineItem.quantity",
        "statementLineItem.unitMicroUsd",
        "statementLineItem.amountMicroUsd",
        "statementLineItem.description",
        "statementLineItem.projectId",
        "project.name as projectName",
      ])
      .where("statementLineItem.statementId", "=", statementId)
      .orderBy("statementLineItem.kind", "desc")
      .orderBy("project.name", "asc")
      .orderBy("statementLineItem.dimension", "asc")
      .execute()
  }

  return { getForOrganization, listForOrganization, listLineItems }
}

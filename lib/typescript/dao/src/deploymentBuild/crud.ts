import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export function crudDeploymentBuild(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["deploymentBuild"]>, "id">,
  ): Promise<Selectable<DB["deploymentBuild"]>> {
    return await db
      .insertInto("deploymentBuild")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * No `updatedAt`: `deployment_build` has no such column, deliberately. A build is an append-only
   * record of one attempt — it starts, it finishes, and the row is never revised afterwards.
   */
  async function update(
    id: string,
    data: Updateable<DB["deploymentBuild"]>,
  ): Promise<Selectable<DB["deploymentBuild"]> | undefined> {
    return await db
      .updateTable("deploymentBuild")
      .set(data)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, update }
}

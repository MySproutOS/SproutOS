import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

/**
 * `sandbox` — one dev environment per (project, user).
 *
 * The table has existed since the init migration, with `pod_name`, `namespace`, `runtime_class`,
 * `idle_timeout_s` and `always_on` on it, and nothing in the repository read or wrote a single row.
 * `sandbox:read` and `sandbox:write` were in the action catalogue guarding nothing.
 */

/** `sandbox.state`, matching the CHECK constraint. */
export type SandboxState = "starting" | "running" | "stopping" | "stopped" | "error"

export function crudSandbox(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["sandbox"]>, "id">,
  ): Promise<Selectable<DB["sandbox"]>> {
    return await db
      .insertInto("sandbox")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function update(
    id: string,
    values: Partial<Insertable<DB["sandbox"]>>,
  ): Promise<Selectable<DB["sandbox"]> | undefined> {
    return await db
      .updateTable("sandbox")
      .set({ ...values, updatedAt: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  /**
   * Stamp the sandbox as used.
   *
   * Every file read, every command, every status poll. The reaper stops a sandbox that has been
   * idle for `idle_timeout_s`, and "idle" has to mean *nobody is using it* rather than *nothing has
   * been written* — a person reading code for twenty minutes is using it.
   *
   * A bare UPDATE rather than a read-modify-write: two operations at once are the normal case, and
   * the value is a timestamp where the later writer is always the right answer.
   */
  async function touch(id: string): Promise<void> {
    await db
      .updateTable("sandbox")
      .set({ lastActivityAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .execute()
  }

  async function remove(id: string): Promise<void> {
    await db.deleteFrom("sandbox").where("id", "=", id).execute()
  }

  return { create, update, touch, remove }
}

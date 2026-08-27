import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

/**
 * `sandbox` — one dev environment per (project, user).
 *
 * The table has existed since the init migration and, for most of that time, nothing in the
 * repository read or wrote a single row: `sandbox:read` and `sandbox:write` were in the action
 * catalogue guarding nothing. It was written for Knative and Kata, and ADR 0026 deleted the cluster
 * underneath it.
 *
 * `2026_09_23_00_00_00_sandbox_provider` repointed it at a rented provider. The row is now the
 * control plane's half of a sandbox — who owns it, what it costs, when it was last used — while the
 * provider holds the container. `external_id` is the join between the two, and it is null for the
 * window between insert and create, deliberately: a create that dies mid-flight leaves a row that
 * is still attributable and still reapable rather than an orphan nobody bills.
 */

/**
 * `sandbox.state`. The values `sandbox_state_check` permits, and only those.
 *
 * The first version of this line read `"starting" | "running" | "stopping" | "stopped" | "error"`
 * under a comment saying it matched the CHECK constraint. It did not: the constraint permits
 * `idle` and `failed`, which the union omitted, and does not permit `stopping` or `error`, which
 * the union invented. So the compiler accepted `state: "error"` in the pod-create failure path,
 * agreed it was valid, and the database rejected it at runtime — inside a `catch`, where the
 * constraint violation then replaced the error being handled.
 *
 * A comment claiming two things match is not a check that they do. Declared as an array so it can
 * be one: `fetch.test.ts` compares this to `pg_constraint` in both directions.
 */
export const SANDBOX_STATES = [
  "starting",
  "running",
  "idle",
  "stopped",
  "failed",
  "deleting",
] as const

export type SandboxState = (typeof SANDBOX_STATES)[number]

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

  async function createIfAbsent(
    data: PartialBy<Insertable<DB["sandbox"]>, "id">,
  ): Promise<Selectable<DB["sandbox"]> | undefined> {
    return await db
      .insertInto("sandbox")
      .values({ id: v7(), ...data })
      .onConflict((oc) => oc.columns(["projectId", "userId"]).doNothing())
      .returningAll()
      .executeTakeFirst()
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

  async function updateIfState(
    id: string,
    states: readonly SandboxState[],
    values: Partial<Insertable<DB["sandbox"]>>,
  ): Promise<Selectable<DB["sandbox"]> | undefined> {
    return await db
      .updateTable("sandbox")
      .set({ ...values, updatedAt: new Date() })
      .where("id", "=", id)
      .where("state", "in", [...states])
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

  return { create, createIfAbsent, update, updateIfState, touch, remove }
}

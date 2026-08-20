import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import { v7 } from "uuid"

export type ProjectEnvVarTarget = "production" | "preview" | "development" | "all"

/**
 * The three columns of the standard envelope convention, as the DAO receives them.
 *
 * Sealing happens in the API layer, not here: `@lib/dao` has no KMS dependency and gains nothing
 * from one. What this layer guarantees is narrower and more useful — that a plaintext value never
 * reaches a column, because there is no column for it to reach.
 */
export type SealedEnvValue = {
  ciphertext: string
  wrappedDek: string
  kmsKeyId: string
}

export function crudProjectEnvVar(db: Kysely<DB>) {
  /**
   * Creates or replaces one variable.
   *
   * `(project_id, key, target)` is unique, and setting a variable that already exists is the
   * common case rather than an error — so this is an upsert. A re-seal produces different bytes
   * for the same plaintext, which is exactly what should be written: rotation and re-encryption
   * are the same operation as an edit.
   */
  async function upsert(input: {
    projectId: string
    key: string
    target: ProjectEnvVarTarget
    isSecret: boolean
    value: SealedEnvValue
  }): Promise<Selectable<DB["projectEnvVar"]>> {
    return await db
      .insertInto("projectEnvVar")
      .values({
        id: v7(),
        projectId: input.projectId,
        key: input.key,
        target: input.target,
        isSecret: input.isSecret,
        valueCiphertext: input.value.ciphertext,
        valueWrappedDek: input.value.wrappedDek,
        valueKmsKeyId: input.value.kmsKeyId,
      })
      .onConflict((oc) =>
        oc.columns(["projectId", "key", "target"]).doUpdateSet({
          isSecret: input.isSecret,
          valueCiphertext: input.value.ciphertext,
          valueWrappedDek: input.value.wrappedDek,
          valueKmsKeyId: input.value.kmsKeyId,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * Hard delete, deliberately. `project_env_var` is not referenced by `usage_event` and holds a
   * live secret; a soft-deleted row would keep a decryptable value in the table after the user
   * asked for it to be gone.
   */
  async function remove(projectId: string, id: string): Promise<boolean> {
    const result = await db
      .deleteFrom("projectEnvVar")
      .where("id", "=", id)
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    return Number(result.numDeletedRows) > 0
  }

  async function removeAllForProject(projectId: string): Promise<number> {
    const result = await db
      .deleteFrom("projectEnvVar")
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    return Number(result.numDeletedRows)
  }

  return { remove, removeAllForProject, upsert }
}

import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import { v7 } from "uuid"

export type ProjectFileTarget = "production" | "preview" | "development" | "all"

/**
 * The three columns of the standard envelope convention, as the DAO receives them.
 *
 * Sealing happens above this layer: `@lib/dao` has no KMS dependency and gains nothing from one.
 * What this layer guarantees is narrower and more useful — that plaintext contents never reach a
 * column, because there is no column for them to reach.
 */
export type SealedFileContents = {
  ciphertext: string
  wrappedDek: string
  kmsKeyId: string
}

export function crudProjectFile(db: Kysely<DB>) {
  /**
   * Creates or replaces one file.
   *
   * `(project_id, path, target)` is unique, and writing a file that already exists is the common
   * case rather than an error — editing a config file is what a customer does most. A re-seal
   * produces different bytes for the same contents, which is what should be written: rotation and
   * an edit are the same operation.
   */
  async function upsert(input: {
    projectId: string
    path: string
    target: ProjectFileTarget
    isSecret: boolean
    contents: SealedFileContents
  }): Promise<Selectable<DB["projectFile"]>> {
    return await db
      .insertInto("projectFile")
      .values({
        id: v7(),
        projectId: input.projectId,
        path: input.path,
        target: input.target,
        isSecret: input.isSecret,
        contentsCiphertext: input.contents.ciphertext,
        contentsWrappedDek: input.contents.wrappedDek,
        contentsKmsKeyId: input.contents.kmsKeyId,
      })
      .onConflict((oc) =>
        oc.columns(["projectId", "path", "target"]).doUpdateSet({
          isSecret: input.isSecret,
          contentsCiphertext: input.contents.ciphertext,
          contentsWrappedDek: input.contents.wrappedDek,
          contentsKmsKeyId: input.contents.kmsKeyId,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * Hard delete, deliberately. `project_file` is not referenced by `usage_event` and holds live
   * secrets; a soft-deleted row would keep decryptable contents in the table after the customer
   * asked for them to be gone.
   */
  async function remove(projectId: string, id: string): Promise<boolean> {
    const result = await db
      .deleteFrom("projectFile")
      .where("id", "=", id)
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    return Number(result.numDeletedRows) > 0
  }

  async function removeAllForProject(projectId: string): Promise<number> {
    const result = await db
      .deleteFrom("projectFile")
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    return Number(result.numDeletedRows)
  }

  return { remove, removeAllForProject, upsert }
}

import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

/**
 * Reading `project_file`, split the same way `project_env_var` is: metadata by default, ciphertext
 * only through a function named after what it does.
 *
 * The split is the point. Nothing that lists files can reach the sealed columns by passing a longer
 * field array, because there is no field array to lengthen.
 */
export const FILE_METADATA_FIELDS = [
  "id",
  "path",
  "target",
  "isSecret",
  "createdAt",
  "updatedAt",
] as const

export type FileMetadataRow = {
  id: string
  path: string
  target: string
  isSecret: boolean
  createdAt: Date
  updatedAt: Date
}

export type SealedFileRow = {
  id: string
  path: string
  target: string
  isSecret: boolean
  contentsCiphertext: string
  contentsWrappedDek: string
  contentsKmsKeyId: string
}

const SEALED_FIELDS = [
  "id",
  "path",
  "target",
  "isSecret",
  "contentsCiphertext",
  "contentsWrappedDek",
  "contentsKmsKeyId",
] as const

export function fetchProjectFile(db: Kysely<DB>) {
  async function listForProject(projectId: string): Promise<FileMetadataRow[]> {
    return await db
      .selectFrom("projectFile")
      .select([...FILE_METADATA_FIELDS])
      .where("projectId", "=", projectId)
      .orderBy("path", "asc")
      .orderBy("target", "asc")
      .execute()
  }

  async function getMetadata(projectId: string, id: string): Promise<FileMetadataRow | undefined> {
    return await db
      .selectFrom("projectFile")
      .select([...FILE_METADATA_FIELDS])
      .where("id", "=", id)
      .where("projectId", "=", projectId)
      .executeTakeFirst()
  }

  /** One file's ciphertext, so the caller can decrypt it. Separate RBAC action at the route. */
  async function getSealed(projectId: string, id: string): Promise<SealedFileRow | undefined> {
    return await db
      .selectFrom("projectFile")
      .select([...SEALED_FIELDS])
      .where("id", "=", id)
      .where("projectId", "=", projectId)
      .executeTakeFirst()
  }

  /**
   * The whole sealed set for one deployment target.
   *
   * `all` plus the target's own kind, exactly as environment variables resolve — a preview gets the
   * preview files and the shared ones, and production's config stays out of a build triggered by
   * anyone with a fork.
   *
   * Ordered by path, so the digest the deploy path takes over these is stable. Without a total order
   * the same set comes back differently and every deploy cuts a new revision.
   */
  async function listSealedForProject(
    projectId: string,
    target: string | null = null,
  ): Promise<SealedFileRow[]> {
    return await db
      .selectFrom("projectFile")
      .select([...SEALED_FIELDS])
      .where("projectId", "=", projectId)
      .$if(target !== null, (qb) => qb.where("target", "in", [target!, "all"]))
      .orderBy("path", "asc")
      .execute()
  }

  async function countForProject(projectId: string): Promise<number> {
    const row = await db
      .selectFrom("projectFile")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    return row ? Number(row.count) : 0
  }

  return { countForProject, getMetadata, getSealed, listForProject, listSealedForProject }
}

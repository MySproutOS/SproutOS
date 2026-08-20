import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

/**
 * The columns a listing may ever select.
 *
 * The three ciphertext columns are absent, and that is the point: "no plaintext in a list" is not
 * a convention the route is trusted to follow, it is the shape of the only function the route can
 * call.
 *
 * This is the one place in the DAO layer that does not take a caller-chosen `fields` array. The
 * generic pattern exists so a caller asks for exactly what it needs; here the whole set is seven
 * small columns and letting the caller name them would mean letting the caller name
 * `valueCiphertext`. Reading a value takes a different function, and that one is audited.
 */
export const ENV_VAR_METADATA_FIELDS = [
  "id",
  "key",
  "target",
  "isSecret",
  "valueKmsKeyId",
  "createdAt",
  "updatedAt",
] as const

export type EnvVarMetadataRow = {
  id: string
  key: string
  target: string
  isSecret: boolean
  valueKmsKeyId: string
  createdAt: Date
  updatedAt: Date
}

export type SealedEnvVarRow = {
  id: string
  key: string
  target: string
  isSecret: boolean
  valueCiphertext: string
  valueWrappedDek: string
  valueKmsKeyId: string
}

const SEALED_FIELDS = [
  "id",
  "key",
  "target",
  "isSecret",
  "valueCiphertext",
  "valueWrappedDek",
  "valueKmsKeyId",
] as const

export function fetchProjectEnvVar(db: Kysely<DB>) {
  async function listForProject(projectId: string): Promise<EnvVarMetadataRow[]> {
    return await db
      .selectFrom("projectEnvVar")
      .select([...ENV_VAR_METADATA_FIELDS])
      .where("projectId", "=", projectId)
      .orderBy("key", "asc")
      .orderBy("target", "asc")
      .execute()
  }

  async function getMetadata(
    projectId: string,
    id: string,
  ): Promise<EnvVarMetadataRow | undefined> {
    return await db
      .selectFrom("projectEnvVar")
      .select([...ENV_VAR_METADATA_FIELDS])
      .where("id", "=", id)
      .where("projectId", "=", projectId)
      .executeTakeFirst()
  }

  /**
   * Reads one variable's ciphertext so the caller can decrypt it.
   *
   * Separate function, separate name, separate RBAC action at the route. Nothing that lists
   * variables can reach these columns by passing a longer field array, because there is no field
   * array to lengthen.
   */
  async function getSealed(projectId: string, id: string): Promise<SealedEnvVarRow | undefined> {
    return await db
      .selectFrom("projectEnvVar")
      .select([...SEALED_FIELDS])
      .where("id", "=", id)
      .where("projectId", "=", projectId)
      .executeTakeFirst()
  }

  /** The whole sealed set, for the deploy path that has to materialize an environment. */
  async function listSealedForProject(
    projectId: string,
    target: string | null = null,
  ): Promise<SealedEnvVarRow[]> {
    return await db
      .selectFrom("projectEnvVar")
      .select([...SEALED_FIELDS])
      .where("projectId", "=", projectId)
      .$if(target !== null, (qb) => qb.where("target", "in", [target!, "all"]))
      .orderBy("key", "asc")
      .execute()
  }

  async function countForProject(projectId: string): Promise<number> {
    const row = await db
      .selectFrom("projectEnvVar")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("projectId", "=", projectId)
      .executeTakeFirst()

    return row ? Number(row.count) : 0
  }

  return { countForProject, getMetadata, getSealed, listForProject, listSealedForProject }
}

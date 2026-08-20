import type { Kysely } from "kysely"
import { uuidV7 } from "../lib/uuid"

const REGIONS: [code: string, displayName: string, isActive: boolean][] = [
  ["us-east-1", "US East (N. Virginia)", true],
  ["us-west-2", "US West (Oregon)", false],
  ["eu-west-1", "Europe (Ireland)", false],
]

export async function seed(db: Kysely<any>): Promise<void> {
  await db
    .insertInto("region")
    .values(
      REGIONS.map(([code, display_name, is_active]) => ({
        id: uuidV7(),
        code,
        display_name,
        is_active,
      })),
    )
    .onConflict((oc) => oc.column("code").doNothing())
    .execute()
}

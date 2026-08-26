import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"
import { v7 } from "uuid"
import type { Bucket } from "./rollup"

export const CLICKHOUSE_METERING_CONSUMER = "clickhouse-usage-rollup-v1"

export type ImportedUsageRollup = {
  organizationId: string
  projectId: string | null
  dimension: string
  bucket: Bucket
  bucketStart: Date
  /** Absolute totals from deduplicated ClickHouse rows, never deltas. */
  quantity: string
  externallyChargedQuantity: string
}

/**
 * Replace affected Postgres grains with ClickHouse's absolute totals and advance the cursor.
 *
 * Retrying this transaction is harmless: quantity is assigned, not added. The only additive field
 * is `charged_quantity`, and it receives the positive change in the separately tracked externally
 * settled subtotal. Ordinary charges already in that column therefore remain intact, while a hold
 * settlement is credited exactly once even if the same ClickHouse window is imported repeatedly.
 */
export async function applyImportedUsageRollups(
  db: Kysely<DB>,
  rows: ImportedUsageRollup[],
  cursor: Date,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insertInto("usageRollup")
        .values(
          rows.map((row) => ({
            id: v7(),
            organizationId: row.organizationId,
            projectId: row.projectId,
            dimension: row.dimension,
            bucket: row.bucket,
            bucketStart: row.bucketStart,
            quantity: row.quantity,
            chargedQuantity: row.externallyChargedQuantity,
            externallyChargedQuantity: row.externallyChargedQuantity,
          })),
        )
        .onConflict((oc) =>
          oc
            .columns(["organizationId", "projectId", "dimension", "bucket", "bucketStart"])
            .doUpdateSet({
              quantity: sql`excluded.quantity`,
              chargedQuantity: sql`
                usage_rollup.charged_quantity + greatest(
                  excluded.externally_charged_quantity -
                    usage_rollup.externally_charged_quantity,
                  0
                )
              `,
              externallyChargedQuantity: sql`excluded.externally_charged_quantity`,
              updatedAt: new Date(),
            }),
        )
        .execute()
    }

    await tx
      .insertInto("meteringImportState")
      .values({ consumer: CLICKHOUSE_METERING_CONSUMER, cursor })
      .onConflict((oc) => oc.column("consumer").doUpdateSet({ cursor, updatedAt: new Date() }))
      .execute()
  })
}

export async function importedUsageCursor(db: Kysely<DB>): Promise<Date | undefined> {
  return (
    await db
      .selectFrom("meteringImportState")
      .select("cursor")
      .where("consumer", "=", CLICKHOUSE_METERING_CONSUMER)
      .executeTakeFirst()
  )?.cursor
}

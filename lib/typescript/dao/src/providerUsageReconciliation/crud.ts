import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

export type ProviderUsageReconciliationInput = {
  id: string
  importedRequests: string
  observedAt: Date
  periodStart: Date
  provider: string
  providerRequests: string
  residualRequests: string
  resourceId: string
  status: "matched" | "pending_delivery" | "platform_overhead"
}

export function crudProviderUsageReconciliation(db: Kysely<DB>) {
  /**
   * Replace one provider observation absolutely.
   *
   * Both the CloudFront request metric and standard logs can be corrected after first delivery. Re-running a
   * closed day therefore replaces its totals; it never adds a delta and never emits tenant usage.
   */
  async function upsert(input: ProviderUsageReconciliationInput): Promise<void> {
    await db
      .insertInto("providerUsageReconciliation")
      .values(input)
      .onConflict((oc) =>
        oc.columns(["provider", "resourceId", "periodStart"]).doUpdateSet({
          importedRequests: input.importedRequests,
          observedAt: input.observedAt,
          providerRequests: input.providerRequests,
          residualRequests: input.residualRequests,
          status: input.status,
          updatedAt: input.observedAt,
        }),
      )
      .execute()
  }

  return { upsert }
}

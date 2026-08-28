import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

export type ProviderUsageReconciliationInput = {
  id: string
  importedEgressBytes: string
  importedRequests: string
  observedAt: Date
  periodStart: Date
  provider: string
  providerEgressBytes: string
  providerRequests: string
  residualEgressBytes: string
  residualRequests: string
  resourceId: string
  status: "matched" | "pending_delivery" | "platform_overhead"
}

export function crudProviderUsageReconciliation(db: Kysely<DB>) {
  /**
   * Replace one provider observation absolutely.
   *
   * Both CloudFront metrics and standard logs can be corrected after first delivery. Re-running a
   * closed day therefore replaces its totals; it never adds a delta and never emits tenant usage.
   */
  async function upsert(input: ProviderUsageReconciliationInput): Promise<void> {
    await db
      .insertInto("providerUsageReconciliation")
      .values(input)
      .onConflict((oc) =>
        oc.columns(["provider", "resourceId", "periodStart"]).doUpdateSet({
          importedEgressBytes: input.importedEgressBytes,
          importedRequests: input.importedRequests,
          observedAt: input.observedAt,
          providerEgressBytes: input.providerEgressBytes,
          providerRequests: input.providerRequests,
          residualEgressBytes: input.residualEgressBytes,
          residualRequests: input.residualRequests,
          status: input.status,
          updatedAt: input.observedAt,
        }),
      )
      .execute()
  }

  return { upsert }
}

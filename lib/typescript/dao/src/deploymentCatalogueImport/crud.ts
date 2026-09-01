/* oxlint-disable no-await-in-loop -- catalogue rows reconcile serially in one transaction */
import type { DB, Json } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { v7 } from "uuid"

export type CatalogueListingInput = {
  id: string
  name: string
  pitch: string
  descriptionMd: string
  homepage: string | null
  platform: "web" | "android"
  license: string
  upstreamOwner: string
  upstreamRepo: string
  upstreamRepoUrl: string
  upstreamCommit: string
  pluginRepository: string
  pluginDigest: string
  requiredCapabilities: string[]
  readiness: Json
  manifest: Json
  status: "draft" | "published" | "archived"
  verifiedAt: Date | null
}

export type ReconcileDeploymentCatalogueInput = {
  ociRepository: string
  ociDigest: string
  catalogueDigest: string
  sourceRepository: string
  workflowRef: string
  sourceRef: string
  sourceSha: string
  signatureIdentity: string
  signatureIssuer: string
  provenance: Json
  listings: CatalogueListingInput[]
}

export type CatalogueReconcileResult = {
  importId: string
  upserted: number
  archived: number
}

export function crudDeploymentCatalogueImport(db: Kysely<DB>) {
  async function reconcile(
    input: ReconcileDeploymentCatalogueInput,
  ): Promise<CatalogueReconcileResult> {
    return await db.transaction().execute(async (tx) => {
      // Multiple API/worker replicas may receive a publication and the daily replay together.
      // Serializing the complete snapshot prevents one transaction from archiving rows while the
      // other is still reconciling them. The lock is transaction-scoped and releases on rollback.
      await sql`select pg_advisory_xact_lock(hashtext('deployment-catalogue-reconcile'))`.execute(
        tx,
      )

      const importRow = await tx
        .insertInto("deploymentCatalogueImport")
        .values({
          id: v7(),
          ociRepository: input.ociRepository,
          ociDigest: input.ociDigest,
          catalogueDigest: input.catalogueDigest,
          sourceRepository: input.sourceRepository,
          workflowRef: input.workflowRef,
          sourceRef: input.sourceRef,
          sourceSha: input.sourceSha,
          signatureIdentity: input.signatureIdentity,
          signatureIssuer: input.signatureIssuer,
          provenance: JSON.stringify(input.provenance),
        })
        .onConflict((oc) =>
          oc.columns(["ociRepository", "ociDigest"]).doUpdateSet({
            lastReconciledAt: sql<Date>`now()`,
          }),
        )
        .returning("id")
        .executeTakeFirstOrThrow()

      const activeIds = new Set<string>()
      for (const listing of input.listings) {
        const matches = await tx
          .selectFrom("storeListing")
          .select([
            "id",
            "catalogueEntryId",
            "slug",
            "upstreamHost",
            "upstreamOwner",
            "upstreamRepo",
          ])
          .where("deletedAt", "is", null)
          .where((eb) =>
            eb.or([
              eb("catalogueEntryId", "=", listing.id),
              eb("slug", "=", listing.id),
              eb.and([
                eb("upstreamHost", "=", "github.com"),
                eb("upstreamOwner", "=", listing.upstreamOwner),
                eb("upstreamRepo", "=", listing.upstreamRepo),
              ]),
            ]),
          )
          .execute()
        const unique = new Map(matches.map((row) => [row.id, row]))
        if (unique.size > 1) {
          throw new Error(`catalogue listing ${listing.id} matches multiple existing store rows`)
        }
        const existing = unique.values().next().value
        if (
          existing !== undefined &&
          ((existing.catalogueEntryId !== null && existing.catalogueEntryId !== listing.id) ||
            existing.slug !== listing.id ||
            existing.upstreamHost !== "github.com" ||
            existing.upstreamOwner !== listing.upstreamOwner ||
            existing.upstreamRepo !== listing.upstreamRepo)
        ) {
          throw new Error(`catalogue listing ${listing.id} conflicts with existing store metadata`)
        }

        const values = {
          catalogueEntryId: listing.id,
          catalogueImportId: importRow.id,
          catalogueSchemaVersion: 1,
          catalogueManifest: JSON.stringify(listing.manifest),
          upstreamCommit: listing.upstreamCommit,
          templatePluginRepository: listing.pluginRepository,
          templatePluginDigest: listing.pluginDigest,
          requiredCapabilities: JSON.stringify(listing.requiredCapabilities),
          capabilityReadiness: JSON.stringify(listing.readiness),
          catalogueArchivedAt: listing.status === "archived" ? sql<Date>`now()` : null,
          capabilityVerifiedAt: listing.verifiedAt,
          e2eVerifiedAt: listing.verifiedAt,
          slug: listing.id,
          name: listing.name,
          tagline: listing.pitch,
          descriptionMd: listing.descriptionMd,
          homepageUrl: listing.homepage,
          licenseSpdx: listing.license,
          platform: listing.platform,
          upstreamHost: "github.com",
          upstreamOwner: listing.upstreamOwner,
          upstreamRepo: listing.upstreamRepo,
          upstreamRepoUrl: listing.upstreamRepoUrl,
          status: listing.status,
          ...(listing.platform !== "android" || listing.status !== "published"
            ? { canonicalAndroidAppId: null }
            : {}),
          reviewedAt: listing.verifiedAt,
          reviewedByUserId: null,
          rejectionReason: null,
          syncError: null,
          updatedAt: sql<Date>`now()`,
        }

        let id: string
        if (existing === undefined) {
          id = v7()
          await tx
            .insertInto("storeListing")
            .values({ id, ...values })
            .execute()
        } else {
          id = existing.id
          await tx.updateTable("storeListing").set(values).where("id", "=", id).execute()
        }
        activeIds.add(id)
      }

      const archived = await tx
        .updateTable("storeListing")
        .set({
          status: "archived",
          canonicalAndroidAppId: null,
          catalogueArchivedAt: sql<Date>`now()`,
          capabilityVerifiedAt: null,
          e2eVerifiedAt: null,
          updatedAt: sql<Date>`now()`,
        })
        .where("catalogueEntryId", "is not", null)
        .$if(activeIds.size > 0, (qb) => qb.where("id", "not in", [...activeIds]))
        .where("status", "!=", "archived")
        .executeTakeFirst()

      return {
        importId: importRow.id,
        upserted: input.listings.length,
        archived: Number(archived.numUpdatedRows),
      }
    })
  }

  return { reconcile }
}

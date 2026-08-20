import { analyzeRepository, InvalidManifestError, RepositoryUnavailableError } from "@lib/analyzer"
import { InsufficientBalanceError } from "@lib/billing"
import type { JobHandler } from "./worker"

export const ANALYSIS_KIND = "analysis.repository"

type AnalysisPayload = { analysisId: string }

/**
 * Run one repository analysis (TASKS 38 and 39).
 *
 * A job rather than a request handler because it takes about a minute — a clone, a walk, and a
 * model call over a large prompt. Holding an HTTP connection open for that is a timeout waiting to
 * happen, and the caller polls the row instead.
 *
 * Costs the requester money, so the row is marked `running` before the model is called and
 * `failed` with a reason afterwards. An analysis that vanished would be a charge with nothing to
 * show for it.
 */
export const analyzeRepositoryJob: JobHandler = async (job, { db }) => {
  const { analysisId } = job.payload as AnalysisPayload

  const analysis = await db
    .selectFrom("repoAnalysis")
    .select([
      "id",
      "organizationId",
      "upstreamHost",
      "upstreamOwner",
      "upstreamRepo",
      "ref",
      "status",
    ])
    .where("id", "=", analysisId)
    .executeTakeFirst()

  if (analysis === undefined) return
  // A retried job whose first attempt finished must not charge the customer twice.
  if (analysis.status === "succeeded") return

  await db
    .updateTable("repoAnalysis")
    .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
    .where("id", "=", analysisId)
    .execute()

  try {
    const result = await analyzeRepository(db, {
      analysisId,
      organizationId: analysis.organizationId,
      owner: analysis.upstreamOwner,
      repo: analysis.upstreamRepo,
      ref: analysis.ref,
      host: analysis.upstreamHost,
    })

    await db
      .updateTable("repoAnalysis")
      .set({
        status: "succeeded",
        manifest: JSON.stringify(result.manifest),
        confidence: result.confidence,
        commitSha: result.commitSha,
        costMicroUsd: result.chargedMicroUsd,
        error: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("id", "=", analysisId)
      .execute()
  } catch (error) {
    await db
      .updateTable("repoAnalysis")
      .set({
        status: "failed",
        error: describe(error),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where("id", "=", analysisId)
      .execute()

    throw error
  }
}

/**
 * Three failures a person can act on, and everything else.
 *
 * A raw error can carry a path on the runner or a fragment of a prompt, and "the analysis failed"
 * with no reason is a charge nobody can explain. These three cover what actually goes wrong.
 */
function describe(error: unknown): string {
  if (error instanceof RepositoryUnavailableError) return error.message
  if (error instanceof InsufficientBalanceError) {
    return "Not enough credit to analyse this repository. Add credit and try again."
  }
  if (error instanceof InvalidManifestError) {
    return "The model could not describe this repository well enough to deploy it."
  }
  console.warn("[analysis] failed", error)
  return "The analysis failed."
}

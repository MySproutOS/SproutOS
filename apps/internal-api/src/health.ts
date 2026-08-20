import { db } from "@sproutos/db"
import { Hono } from "hono"
import { sql } from "kysely"

/**
 * Liveness and readiness, deliberately split.
 *
 * Kubernetes treats the two probes very differently and the difference is the whole reason this
 * file exists. A failed **liveness** probe kills the container. A failed **readiness** probe only
 * takes the pod out of the Service's endpoint list.
 *
 * So liveness must never check a dependency. If `/health` ran `SELECT 1`, a thirty-second Postgres
 * blip would restart every API pod at once, and each replacement would fail its own probe while
 * the database was still recovering — a recoverable database incident turned into a fleet-wide
 * crash loop that outlives its own cause. Liveness answers exactly one question: is this process
 * still able to serve a request at all?
 *
 * Readiness is where the dependency check belongs, because removing a pod from rotation is
 * reversible the moment the dependency returns.
 */
const health = new Hono()

/** Long enough that a loaded pool is not called dead; short enough to beat the probe's own timeout. */
const READY_TIMEOUT_MS = 2_000

health.get("/health", (c) => c.json({ status: "ok" }))

health.get("/ready", async (c) => {
  let timer: NodeJS.Timeout | undefined

  try {
    await Promise.race([
      sql`select 1`.execute(db),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("timed out"))
        }, READY_TIMEOUT_MS)
        // Without unref a pending probe timer holds the event loop open and delays shutdown.
        timer.unref()
      }),
    ])
  } catch (error) {
    // 503 rather than 500: this is "not ready", a state the pod is expected to leave.
    return c.json(
      { status: "unready", reason: error instanceof Error ? error.message : "unknown" },
      503,
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  return c.json({ status: "ok" })
})

export default health

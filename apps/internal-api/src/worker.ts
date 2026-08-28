import { handlersForWorkerProfile, parseWorkerFlag, scheduleRecurring, work } from "@lib/jobs"
import { db } from "@sproutos/db"
import { hostname } from "node:os"

/**
 * The background job worker.
 *
 * A separate process from the API on purpose. A long job holding an event-loop turn inside the API
 * process delays every request behind it, and a worker that needs restarting should not take the
 * API down with it. Both read the same table; nothing else coordinates them.
 */
const profile = process.env.WORKER_PROFILE ?? "platform"
if (profile !== "platform" && profile !== "acme") {
  throw new Error("WORKER_PROFILE must be platform or acme")
}
const isolatedAcmeHandlerOwnershipEnabled = parseWorkerFlag(
  "ACME_HANDLER_OWNERSHIP_ENABLED",
  process.env.ACME_HANDLER_OWNERSHIP_ENABLED,
)
const handlers = handlersForWorkerProfile(profile, isolatedAcmeHandlerOwnershipEnabled)
const workerId = `${profile}:${hostname()}:${process.pid}`
const controller = new AbortController()

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`[worker] ${signal}, finishing the current job`)
  controller.abort()
  // The loop checks the signal between jobs, so an in-flight handler runs to completion rather
  // than leaving a lease to expire. The timer is the backstop for one that will not stop.
  setTimeout(() => {
    console.error("[worker] shutdown stalled, forcing exit")
    process.exit(1)
  }, 30_000).unref()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

if (process.env.NODE_ENV === "production") {
  // Fail at task boot, not after services have been bought and a repository has been forked. The
  // API shares this bundle but never imports the addon; only the worker owns template execution.
  const { nativeRuntimeStatus } = await import("@sproutos/sprout-node")
  const runtime = nativeRuntimeStatus()
  console.log(`[worker] native templates available for ${runtime.pluginTarget}`)
}

console.log(`[worker] ${workerId} started`)

// Recurring work is scheduled by the worker itself, keyed on the window it belongs to, so there is
// no cron process to run and no second place for work to get stuck. Every worker calls this and
// all but one insert nothing.
const scheduler =
  profile === "platform"
    ? setInterval(() => {
        void scheduleRecurring(db).catch((error: unknown) => {
          console.warn("[worker] could not schedule recurring jobs", error)
        })
      }, 60_000)
    : undefined
if (profile === "platform") await scheduleRecurring(db)

await work(db, {
  workerId,
  handlers,
  signal: controller.signal,
  onEvent: (event) => {
    if (event.type === "failed") {
      console.warn(`[worker] ${event.job.kind} ${event.outcome}`, event.error)
    } else if (event.type === "reclaimed") {
      console.warn(`[worker] reclaimed ${event.count} abandoned job(s)`)
    }
  },
})

if (scheduler !== undefined) clearInterval(scheduler)
await db.destroy()
console.log("[worker] stopped")

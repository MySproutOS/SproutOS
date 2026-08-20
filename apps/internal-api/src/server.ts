import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import app from "./index"

/**
 * The production entry point.
 *
 * `dev-server.ts` carried a comment saying "production runs this app as a container on EKS with its
 * own entrypoint" — and that entrypoint did not exist. `src/index.ts` exports the Hono app and does
 * not listen, so the container built from it started, did nothing, and exited 0. A healthy-looking
 * exit code, no logs, and no server: the failure mode a readiness probe would eventually catch and
 * nothing else would explain.
 *
 * Separate from `dev-server.ts` rather than shared, because the two differ in the part that matters:
 * a dev server should die fast when `turbo` tears it down, and this one must not.
 */
const port = Number(process.env.API_PORT) || 3001

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.info(JSON.stringify({ level: "info", message: "listening", port: info.port }))
})

/**
 * Stop accepting connections, then let in-flight requests finish.
 *
 * Kubernetes sends `SIGTERM` and removes the pod from the endpoints list *concurrently*, so requests
 * can still arrive for a moment after the signal. Exiting immediately would fail them — and the
 * client seeing that failure is a customer, not a health check.
 *
 * The 25-second cap sits under the pod's 30-second default grace period, so the process chooses its
 * own exit rather than being killed mid-request.
 */
const shutdown = (signal: NodeJS.Signals) => {
  console.info(JSON.stringify({ level: "info", message: "shutting down", signal }))

  const forced = setTimeout(() => {
    console.error(JSON.stringify({ level: "error", message: "shutdown stalled; forcing exit" }))
    process.exit(1)
  }, 25_000)
  // Unreferenced so a clean shutdown is not held open by this timer alone.
  forced.unref()

  server.close((error) => {
    if (error) {
      console.error(
        JSON.stringify({ level: "error", message: "shutdown failed", error: String(error) }),
      )
      process.exit(1)
    }
    process.exit(0)
  })

  /*
    Idle keep-alive connections are closed; in-flight ones are left alone.

    `closeAllConnections` would kill both, which is what `dev-server.ts` does deliberately and what
    this must not do — that is the difference between a rolling deploy nobody notices and one that
    returns a handful of 502s each time.
  */
  ;(server as Server).closeIdleConnections()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

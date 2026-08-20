import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import app from "./index"

// Local-only entrypoint. Production is Vercel's zero-config Hono backend, which imports the
// default export of `src/index.ts` directly and binds the port itself. Deliberately not named
// `src/server.ts` — that filename is one Vercel auto-detects as the app entrypoint.
const port = Number(process.env.API_PORT) || 3001

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Listening on http://localhost:${info.port}`)
})

// turbo tears down `dev` processes fast enough that Node otherwise lingers on open connections.
const shutdown = (signal: NodeJS.Signals) => {
  console.log(`Received ${signal}, shutting down...`)
  setTimeout(() => {
    console.error("Shutdown stalled, forcing exit")
    process.exit(1)
  }, 500).unref()
  server.close((err) => {
    if (err) {
      console.error("Error during shutdown:", err)
      process.exit(1)
    }
    process.exit(0)
  })
  ;(server as Server).closeAllConnections()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

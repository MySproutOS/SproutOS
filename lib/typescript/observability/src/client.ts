import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient, type ClickHouseClient } from "@clickhouse/client"
import dotenv from "dotenv"

// The same thing `@sproutos/db` does, for the same reason: a process that reaches this package
// without having loaded the root `.env` — a test runner, a one-off script — would otherwise find
// `CLICKHOUSE_URL` unset and conclude the store is not configured.
dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../.env"),
  quiet: true,
})

/**
 * The connection to the log store.
 *
 * One client per process, created on first use. `@clickhouse/client` keeps a keep-alive HTTP agent
 * underneath, so building a new one per request would open a new socket per log query and leave the
 * old ones to time out.
 */
let client: ClickHouseClient | undefined

export function observabilityConfigured(): boolean {
  return (process.env.CLICKHOUSE_URL ?? "") !== ""
}

export function clickhouse(): ClickHouseClient {
  if (client !== undefined) return client

  const url = process.env.CLICKHOUSE_URL
  if (url === undefined || url === "") {
    throw new Error("CLICKHOUSE_URL is not set; the observability service cannot store anything")
  }

  client = createClient({
    url,
    database: process.env.CLICKHOUSE_DATABASE ?? "observability",
    ...(process.env.CLICKHOUSE_USER === undefined ? {} : { username: process.env.CLICKHOUSE_USER }),
    ...(process.env.CLICKHOUSE_PASSWORD === undefined
      ? {}
      : { password: process.env.CLICKHOUSE_PASSWORD }),
    clickhouse_settings: {
      /*
        Batch on the server rather than in this process.

        A tenant's exporter sends small batches often, and one INSERT per batch on a MergeTree
        creates one part per batch — thousands of tiny parts that the merge scheduler then has to
        work through, which is the classic way to make ClickHouse fall over. `async_insert` has the
        server accumulate them instead.

        `wait_for_async_insert` is 1, so the ingest endpoint does not acknowledge a batch until it
        is durable. Acknowledging earlier would be faster and would mean telling a customer their
        logs were stored when they might not be.
      */
      async_insert: 1,
      wait_for_async_insert: 1,
    },
  })
  return client
}

/** For tests and for shutdown. The next call to `clickhouse()` builds a fresh client. */
export async function closeClickhouse(): Promise<void> {
  await client?.close()
  client = undefined
}

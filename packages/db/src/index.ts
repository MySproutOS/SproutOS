import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely"
import { Pool } from "pg"
import type { DB } from "./types"

const currentFile = fileURLToPath(import.meta.url)
const currentDir = path.dirname(currentFile)

dotenv.config({ path: `${currentDir}/../../../.env`, quiet: true })

const poolMax = Number(process.env.DATABASE_POOL_MAX ?? "4")
if (!Number.isSafeInteger(poolMax) || poolMax < 1) {
  throw new Error("DATABASE_POOL_MAX must be a positive integer")
}

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString: process.env.DATABASE_URL,
    // Three processes run in each ECS task (website, API and worker), while the router has its own
    // control-plane pools. Ten per process let two web tasks reserve sixty connections before a
    // migration or router boot asked for one.
    max: poolMax,
  }),
})

export const db = new Kysely<DB>({
  dialect,
  plugins: [new CamelCasePlugin()],
})

export type { DB, Json, JsonArray, JsonObject, JsonPrimitive, JsonValue } from "./types"

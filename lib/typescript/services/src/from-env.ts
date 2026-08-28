import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { neonPostgresDriverFromEnv } from "./neon-postgres"
import { objectStorageDriverFromEnv } from "./object-storage"
import { sproutPostgresConfigFromEnv, sproutPostgresDriver } from "./postgres"
import { searchDriver, searchServiceConfigFromEnv } from "./search"
import { ServiceKindUnavailableError, type ServiceDriver } from "./types"
import { valkeyDriver, valkeyServiceConfigFromEnv } from "./valkey"

/** The production driver selection shared by the API and background catalogue worker. */
export function serviceDriverFromEnv(db: Kysely<DB>, kind: string): ServiceDriver {
  if (kind === "postgres") {
    return process.env.SERVICE_POSTGRES_PROVIDER === "neon"
      ? neonPostgresDriverFromEnv(db)
      : sproutPostgresDriver(db, sproutPostgresConfigFromEnv())
  }
  if (kind === "valkey") return valkeyDriver(db, valkeyServiceConfigFromEnv())
  if (kind === "elasticsearch") return searchDriver(db, searchServiceConfigFromEnv())
  if (kind === "object_storage") return objectStorageDriverFromEnv(db)
  throw new ServiceKindUnavailableError(kind)
}

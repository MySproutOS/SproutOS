import { usePlaceholderQuery } from "@frontends/dashboard/data/placeholder"

export type DatabaseEngine = "postgres" | "valkey" | "opensearch"

export type DatabaseStatus = "ready" | "sleeping" | "provisioning"

export type ManagedDatabase = {
  id: string
  name: string
  engine: DatabaseEngine
  status: DatabaseStatus
  project: string
  size: string
  region: string
  costMicros: bigint
}

export const ENGINE_LABELS: Record<DatabaseEngine, string> = {
  postgres: "Postgres",
  valkey: "Valkey",
  opensearch: "OpenSearch",
}

export const DATABASE_STATUS_LABELS: Record<DatabaseStatus, string> = {
  ready: "Ready",
  sleeping: "Sleeping",
  provisioning: "Provisioning",
}

/** PLACEHOLDER — swap for `getV1OrganizationByOrgSlugDatabaseOptions(...)`. */
export function useDatabases(orgSlug: string) {
  const databases: ManagedDatabase[] = [
    {
      id: "db_01j8recipes",
      name: "recipes",
      engine: "postgres",
      status: "ready",
      project: "Recipe Box",
      size: "412 MB",
      region: "us-east-1",
      costMicros: 110_000n,
    },
    {
      id: "db_01j8messages",
      name: "messages",
      engine: "opensearch",
      status: "ready",
      project: "Message Search",
      size: "2.0 GB",
      region: "us-east-1",
      costMicros: 470_000n,
    },
    {
      id: "db_01j8queue",
      name: "followup-queue",
      engine: "valkey",
      status: "sleeping",
      project: "Client Follow-ups",
      size: "38 MB",
      region: "us-east-1",
      costMicros: 20_000n,
    },
  ]
  return usePlaceholderQuery(["organizations", orgSlug, "databases"], databases)
}

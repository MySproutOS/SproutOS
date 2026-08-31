import type { DB } from "@sproutos/db"
import { sql, type Kysely, type Selectable } from "kysely"

/**
 * Reads of `sandbox`, always scoped by organization.
 *
 * A sandbox holds a checkout of a customer's repository and a shell into it, so the id arriving
 * from a URL is the least trustworthy thing in the request. Every read joins through `project` to
 * the organization rather than trusting it.
 */
export function fetchSandbox(db: Kysely<DB>) {
  async function forForwardProxyAuthorization(id: string): Promise<
    | {
        id: string
        projectId: string
        organizationId: string
        state: string
      }
    | undefined
  > {
    return await db
      .selectFrom("sandbox")
      .innerJoin("project", "project.id", "sandbox.projectId")
      .select(["sandbox.id", "sandbox.projectId", "project.organizationId", "sandbox.state"])
      .where("sandbox.id", "=", id)
      .where("project.deletedAt", "is", null)
      .executeTakeFirst()
  }

  /** One user's sandbox for one project. The pair is the identity; there is at most one. */
  async function forUser(
    organizationId: string,
    projectId: string,
    userId: string,
  ): Promise<Selectable<DB["sandbox"]> | undefined> {
    return await db
      .selectFrom("sandbox")
      .innerJoin("project", "project.id", "sandbox.projectId")
      .selectAll("sandbox")
      .where("sandbox.projectId", "=", projectId)
      .where("sandbox.userId", "=", userId)
      .where("sandbox.purpose", "=", "development")
      .where("project.organizationId", "=", organizationId)
      .where("project.deletedAt", "is", null)
      .executeTakeFirst()
  }

  async function forUserForUpdate(
    organizationId: string,
    projectId: string,
    userId: string,
  ): Promise<Selectable<DB["sandbox"]> | undefined> {
    return await db
      .selectFrom("sandbox")
      .innerJoin("project", "project.id", "sandbox.projectId")
      .selectAll("sandbox")
      .where("sandbox.projectId", "=", projectId)
      .where("sandbox.userId", "=", userId)
      .where("sandbox.purpose", "=", "development")
      .where("project.organizationId", "=", organizationId)
      .where("project.deletedAt", "is", null)
      .forUpdate("sandbox")
      .executeTakeFirst()
  }

  async function getInOrganization(
    organizationId: string,
    id: string,
  ): Promise<Selectable<DB["sandbox"]> | undefined> {
    return await db
      .selectFrom("sandbox")
      .innerJoin("project", "project.id", "sandbox.projectId")
      .selectAll("sandbox")
      .where("sandbox.id", "=", id)
      .where("project.organizationId", "=", organizationId)
      .where("project.deletedAt", "is", null)
      .executeTakeFirst()
  }

  /**
   * Sandboxes the reaper should stop.
   *
   * The comparison is per-row — each sandbox carries its own `idle_timeout_s` — so it is written as
   * SQL rather than assembled from expression builders. `now() - interval '1 second' * idle_timeout_s`
   * says exactly what it means; the Kysely equivalent needed a cast and a fallback, and a query
   * nobody can read is a query nobody will notice going wrong.
   *
   * `always_on` is honoured here rather than by the caller, because a caller that forgets it stops
   * a customer's long-running environment and the symptom is "it keeps dying" with no error.
   */
  async function idle(): Promise<Selectable<DB["sandbox"]>[]> {
    return await db
      .selectFrom("sandbox")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([
            eb("state", "in", ["starting", "running"]),
            eb("alwaysOn", "=", false),
            sql<boolean>`last_activity_at < now() - (interval '1 second' * idle_timeout_s)`,
          ]),
          eb.and([eb("state", "=", "failed"), eb("externalId", "is not", null)]),
        ]),
      )
      .execute()
  }

  return { forForwardProxyAuthorization, forUser, forUserForUpdate, getInOrganization, idle }
}

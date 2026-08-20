import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import { v7 } from "uuid"

export type AuditEntry = {
  organizationId: string | null
  actorUserId: string | null
  action: string
  resourceSrn?: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
  userAgent?: string | null
}

function asJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

export function crudAuditLog(db: Kysely<DB>) {
  /**
   * Appends one audit row. Pass the transaction handle, not the pool: an audit row that commits
   * separately from the mutation it describes is either a lie or a gap.
   *
   * `before` and `after` are serialized here rather than handed to the driver as objects so that a
   * value the driver would coerce differently — a Date, a nested undefined — lands in `jsonb` the
   * same way every time. The table carries a `BEFORE UPDATE OR DELETE` trigger, so these rows can
   * never be rewritten afterwards.
   */
  async function record(entry: AuditEntry): Promise<Selectable<DB["auditLog"]>> {
    return await db
      .insertInto("auditLog")
      .values({
        id: v7(),
        organizationId: entry.organizationId,
        actorUserId: entry.actorUserId,
        action: entry.action,
        resourceSrn: entry.resourceSrn ?? null,
        before: asJson(entry.before),
        after: asJson(entry.after),
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return { record }
}

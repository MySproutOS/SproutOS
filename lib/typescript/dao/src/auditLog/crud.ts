import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"
import { v7 } from "uuid"

/**
 * The request-level part of an audit row: who was really at the keyboard, and from where.
 *
 * Defined here and imported by everything that forwards it, rather than restated where it is
 * needed. It had been restated once, in `provisionOrganization`, and that narrower copy silently
 * dropped `impersonatorUserId` — so an organization created during a support session was attributed
 * to the customer alone. One type is what stops the next field from going the same way.
 */
export type AuditContext = {
  ip?: string | null
  userAgent?: string | null
  impersonatorUserId?: string | null
}

export type AuditEntry = AuditContext & {
  organizationId: string | null
  actorUserId: string | null
  action: string
  resourceSrn?: string | null
  before?: unknown
  after?: unknown
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
        impersonatorUserId: entry.impersonatorUserId ?? null,
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

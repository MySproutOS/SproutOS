/**
 * Seeds run against `Kysely<any>`, because the generated `DB` type is produced *from* the very
 * migration the seeds sit beside — importing it would make the migrator depend on its own output.
 * These readers convert that `any` back into checked values at the boundary, so nothing
 * downstream of a query result is untyped.
 */

export type Row = Record<string, unknown>

export const asRows = (rows: unknown): Row[] => (Array.isArray(rows) ? (rows as Row[]) : [])

export const asRow = (row: unknown): Row | undefined =>
  typeof row === "object" && row !== null ? (row as Row) : undefined

export const text = (row: Row, key: string): string => {
  const value = row[key]
  if (typeof value !== "string") {
    throw new TypeError(`expected column "${key}" to be text, got ${typeof value}`)
  }
  return value
}

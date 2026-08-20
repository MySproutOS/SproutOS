import { randomBytes } from "node:crypto"

/**
 * App-supplied UUIDv7, per the SproutOS id convention.
 *
 * Seeds cannot depend on the workspace `uuid` catalog entry without adding a dependency to
 * `dbmigrator`, and the migrator is the one package that must stay installable on its own, so
 * the 30 lines live here instead. Application code uses `uuid`'s `v7()`.
 */
export const uuidV7 = (): string => {
  const bytes = randomBytes(16)
  const timestamp = BigInt(Date.now())

  bytes[0] = Number((timestamp >> 40n) & 0xffn)
  bytes[1] = Number((timestamp >> 32n) & 0xffn)
  bytes[2] = Number((timestamp >> 24n) & 0xffn)
  bytes[3] = Number((timestamp >> 16n) & 0xffn)
  bytes[4] = Number((timestamp >> 8n) & 0xffn)
  bytes[5] = Number(timestamp & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = bytes.toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-")
}

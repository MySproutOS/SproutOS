import { createHash } from "node:crypto"

/** Hash opaque S3 VersionIds before using them inside Redis SCAN MATCH patterns. */
export function certificateVersionKey(objectVersion: string): string {
  return createHash("sha256").update(objectVersion).digest("hex")
}

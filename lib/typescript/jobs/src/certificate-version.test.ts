import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { certificateVersionKey } from "./certificate-version"

type Fixture = { vectors: { version: string; sha256: string }[] }
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../services/router/fixtures/certificate-version-key.json", import.meta.url),
    "utf8",
  ),
) as Fixture

describe("certificate VersionId Redis keys", () => {
  it("matches the Rust producer for opaque S3 VersionIds", () => {
    for (const vector of fixture.vectors) {
      expect(certificateVersionKey(vector.version)).toBe(vector.sha256)
    }
  })
})

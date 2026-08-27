import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { mintProjectToken } from "./project-token"

/**
 * The same file `services/router/src/log_token.rs` reads.
 *
 * A fixture only proves two implementations agree if neither can change it alone. Pointing both at
 * one file on disk is what makes this a seam test rather than two independent assertions that
 * happen to pass today.
 */
const fixtures = JSON.parse(
  readFileSync(join(__dirname, "../../../../services/router/fixtures/log-token.json"), "utf8"),
) as {
  secret: string
  valid: { projectId: string; organizationId: string; expiresAt: number; token: string }
}

describe("mintProjectToken", () => {
  it("produces the token the Rust verifier is tested against", () => {
    const { projectId, organizationId, expiresAt, token } = fixtures.valid
    expect(mintProjectToken(projectId, organizationId, expiresAt, fixtures.secret)).toBe(token)
  })

  it("binds the project, so swapping it invalidates the signature", () => {
    const { organizationId, expiresAt } = fixtures.valid
    const other = mintProjectToken(
      "01a03b00-0000-7000-8000-00000000dead",
      organizationId,
      expiresAt,
      fixtures.secret,
    )

    // Same expiry, same secret, different project — and therefore a different signature. This is
    // the property the whole scheme rests on: a token cannot be edited into another tenant's.
    expect(other).not.toBe(fixtures.valid.token)
    expect(other.split(".")[3]).not.toBe(fixtures.valid.token.split(".")[3])
  })

  it("binds the organization, so the extension cannot choose who pays", () => {
    const { projectId, expiresAt } = fixtures.valid
    expect(
      mintProjectToken(
        projectId,
        "01912d3f-8a2b-7c4d-9e1f-2a3b4c5ddead",
        expiresAt,
        fixtures.secret,
      ),
    ).not.toBe(fixtures.valid.token)
  })

  it("binds the expiry too", () => {
    const { projectId, organizationId, expiresAt } = fixtures.valid
    expect(mintProjectToken(projectId, organizationId, expiresAt + 1, fixtures.secret)).not.toBe(
      fixtures.valid.token,
    )
  })
})

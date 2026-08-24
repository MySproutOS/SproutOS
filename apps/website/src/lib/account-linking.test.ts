import { describe, expect, it } from "vitest"
import { mayLinkByEmail } from "./account-linking"

describe("mayLinkByEmail", () => {
  /*
    Adopting an existing user by email means inheriting their organizations, projects and credits.
    Every case below is about who is allowed to do that.
  */
  it("links a verified address", () => {
    expect(mayLinkByEmail({ email: "person@example.com", emailVerified: true })).toBe(true)
  })

  it("refuses an unverified address", () => {
    // The takeover: register with a provider claiming somebody else's email, sign in, inherit their
    // account. Google reports `email_verified` false for some Workspace and federated setups, so
    // this is a branch that happens.
    expect(mayLinkByEmail({ email: "victim@example.com", emailVerified: false })).toBe(false)
  })

  it("refuses an empty or absent address even when the provider calls it verified", () => {
    // An empty string matches nothing useful, and would match a row written by some future path
    // that also stored one.
    expect(mayLinkByEmail({ email: "", emailVerified: true })).toBe(false)
    expect(mayLinkByEmail({ email: null, emailVerified: true })).toBe(false)
    expect(mayLinkByEmail({ email: undefined, emailVerified: true })).toBe(false)
  })

  it("refuses something that is not an address", () => {
    expect(mayLinkByEmail({ email: "not-an-email", emailVerified: true })).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import {
  SIGN_IN_METHODS_ROUTE_PATH,
  signInMethodPresentation,
} from "./orgs.$orgSlug.settings.sign-in-methods"

describe("Sign-in methods settings route", () => {
  it("defines the distinct organization-shell path", () => {
    expect(SIGN_IN_METHODS_ROUTE_PATH).toBe("/orgs/$orgSlug/settings/sign-in-methods")
  })

  it("presents GitHub reauthorization without exposing credential fields", () => {
    const presentation = signInMethodPresentation({
      id: "method-id",
      provider: "github",
      displayIdentity: "safe-handle",
      connectedAt: new Date("2026-09-03T12:00:00Z"),
      repositoryAccessNeedsReauthorization: true,
      canUnlink: true,
    })
    expect(presentation).toMatchObject({
      displayIdentity: "safe-handle",
      status: "Repository access needs reauthorization",
      canUnlink: true,
    })
    expect(Object.keys(presentation)).not.toContain("providerAccountId")
    expect(JSON.stringify(presentation)).not.toContain("token")
  })

  it("disables unlink for the final usable method", () => {
    expect(
      signInMethodPresentation({
        id: "method-id",
        provider: "google",
        displayIdentity: "person@example.test",
        connectedAt: new Date("2026-09-03T12:00:00Z"),
        repositoryAccessNeedsReauthorization: false,
        canUnlink: false,
      }).canUnlink,
    ).toBe(false)
  })
})

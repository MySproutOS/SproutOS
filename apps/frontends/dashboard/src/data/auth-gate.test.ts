import { describe, expect, it } from "vitest"
import { authGateState } from "./auth-gate"

describe("the dashboard session gate", () => {
  it("does not turn an API failure into a login redirect", () => {
    expect(authGateState({ loading: false, failed: true, user: undefined })).toBe("failed")
  })

  it("redirects only after a successful response says there is no user", () => {
    expect(authGateState({ loading: false, failed: false, user: null })).toBe("unauthenticated")
    expect(authGateState({ loading: false, failed: false, user: { id: "user" } })).toBe(
      "authenticated",
    )
  })

  it("waits for the query before drawing a conclusion", () => {
    expect(authGateState({ loading: true, failed: false, user: undefined })).toBe("loading")
  })
})

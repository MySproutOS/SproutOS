import { describe, expect, it } from "vitest"
import app from "../index"

describe("optional bearer authentication", () => {
  it("keeps an absent credential anonymous", async () => {
    const response = await app.request("/v1/auth/me")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: null,
      organization: null,
      authentication: null,
    })
  })

  it("refuses a supplied malformed credential instead of treating it as anonymous", async () => {
    const response = await app.request("/v1/auth/me", {
      headers: { Authorization: "Basic definitely-not-a-bearer" },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"')
  })
})

import { describe, expect, it } from "vitest"
import app from "./sproutos-skill"

describe("the public SproutOS skill", () => {
  it("serves the canonical local-agent instructions as markdown", async () => {
    const response = await app.request("/")
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/markdown")
    expect(body).toContain("MySproutOS/sproutos-deploy-action@v1")
    expect(body).toContain("AGENTS.md-based CLI")
    expect(body).not.toContain("Where you are right now")
  })
})

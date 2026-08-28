import { describe, expect, it } from "vitest"
import app from "./sproutos-skill"

describe("the public SproutOS skill", () => {
  it("serves the canonical local-agent instructions as markdown", async () => {
    const response = await app.request("/")
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/markdown")
    expect(body).toContain("MySproutOS/sproutos-deploy-action@v1")
    expect(body).toContain("sprout deploy <your-project-slug>")
    expect(body).toContain("MySproutOS/Deployment-Templates")
    expect(body).toContain("~/.codex/skills/sproutos/SKILL.md")
    expect(body).toContain("sandbox or model usage")
    expect(body).not.toContain("SPROUT_OS_DEPLOY")
    expect(body).not.toContain("SproutOS-Apps")
    expect(body).not.toContain("Where you are right now")
  })
})

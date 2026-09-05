import { describe, expect, it } from "vitest"
import app from "./sproutos-skill"

describe("the public SproutOS skill", () => {
  it("serves the canonical local-agent instructions as markdown", async () => {
    const response = await app.request("/")
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/markdown")
    expect(body).toContain(
      "MySproutOS/sproutos-deploy-action@25101dae5786e419cc672da44ed7a788342185da",
    )
    expect(body).toContain("sproutos.me/install.sh")
    expect(body).toContain("91c10f3e1fa540896eab858e6031b1ae18640e36")
    expect(body).not.toContain("sproutos-deploy-action@v1")
    expect(body).toContain("sprout deploy <your-project-slug>")
    expect(body).toContain("MySproutOS/Deployment-Templates")
    expect(body).toContain(".agents/skills/sproutos/SKILL.md")
    expect(body).toContain("~/.agents/skills/sproutos/SKILL.md")
    expect(body).not.toContain("~/.codex/skills/sproutos/SKILL.md")
    expect(body).toContain("sandbox or model usage")
    expect(body).not.toContain("SPROUT_OS_DEPLOY")
    expect(body).not.toContain("SproutOS-Apps")
    expect(body).not.toContain("Where you are right now")
  })
})

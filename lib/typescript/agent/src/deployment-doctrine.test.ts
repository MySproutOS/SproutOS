import { describe, expect, it } from "vitest"
import { DEPLOYMENT_DOCTRINE } from "./deployment-doctrine"

/*
  The agent ran with no system prompt beyond the SDK preset, so on a new project it behaved like
  Claude Code in a directory — helpful, and with no idea the repository was going to be hosted.
  Asked to set a project up it would edit code and stop.

  These assert the instruction still says the six things, because the expensive failure is a
  *partial* deployment: a project with a workflow and no migration path deploys happily and
  corrupts on the first schema change. Losing one bullet to an edit would read as a smaller prompt,
  not as a broken product.
*/
describe("DEPLOYMENT_DOCTRINE", () => {
  it.each([
    ["workflows", /workflows?/i],
    ["website", /website/i],
    ["static assets", /static assets/i],
    ["media asset upload", /media asset upload/i],
    ["databases", /databases/i],
    ["customer-owned migrations on push", /customer-owned database migrations on push/i],
  ])("names %s", (_label, pattern) => {
    expect(DEPLOYMENT_DOCTRINE).toMatch(pattern)
  })

  it("still enumerates exactly six numbered steps", () => {
    const numbered = DEPLOYMENT_DOCTRINE.split("\n").filter((line) => /^\d+\.\s/.test(line))
    expect(numbered).toHaveLength(6)
  })

  /*
    The opening line is load-bearing: it is what the person sees first and what tells them the
    agent understood the request as "deploy this", not "chat about this".
  */
  it("opens a setup by saying it is creating a deployment", () => {
    expect(DEPLOYMENT_DOCTRINE).toContain('"Let me create a deployment"')
  })

  /*
    Silence is the one outcome that must never look like success. A skipped step said out loud is
    a decision; a skipped step said nothing about is a bug nobody finds until it matters.
  */
  it("forbids reporting a step as done when it is not", () => {
    expect(DEPLOYMENT_DOCTRINE).toMatch(/do not report a step as done when it is not/i)
    expect(DEPLOYMENT_DOCTRINE).toMatch(/rather than skipping it silently/i)
  })

  it("makes the GitHub Actions migration gate explicit", () => {
    expect(DEPLOYMENT_DOCTRINE).toContain("dedicated migrator project")
    expect(DEPLOYMENT_DOCTRINE).toContain("application deploy wait")
    expect(DEPLOYMENT_DOCTRINE).toContain("does not discover migrations automatically")
  })
})

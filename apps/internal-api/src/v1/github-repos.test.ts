import { describe, expect, it } from "vitest"
import { repositoryNameProblem } from "./github-repos"

/**
 * The rules GitHub enforces, checked before the round trip rather than after the create.
 *
 * A repository is created inside a `project_job`, so GitHub's own complaint about a trailing dot
 * would reach the customer as a failed provision some minutes later, with the name long gone from
 * the form. These are the same rules, applied while it can still be corrected.
 */
describe("repositoryNameProblem", () => {
  it.each(["toyourcredit", "my-app", "my_app", "app.v2", "A1", "x"])("accepts %s", (name) => {
    expect(repositoryNameProblem(name)).toBeNull()
  })

  it.each([
    ["a space", "my app"],
    ["a slash", "owner/repo"],
    ["a colon", "my:app"],
    ["an emoji", "app🎉"],
    ["an accent", "café"],
  ])("refuses %s", (_label, name) => {
    expect(repositoryNameProblem(name)).toMatch(/letters, numbers/)
  })

  /*
    The three GitHub rejects for reasons that are not about the character set. Each returns its own
    sentence: "that name will not work" sends somebody hunting, and naming the rule does not.
  */
  it("refuses the directory names", () => {
    expect(repositoryNameProblem(".")).toMatch(/cannot be named \. or \.\./)
    expect(repositoryNameProblem("..")).toMatch(/cannot be named \. or \.\./)
  })

  it("refuses a .git suffix", () => {
    expect(repositoryNameProblem("thing.git")).toMatch(/cannot end in \.git/)
  })

  it("refuses a trailing dot", () => {
    expect(repositoryNameProblem("thing.")).toMatch(/cannot end in a dot/)
  })

  it("gives a different reason for each kind of problem", () => {
    // A single message for every failure is the thing this function exists to avoid.
    const reasons = new Set(
      ["..", "thing.git", "thing.", "my app"].map((name) => repositoryNameProblem(name)),
    )
    expect(reasons.size).toBe(4)
  })
})

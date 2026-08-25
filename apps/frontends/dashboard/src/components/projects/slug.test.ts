import { describe, expect, it } from "vitest"
import { slugify } from "./slug"

/**
 * The project name, as a repository name.
 *
 * It has to land inside what GitHub accepts, because the suggestion is pre-filled and most people
 * will not edit it — a default that produces an invalid name is worse than no default, since the
 * failure arrives from the provision job minutes later.
 */
const VALID = /^[A-Za-z0-9._-]+$/

describe("slugify", () => {
  it.each([
    ["ToYourCredit", "toyourcredit"],
    ["To Your Credit", "to-your-credit"],
    ["My App v2", "my-app-v2"],
    ["already-fine", "already-fine"],
  ])("%s becomes %s", (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })

  it("never emits a leading or trailing hyphen", () => {
    // GitHub accepts them, but `-thing-` reads as a mistake and comes from punctuation the person
    // did not think of as part of the name.
    expect(slugify("  spaced  ")).toBe("spaced")
    expect(slugify("!!bang!!")).toBe("bang")
  })

  it.each(["Café ☕", "owner/repo", "a:b", "emoji 🎉 name", "...", "a  b"])(
    "produces something GitHub accepts from %s",
    (input) => {
      const out = slugify(input)
      // Either a valid name, or empty — which the form treats as "you have to type one".
      expect(out === "" || VALID.test(out)).toBe(true)
      expect(out.startsWith("-")).toBe(false)
      expect(out.endsWith("-")).toBe(false)
    },
  )

  it("stays within GitHub's length limit", () => {
    expect(slugify("x".repeat(400))).toHaveLength(100)
  })
})

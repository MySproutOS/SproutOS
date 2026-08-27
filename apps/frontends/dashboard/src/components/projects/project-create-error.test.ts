import { describe, expect, it } from "vitest"
import { projectCreateErrorMessage } from "./project-create-error"

describe("projectCreateErrorMessage", () => {
  it("shows the structured API message", () => {
    expect(
      projectCreateErrorMessage({
        error: { code: "ResourceAlreadyExists", message: "That directory is already deployed." },
      }),
    ).toBe("That directory is already deployed.")
  })

  it("keeps transport errors useful", () => {
    expect(projectCreateErrorMessage(new Error("The API could not be reached."))).toBe(
      "The API could not be reached.",
    )
  })

  it("falls back for an unknown error shape", () => {
    expect(projectCreateErrorMessage({ status: 500 })).toBe(
      "The project could not be created. Nothing was changed on GitHub.",
    )
  })
})

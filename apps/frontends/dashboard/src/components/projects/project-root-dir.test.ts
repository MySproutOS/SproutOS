import { describe, expect, it } from "vitest"
import { isProjectRootDir } from "./project-root-dir"

describe("project root directory", () => {
  it.each([".", "apps/website", "apps/frontends/admin", "packages/api-v2"])(
    "accepts %s",
    (path) => {
      expect(isProjectRootDir(path)).toBe(true)
    },
  )

  it.each([
    "",
    "/apps/admin",
    "apps/admin/",
    "apps//admin",
    "apps/./admin",
    "../admin",
    "apps/../admin",
    "apps\\admin",
  ])("refuses %s", (path) => {
    expect(isProjectRootDir(path)).toBe(false)
  })
})

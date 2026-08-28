import { describe, expect, it, vi } from "vitest"
import { NeonApiError } from "./neon-api"
import { deleteNeonProject } from "./neon-postgres"

describe("Neon project deletion", () => {
  it("treats an already-absent project as a successful retry", async () => {
    const deleteProject = vi.fn<() => Promise<void>>(() =>
      Promise.reject(new NeonApiError(404, "/projects/provider-id", "not found")),
    )

    await expect(deleteNeonProject({ deleteProject }, "provider-id")).resolves.toBeUndefined()
    expect(deleteProject).toHaveBeenCalledWith("provider-id")
  })

  it("propagates provider failures instead of orphaning a billable project", async () => {
    const deleteProject = vi.fn<() => Promise<void>>(() =>
      Promise.reject(new NeonApiError(503, "/projects/provider-id", "unavailable")),
    )

    await expect(deleteNeonProject({ deleteProject }, "provider-id")).rejects.toThrow(/503/)
  })
})

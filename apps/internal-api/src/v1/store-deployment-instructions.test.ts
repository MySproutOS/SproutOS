import { describe, expect, it, vi } from "vitest"
import { findDeploymentInstructions, verifyDeploymentMirror } from "@lib/github"

describe("store deployment instructions", () => {
  it("accepts the root marker first", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("# Deploy", { status: 200 })),
    )
    await expect(
      findDeploymentInstructions(
        { owner: "SproutOS-Apps", repo: "twenty", branch: "main" },
        fetcher,
      ),
    ).resolves.toBe("SPROUT_OS_DEPLOY.md")
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("falls back to the marker under .config", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("# Deploy", { status: 200 }))
    await expect(
      findDeploymentInstructions(
        { owner: "SproutOS-Apps", repo: "twenty", branch: "main" },
        fetcher,
      ),
    ).resolves.toBe(".config/SPROUT_OS_DEPLOY.md")
  })

  it("rejects non-mirror repositories and empty marker files", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response("", { status: 200 })))
    await expect(
      findDeploymentInstructions({ owner: "twentyhq", repo: "twenty", branch: "main" }, fetcher),
    ).resolves.toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    await expect(
      findDeploymentInstructions(
        { owner: "SproutOS-Apps", repo: "twenty", branch: "main" },
        fetcher,
      ),
    ).resolves.toBeNull()
  })

  it("accepts a mirror whose only source difference is the deployment marker", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          behind_by: 0,
          files: [{ filename: "SPROUT_OS_DEPLOY.md", status: "added" }],
        }),
      )
      .mockResolvedValueOnce(new Response("# Deploy", { status: 200 }))

    await expect(
      verifyDeploymentMirror(
        {
          upstreamOwner: "twentyhq",
          mirrorOwner: "SproutOS-Apps",
          repo: "twenty",
          branch: "main",
        },
        fetcher,
      ),
    ).resolves.toBe("SPROUT_OS_DEPLOY.md")
  })

  it("rejects a mirror with another source change or missing upstream commits", async () => {
    const changed = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        behind_by: 0,
        files: [
          { filename: "SPROUT_OS_DEPLOY.md", status: "added" },
          { filename: "src/app.ts", status: "modified" },
        ],
      }),
    )
    await expect(
      verifyDeploymentMirror(
        {
          upstreamOwner: "twentyhq",
          mirrorOwner: "SproutOS-Apps",
          repo: "twenty",
          branch: "main",
        },
        changed,
      ),
    ).resolves.toBeNull()

    const behind = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        behind_by: 1,
        files: [{ filename: "SPROUT_OS_DEPLOY.md", status: "added" }],
      }),
    )
    await expect(
      verifyDeploymentMirror(
        {
          upstreamOwner: "twentyhq",
          mirrorOwner: "SproutOS-Apps",
          repo: "twenty",
          branch: "main",
        },
        behind,
      ),
    ).resolves.toBeNull()
  })
})

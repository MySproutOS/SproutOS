import { sandboxForwardProxyAuthorizationSignature } from "@lib/sandbox/daytona"
import { beforeEach, describe, expect, it, vi } from "vitest"

type AuthorizationRow = {
  id: string
  projectId: string
  organizationId: string
  state: string
}

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn<(id: string) => Promise<AuthorizationRow | undefined>>(),
}))

vi.mock("@lib/dao", () => ({
  fetchSandbox: () => ({ forForwardProxyAuthorization: lookup }),
}))
vi.mock("@sproutos/db", () => ({ db: {} }))

const { default: app } = await import("./daytona-proxy")

const ROOT_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
const SANDBOX_ID = "01930000-0000-7000-8000-000000000001"

function signature(): string {
  return sandboxForwardProxyAuthorizationSignature(ROOT_KEY, SANDBOX_ID)
}

beforeEach(() => {
  process.env.SANDBOX_FORWARD_PROXY_ROOT_KEY = ROOT_KEY
  lookup.mockReset()
})

describe("standalone Daytona proxy authorization", () => {
  it("returns attribution for a signed live sandbox", async () => {
    lookup.mockResolvedValue({
      id: SANDBOX_ID,
      projectId: "01930000-0000-7000-8000-000000000002",
      organizationId: "01930000-0000-7000-8000-000000000003",
      state: "running",
    })
    const response = await app.request(`/authorize/${SANDBOX_ID}`, {
      headers: { "x-daytona-proxy-signature": signature() },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sandboxId: SANDBOX_ID, state: "running" })
  })

  it("does not reveal a sandbox to an invalid signature", async () => {
    const response = await app.request(`/authorize/${SANDBOX_ID}`, {
      headers: { "x-daytona-proxy-signature": "wrong" },
    })
    expect(response.status).toBe(401)
    expect(lookup).not.toHaveBeenCalled()
  })

  it("revokes a stopped sandbox", async () => {
    lookup.mockResolvedValue({
      id: SANDBOX_ID,
      projectId: "01930000-0000-7000-8000-000000000002",
      organizationId: "01930000-0000-7000-8000-000000000003",
      state: "stopped",
    })
    const response = await app.request(`/authorize/${SANDBOX_ID}`, {
      headers: { "x-daytona-proxy-signature": signature() },
    })
    expect(response.status).toBe(401)
  })
})

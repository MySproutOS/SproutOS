import { afterEach, describe, expect, it, vi } from "vitest"
import { searchAdminRequest } from "./search"

describe("OpenSearch Security admin retries", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("retries a transient PUT version conflict with the identical document", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("version conflict", { status: 409 }))
      .mockResolvedValueOnce(new Response("version conflict", { status: 409 }))
      .mockResolvedValueOnce(new Response('{"status":"OK"}', { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const payload = { backend_roles: ["tenant_role"] }

    await expect(
      searchAdminRequest(
        { url: "http://search.invalid" },
        "PUT",
        "/_plugins/_security/api/internalusers/tenant",
        payload,
      ),
    ).resolves.toEqual({ status: "OK" })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.map((call) => call[1]?.body)).toEqual([
      JSON.stringify(payload),
      JSON.stringify(payload),
      JSON.stringify(payload),
    ])
  })

  it("does not retry a permanent refusal", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("forbidden", { status: 403 }))
    vi.stubGlobal("fetch", fetch)

    await expect(
      searchAdminRequest(
        { url: "http://search.invalid" },
        "PUT",
        "/_plugins/_security/api/roles/tenant",
        {},
      ),
    ).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("retries a transient Security DELETE conflict", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("version conflict", { status: 409 }))
      .mockResolvedValueOnce(new Response('{"status":"OK"}', { status: 200 }))
    vi.stubGlobal("fetch", fetch)

    await expect(
      searchAdminRequest(
        { url: "http://search.invalid" },
        "DELETE",
        "/_plugins/_security/api/internalusers/tenant",
      ),
    ).resolves.toEqual({ status: "OK" })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("does not retry an index DELETE conflict", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("index conflict", { status: 409 }))
    vi.stubGlobal("fetch", fetch)

    await expect(
      searchAdminRequest({ url: "http://search.invalid" }, "DELETE", "/tenant_documents"),
    ).rejects.toMatchObject({ status: 409 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("stops after three conflict retries", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(new Response("version conflict", { status: 409 })))
    vi.stubGlobal("fetch", fetch)

    await expect(
      searchAdminRequest(
        { url: "http://search.invalid" },
        "PUT",
        "/_plugins/_security/api/roles/tenant",
        {},
      ),
    ).rejects.toMatchObject({ status: 409 })
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
